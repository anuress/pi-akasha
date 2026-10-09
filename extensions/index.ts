/**
 * pi-akasha — connects pi to akasha, a local knowledge base for coding agents.
 *
 * - MCP: registers `akasha serve` so pi gets the knowledge_* tools natively.
 * - session_start: runs `akasha hook session-start --defer-refresh`, holds the brief and
 *   injects it once, on the first prompt (session_start has no way to add context).
 * - tool_result: after every write/edit and every akasha recording tool, runs
 *   `akasha hook post-tool` with the session id. akasha reindexes a written .md file and,
 *   after a run of edits with nothing recorded, replies with a nudge that is appended to
 *   the tool result the model sees.
 *
 * Everything is fail-open: a missing or failing akasha never blocks pi.
 */
import { spawn } from "node:child_process";

const TIMEOUT_MS = 15_000;
const WRITE_TOOLS = new Set(["write", "edit"]);
const RECORDING = /^mcp__akasha__knowledge_(write|append|update)$/;

function runAkasha(args: string[], stdin = ""): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    // argv array, never a shell string. AbortSignal.timeout is unref'd, so it never delays exit.
    const child = spawn("akasha", args, { signal: AbortSignal.timeout(TIMEOUT_MS), stdio: ["pipe", "pipe", "ignore"] });
    child.stdout.on("data", (d) => (out += d));
    // ENOENT fires "error" and never "close": resolve here or the await hangs.
    child.on("error", () => resolve(""));
    child.on("close", (code) => resolve(code === 0 ? out : ""));
    // The hook reads stdin to EOF; end the pipe or both sides wait out the timeout.
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

export default function piAkasha(pi: any) {
  try {
    // Direct exposure: the brief tells the model to search first, so the tools must be
    // declared to it, not left behind codemode scripts. The set is small.
    pi.registerMcpServer("akasha", {
      command: "akasha",
      args: ["serve"],
      exposure: "direct",
      description: "Local knowledge base: search before investigating, record findings unprompted.",
    });
  } catch {
    // An mcp.json entry of the same name wins; any other failure must not stop pi loading.
  }

  let held = "";

  pi.on("session_start", async () => {
    try {
      held = (await runAkasha(["hook", "session-start", "--defer-refresh"])).trim();
    } catch {
      held = "";
    }
  });

  pi.on("before_agent_start", async () => {
    const text = held;
    held = "";
    if (!text) return undefined;
    return { message: { customType: "akasha", content: text, display: true } };
  });

  pi.on("tool_result", async (event: any, ctx: any) => {
    try {
      const name = event?.toolName;
      if (!WRITE_TOOLS.has(name) && !RECORDING.test(name ?? "")) return undefined;
      // pi's `path` is one of the keys akasha's payload parser reads (tool_input.path).
      const out = await runAkasha(
        ["hook", "post-tool"],
        JSON.stringify({
          session_id: ctx?.sessionManager?.getSessionId?.(),
          tool_name: name,
          tool_input: event.input,
        }),
      );
      const nudge = out.trim() ? JSON.parse(out)?.hookSpecificOutput?.additionalContext : undefined;
      if (typeof nudge !== "string" || !nudge) return undefined;
      // A returned content replaces the result, so the original goes first.
      return { content: [...(event.content ?? []), { type: "text", text: nudge }] };
    } catch {
      // fail-open
    }
  });
}
