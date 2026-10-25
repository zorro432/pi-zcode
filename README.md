# pi-zcode

Use the **ZCode desktop app's** (Zhipu / Z.ai) start-plan GLM models from pi. The plugin reads the app's own config and encrypted credentials and registers a `zcode` provider speaking the Anthropic Messages API to the same endpoint the desktop app uses — no API key of your own to manage.

## Models

| Model | Reasoning | Input | Context |
|---|---|---|---|
| GLM-5.3-Flash | yes | text, image | 1M |
| GLM-5.3 | yes | text | 1M |

Usage is metered against the plan's token buckets (not billed per token), so cost shows as zero.

### Thinking levels

pi's levels map to the gateway's effort variants exactly like the ZCode app itself (and models.dev's `reasoning_options`): **low → low, high → high, max → max**, with off/minimal/medium/xhigh hidden — the plan always reasons, there is no off. pi's own level default (`medium`) clamps down to `high`; set pi's default thinking level to `max` (via `/model` in pi) to match the desktop app's default. On the wire the plugin rewrites pi's `thinking` block to the app's bare `{type: "enabled"}` and keeps pi's level in `output_config.effort`.

## Install

1. Log in to the ZCode desktop app once (it writes `~/.zcode/v2/`).
2. Add the package: `pi install git:github.com/zorro432/pi-zcode` (or add to `packages` in pi settings).
3. Restart the session. Provider id: `zcode`, models `glm-5.3-flash` / `glm-5.3`.

## Usage meter

With a compatible usage meter installed, this plugin adds a **ZCode Start Plan** tab to its `/usage` meter: one bar per entitled model, percent of the token bucket used, tokens remaining, and the plan's end time.

- Data comes from the same `billing/balance` endpoint the desktop app's usage UI calls, sent with the app's identity headers including `x-device-mid` (read from `~/.zcode/v2/telemetry-state.json`) — without it the endpoint rejects the request.
- Tokens are re-resolved on every fetch, so a JWT rotation after a desktop-app re-login needs no restart.
- Without a usage meter installed, this tab simply doesn't exist.

## Re-login and plan changes

ZCode rewrites its files on login or plan changes; the plugin re-reads them on every session start, so no plugin update is needed. If decryption fails because you set `ZCODE_CREDENTIAL_SECRET` in ZCode's environment, set the same variable for pi.

## Notes

- No network discovery, no canary: the model list comes from ZCode's own config; anything outside the plan's entitlements (`model:glm-5.3*`) is filtered out since it would only 403.
- The gateway's WAF scores requests that don't look like the desktop app's — the plugin carries the app's captured identity headers and injects its system preamble (see `wire-preamble.json`) to clear it.
- Long-lived headless sessions outliving a token rotation need a restart (or re-source the session).
