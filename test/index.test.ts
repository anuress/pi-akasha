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

test("non-.md paths and non-write tools never spawn akasha", async () => {
  const { calls } = setup();
  const pi = fakePi();
  piAkasha(pi);
  await pi.handlers.tool_result({ toolName: "write", input: { path: "/x/a.ts" } });
  await pi.handlers.tool_result({ toolName: "read", input: { path: "/x/a.md" } });
  await pi.handlers.tool_result({ toolName: "edit", input: {} });
  assert.deepEqual(calls(), []);
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
