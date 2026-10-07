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
  Destructive operations are not exposed over MCP; they stay on the akasha CLI. An
  `akasha` entry in `~/.pi/agent/mcp.json` takes precedence over this registration.
- **Session brief.** At session start the extension runs
  `akasha hook session-start --defer-refresh` and injects its output once, as an `akasha`
  message on the first prompt.
- **Reindexing.** After pi's `write` or `edit` tool changes a `.md` file, the extension runs
  `akasha hook post-tool` so the file is reindexed if it lives under an index root.

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
