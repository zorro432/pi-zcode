# pi-zcode

Use the **ZCode desktop app's** (Zhipu / Z.ai) start-plan GLM models from pi.

ZCode stores its provider presets in `~/.zcode/v2/config.json` (plaintext) and
OAuth credentials in `~/.zcode/v2/credentials.json` (AES-256-GCM with a
per-machine derived key). This extension reads both and registers a `zcode`
provider speaking the Anthropic Messages API to
`https://zcode.z.ai/api/v1/zcode-plan/anthropic` — the same endpoint and
identity headers the desktop app itself uses (captured with mitmproxy).

## Models

| Model | Reasoning | Input | Context |
|---|---|---|---|
| GLM-5.3-Flash | yes | text, image | 1M |
| GLM-5.3 | yes | text | 1M |

Usage is metered against the plan's token buckets (not billed per token), so
cost shows as zero.

## Setup

1. Log in to the ZCode desktop app once (it writes `~/.zcode/v2/`).
2. Add the package: `pi install /path/to/pi-zcode` (or add to `packages` in pi settings).
3. Restart the session. Provider id: `zcode`, models `glm-5.3-flash` / `glm-5.3`.

Tokens are re-read on every session start, so re-login / plan changes need no
plugin update. If decryption fails because you set `ZCODE_CREDENTIAL_SECRET`
in ZCode's environment, set the same variable for pi.

## Notes

- No network discovery, no canary: the model list comes from ZCode's own
  config; anything outside the plan's entitlements (`model:glm-5.3*`) is
  filtered out since it would only 403.
- The JWT rotates when the desktop app re-authenticates; the session-start
  re-read handles that. Long-lived headless sessions outliving a token
  rotation need a restart (or re-source the session).
