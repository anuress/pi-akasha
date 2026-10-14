# pi-akasha

Connects [pi](https://github.com/earendil-works/pi) to [akasha](https://github.com/anuress/akasha),
a local knowledge base for coding agents.

## Requirements

akasha installed and initialised:

```bash
uv tool install --python 3.12 'akasha-mcp[vectors]'
akasha init
```

## Install

```bash
pi install git:github.com/anuress/pi-akasha   # personal
pi install ./pi-akasha --local                # project, from a checkout
```

Or try it for one run without installing: `pi -e ./pi-akasha/extensions/index.ts`.

## What pi gets

- **Tools.** pi supports MCP natively, so the extension registers `akasha serve` as the
  `akasha` MCP server (`mcp__akasha__knowledge_search`, `..._get`, `..._write`, ...).
  The tools use `direct` exposure, so the model sees them like built-in tools rather than
  only through codemode scripts; the set is small. Destructive operations are not exposed
  over MCP; they stay on the akasha CLI. An `akasha` entry in `~/.pi/agent/mcp.json` takes
  precedence over this registration, which is also how to change the exposure.
- **Session brief.** At session start and after each successful compaction, the extension
  runs `akasha hook session-start --defer-refresh` and injects its output as an `akasha`
  message on the next prompt.
- **Reindexing and the write nudge.** After every `write` or `edit`, and every akasha
  recording tool, the extension runs `akasha hook post-tool` with the session id. A
  changed `.md` file is reindexed if it lives under an index root. After a run of edits
  with nothing recorded, akasha replies with a one-time reminder, which is appended to
  the tool result the model sees. Needs akasha 0.0.3 or later; older versions only
  reindex.

## Fail-open

The hooks never block pi. If `akasha` is missing, exits non-zero, or takes longer than
15 seconds, the hook is skipped silently and pi carries on. If `akasha` is not installed,
pi reports the MCP server as failed to connect, once.

## Development

```bash
npm test   # node's built-in runner, with a fake akasha on PATH
```

## License

MIT
