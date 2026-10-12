import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piAkasha from "../extensions/index.ts";

// A fake `akasha` on PATH: logs argv and stdin, prints BRIEF, exits with FAKE_EXIT.
function setup(exit = 0) {
  const dir = mkdtempSync(join(tmpdir(), "pi-akasha-"));
  const log = join(dir, "calls.jsonl");
  const bin = join(dir, "akasha");
  writeFileSync(bin, `#!/bin/sh
printf '{"argv":"%s","stdin":' "$*" >> "${log}"
cat | node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0,"utf8")))' >> "${log}"
printf '}\\n' >> "${log}"
echo "brief text"
exit ${exit}
`);
  chmodSync(bin, 0o755);
  process.env.PATH = `${dir}:${process.env.PATH}`;
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { calls };
}

function fakePi() {
  const handlers: Record<string, Function> = {};
  const mcp: any[] = [];
  return {
    handlers, mcp,
    on: (n: string, h: Function) => (handlers[n] = h),
    registerMcpServer: (...a: any[]) => mcp.push(a),
  };
}

test("registers the akasha MCP server over stdio", () => {
  const pi = fakePi();
  piAkasha(pi);
  assert.equal(pi.mcp.length, 1);
  const [name, config] = pi.mcp[0];
  assert.equal(name, "akasha");
  assert.equal(config.command, "akasha");
  assert.deepEqual(config.args, ["serve"]);
});

test("declares akasha's tools directly to the model", () => {
  // The brief tells the model to call knowledge_search first; pi's default exposure would
  // hide the tool behind codemode scripts, so the model could not follow it.
  const pi = fakePi();
  piAkasha(pi);
  const [, config] = pi.mcp[0];
  assert.equal(config.exposure, "direct");
  assert.equal(typeof config.description, "string");
});

test("brief is held at session_start and injected exactly once", async () => {
  const { calls } = setup();
  const pi = fakePi();
  piAkasha(pi);
  await pi.handlers.session_start();
  assert.equal(calls()[0].argv, "hook session-start --defer-refresh");
  const first = await pi.handlers.before_agent_start();
  assert.deepEqual(first, { message: { customType: "akasha", content: "brief text", display: true } });
  assert.equal(await pi.handlers.before_agent_start(), undefined);
});

test("post-tool gets the tool_name/tool_input payload for a written .md file", async () => {
  const { calls } = setup();
  const pi = fakePi();
  piAkasha(pi);
  const input = { path: "/x/notes.md", content: "hi" };
  await pi.handlers.tool_result({ toolName: "write", input });
  const [c] = calls();
  assert.equal(c.argv, "hook post-tool");
  assert.deepEqual(JSON.parse(c.stdin), { tool_name: "write", tool_input: input });
});

test("tools that neither edit nor record never spawn akasha", async () => {
  // A process per read or bash call would cost more than the hook is worth.
  const { calls } = setup();
  const pi = fakePi();
  piAkasha(pi);
  await pi.handlers.tool_result({ toolName: "read", input: { path: "/x/a.md" } });
  await pi.handlers.tool_result({ toolName: "bash", input: { command: "ls" } });
  await pi.handlers.tool_result({ toolName: "mcp__akasha__knowledge_search", input: {} });
  assert.deepEqual(calls(), []);
});

const ctx = { sessionManager: { getSessionId: () => "sess-1" } };

test("every edit reaches post-tool with the session id, so akasha can count edits", async () => {
  const { calls } = setup();
  const pi = fakePi();
  piAkasha(pi);
  await pi.handlers.tool_result({ toolName: "edit", input: { path: "/x/a.ts" } }, ctx);
  const [c] = calls();
  assert.equal(c.argv, "hook post-tool");
  assert.deepEqual(JSON.parse(c.stdin),
    { session_id: "sess-1", tool_name: "edit", tool_input: { path: "/x/a.ts" } });
});

test("post-tool is told the session cwd, so akasha can find the file's gotchas", async () => {
  const { calls } = setup();
  const pi = fakePi();
  piAkasha(pi);
  await pi.handlers.tool_result({ toolName: "write", input: { path: "a.kt" } }, { ...ctx, cwd: "/work" });
  assert.equal(JSON.parse(calls()[0].stdin).cwd, "/work");
});

test("akasha's recording tools reach post-tool, so the edit count restarts", async () => {
  const { calls } = setup();
  const pi = fakePi();
  piAkasha(pi);
  for (const name of ["write", "append", "update"]) {
    await pi.handlers.tool_result({ toolName: `mcp__akasha__knowledge_${name}`, input: {} }, ctx);
  }
  assert.deepEqual(calls().map((c) => JSON.parse(c.stdin).tool_name), [
    "mcp__akasha__knowledge_write", "mcp__akasha__knowledge_append",
    "mcp__akasha__knowledge_update"]);
});

test("a nudge from post-tool is appended to the tool result the model sees", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-akasha-"));
  const bin = join(dir, "akasha");
  writeFileSync(bin, `#!/bin/sh
cat >/dev/null
echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"akasha: record it"}}'
`);
  chmodSync(bin, 0o755);
  process.env.PATH = `${dir}:${process.env.PATH}`;
  const pi = fakePi();
  piAkasha(pi);
  const original = [{ type: "text", text: "edited" }];
  const out = await pi.handlers.tool_result(
    { toolName: "edit", input: { path: "/x/a.ts" }, content: original }, ctx);
  assert.deepEqual(out, { content: [...original, { type: "text", text: "akasha: record it" }] });
});

test("post-tool output that is not a nudge leaves the tool result alone", async () => {
  setup();  // prints "brief text", which is not hook JSON
  const pi = fakePi();
  piAkasha(pi);
  const out = await pi.handlers.tool_result(
    { toolName: "edit", input: { path: "/x/a.ts" }, content: [] }, ctx);
  assert.equal(out, undefined);
});

test("missing akasha (ENOENT) is fail-open", async () => {
  process.env.PATH = "/nonexistent";
  const pi = fakePi();
  piAkasha(pi);
  await pi.handlers.session_start();
  assert.equal(await pi.handlers.before_agent_start(), undefined);
  await pi.handlers.tool_result({ toolName: "edit", input: { path: "/x/a.md" } });
});

test("non-zero exit drops the brief and does not throw", async () => {
  setup(3);
  const pi = fakePi();
  piAkasha(pi);
  await pi.handlers.session_start();
  assert.equal(await pi.handlers.before_agent_start(), undefined);
  await pi.handlers.tool_result({ toolName: "write", input: { path: "/x/a.md" } });
});
