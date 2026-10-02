# OpenCode Status Panel

A right-hand sidebar status panel plugin for [OpenCode](https://opencode.ai).

It renders, per session:

- **dir** — current directory (basename)
- **git** — current branch, with a `✱` when the working tree is dirty
- **model** — active model id (and variant, if any)
- **ctx** — context-window usage as a percentage
- **tokens** — total input + output tokens for the session
- **cost** — session cost in USD

…followed by a provider usage section that mirrors the `~/.claude` statusline:

| Meter | Source |
|-------|--------|
| **Claude** / **Fable** | login state via the macOS keychain |
| **Codex** | `rollout-*.jsonl` files under `~/.codex/sessions` |
| **Agy** | placeholder (needs the agy language-server RPC) |
| **Go** (OpenCode) | OpenCode's console status endpoint (`/console/api/go/status`), reporting `% left` for the rolling 5h / weekly / monthly windows |
| **GLM** (Z.ai) | cached fetch of the z.ai quota endpoint |

And finally the connected **MCP** servers.

## Why the Go meter reads the server, not the local DB

OpenCode Go plan usage is metered **server-side** in microcents against three
dollar windows ($12 / 5h, $30 / week, $60 / month). The local
`session_v2.cost` column is only a per-session estimate recorded by the local
machine, and it diverges from the authoritative server accounting (peak /
off-peak pricing, cache reads, all org usage). So this plugin reads the
console's own status endpoint, authenticated with the OAuth credential stored
in OpenCode's local database.

## Install

Copy this folder into your OpenCode plugins directory:

```sh
mkdir -p ~/.config/opencode/plugins
cp -r opencode-status-panel ~/.config/opencode/plugins/sidebar-status
```

Then restart the OpenCode TUI.

## Files

- `package.json` — plugin manifest; exposes the `./tui` entrypoint.
- `tui.ts` — convention-based shim that re-exports `tui.tsx`.
- `tui.tsx` — the sidebar UI (Solid JSX).
- `usage.ts` — the usage meters (disk / network work, no JSX).

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `OPENCODE_DB` | `~/.local/share/opencode/opencode.db` | Path to the OpenCode SQLite DB (for the Go credential). |

The refresh loop runs every 30 seconds; the GLM meter is additionally cached
for 60 seconds.
