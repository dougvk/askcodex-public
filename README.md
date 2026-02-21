# @dougvk/askcodex

OpenClaw plugin that runs one Codex PTY runtime per chat session and delivers completed responses back to chat.

## Commands

- `/askcodex help`
- `/askcodex status`
- `/askcodex new [abs path]`
- `/askcodex <prompt>`
- `/askcodex stop`
- `/askcodex reset`
- `/askcodex handoff`
- `/askcodex resume`

## Command Behavior

- `/askcodex help`: shows command usage for this plugin.
- `/askcodex status`: returns a single PTY-oriented status view.
- `/askcodex new [abs path]`: archives prior session state and starts a fresh Codex session.
- `/askcodex <prompt>`: sends a prompt to the active Codex PTY; if a turn is already running, it returns a busy error.
- `/askcodex stop`: stops the active Codex PTY for this chat.
- `/askcodex reset`: keeps session identity when available and restarts runtime state.
- `/askcodex handoff`: returns a local `codex resume --yolo <session-id>` command for interactive handoff.
- `/askcodex resume`: restarts Codex automation for this chat in the stored workspace/session context.

## Requirements

- `codex` CLI available on PATH, or configure `codexBin`.
- PTY runtime support (`@lydell/node-pty` is packaged as a dependency).
- OpenClaw gateway with this plugin enabled.
- Dedicated `codexHome` and `defaultCwd` must be configured in `plugins.entries.askcodex.config`.
  - Plugin load fails with a helpful error if either is missing or non-isolated.

## Install

### Local tarball (recommended while private)

```bash
npm pack
openclaw plugins install ./dougvk-askcodex-<version>.tgz
```

### npm spec (private package)

```bash
openclaw plugins install @dougvk/askcodex@<version>
```

## Config

Plugin manifest config schema is in `openclaw.plugin.json`.

Common keys:

- `codexHome`
- `defaultCwd`
- `codexBin`
- `deliveryMode`
- `forceAbsoluteAgentConfig`

## State Layout And Isolation

askcodex writes state in two places:

- Plugin records under agent root:
  - `<agentRoot>/askcodex/<session-hash>.json`
  - `<agentRoot>/askcodex/archive/*.json`
- Codex runtime/session files under `codexHome`:
  - default: `~/.cache/askcodex-codex-home`
  - session JSONL: `<codexHome>/sessions/YYYY/MM/DD/*.jsonl`

Recommended setup for a dedicated plugin home:

```json
{
  "plugins": {
    "entries": {
      "askcodex": {
        "enabled": true,
        "config": {
          "codexHome": "/srv/openclaw/state/askcodex-prod/codex-home",
          "defaultCwd": "/srv/openclaw/workspaces/askcodex-prod",
          "codexBin": "/usr/local/bin/codex"
        }
      }
    }
  }
}
```

Best practices:

- Use a unique `codexHome` per environment (prod/stage/dev).
- Do not share one `codexHome` across unrelated gateways/agents.
- Keep `codexHome` and `defaultCwd` on persistent storage with restricted permissions.
- If using relative `agents.*.config_file` in Codex config, set `sharedConfigDir` explicitly.

## Tests

```bash
npm test
```
