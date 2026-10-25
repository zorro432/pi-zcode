# pi-zcode

Use your ZCode desktop app's start plan from pi. No API key, no billing setup — the plugin borrows the app's own login and registers a `zcode` provider with GLM-5.3 and GLM-5.3-Flash.

## Install

1. Log in to the ZCode desktop app once (it writes `~/.zcode/v2/`).
2. Add the package: `pi install git:github.com/zorro432/pi-zcode`
3. Restart the session. Pick provider `zcode`, model `glm-5.3` or `glm-5.3-flash`.

## What you get

- **No keys to manage** — the plugin reads the app's own config and encrypted credentials, re-reading them at every session start.
- **1M-context GLM** — `glm-5.3` (text) and `glm-5.3-flash` (text + image), metered against the plan's token buckets, so cost shows as zero.
- **Reasoning levels that stick** — pi's thinking levels map to the plan's low / high / max efforts, the same mapping the desktop app uses.
- **A usage meter** — one bar per entitled model: percent of the bucket used, tokens remaining, plan end date. Requires a compatible usage meter installed; without one, this tab doesn't exist.

Credentials stay local: the plugin reads `~/.zcode/v2/` and talks only to `zcode.z.ai`.

## How it works

The provider speaks the Anthropic Messages API to the same endpoint the desktop app uses, through a local loopback transform proxy that shapes each request to read like the app's own wire traffic — the gateway's WAF scores anything that doesn't (405/3012 even with valid headers).

Details worth knowing:

- The plan always reasons; there is no "off". pi's default level (medium) clamps to high — set pi's default thinking level to `max` (via `/model`) to match the app.
- ZCode rewrites its files on login and plan changes; new sessions pick that up with no plugin update. A session already running when the token rotates needs a restart.
- The model list comes from the app's own config, filtered to the plan's entitlements.
- If you set `ZCODE_CREDENTIAL_SECRET` in ZCode's environment, set the same variable for pi.
