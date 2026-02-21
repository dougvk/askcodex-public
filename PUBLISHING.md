# Publishing (Private-First)

## Preconditions

- Tests pass: `npm test`.
- `openclaw.plugin.json` is present and valid.
- `package.json` includes `openclaw.extensions`.

## Package

```bash
npm pack
```

Expected tarball: `dougvk-askcodex-<version>.tgz`.

## Validate Install Without Touching Live Plugins

Use an isolated OpenClaw state dir:

```bash
STATE=/tmp/openclaw-plugin-install-state-askcodex
CONFIG="$STATE/openclaw.json"
rm -rf "$STATE"
mkdir -p "$STATE"
OPENCLAW_STATE_DIR="$STATE" OPENCLAW_CONFIG_PATH="$CONFIG" \
  openclaw plugins install ./dougvk-askcodex-<version>.tgz
OPENCLAW_STATE_DIR="$STATE" OPENCLAW_CONFIG_PATH="$CONFIG" \
  openclaw plugins list --json
```

## Runtime Requirements

- `codex` available on PATH (or set `codexBin`).
- PTY support via packaged `@lydell/node-pty` dependency.
- `plugins.entries.askcodex.config.codexHome` must be explicitly set to a dedicated directory.
- `plugins.entries.askcodex.config.defaultCwd` must be explicitly set to a dedicated workspace directory.

## Recommended Dedicated Codex Home

For production, configure a dedicated `codexHome` and workspace per environment:

```bash
mkdir -p /srv/openclaw/state/askcodex-prod/codex-home
mkdir -p /srv/openclaw/workspaces/askcodex-prod
chmod 700 /srv/openclaw/state/askcodex-prod/codex-home
```

Config snippet:

```json
{
  "plugins": {
    "entries": {
      "askcodex": {
        "config": {
          "codexHome": "/srv/openclaw/state/askcodex-prod/codex-home",
          "defaultCwd": "/srv/openclaw/workspaces/askcodex-prod"
        }
      }
    }
  }
}
```

This keeps Codex session files and caches out of shared/default homes.

## Optional Registry Publish

`package.json` sets `publishConfig.access=restricted`.

When ready:

```bash
npm publish
```
