# pi-zcode

Start-plan GLM models from the [ZCode desktop app](https://zcode.z.ai) for [pi](https://github.com/earendil-works/pi-coding-agent) — borrow the app's login, no API key to manage.

## Install

```bash
pi install git:github.com/zorro432/pi-zcode
```

1. Log in to the ZCode desktop app once (it writes `~/.zcode/v2/`).
2. Restart the session. `/model` → pick a `zcode` model (`glm-5.3`, `glm-5.3-flash`).

## What you get

- **No keys to manage** — the plugin reads the app's own config and encrypted credentials, re-reading them at every session start.
- **1M-context GLM** — `glm-5.3` (text) and `glm-5.3-flash` (text + image), metered against the plan's token buckets, so cost shows as zero.
- **Plan-accurate model list** — models the plan no longer covers (per the billing endpoint's entitlements) are hidden from `/model` instead of failing on first use; if the endpoint can't be reached, everything shows as before.
- **Reasoning levels that stick** — pi's thinking levels map to the plan's low / high / max efforts, the same mapping the desktop app uses.
- **A usage meter** — one bar per entitled model: percent of the bucket used, tokens remaining, plan end date. Requires a compatible usage meter installed; without one, this tab doesn't exist.

## Env (optional)

- `ZCODE_CREDENTIAL_SECRET` — only if you set it in ZCode's environment; same value for pi
- `ZCODE_APP_VERSION` — override the app version stamped into request headers
- `PI_ZCODE_DEBUG` — log proxy diagnostics to stderr
- `ZCODE_HTTPS_PROXY` — chain upstream through a CONNECT proxy for debug capture

## Notes

- Credentials stay local: the plugin reads `~/.zcode/v2/` and talks only to `zcode.z.ai`.
- The plan always reasons; there is no "off". pi's default level (medium) clamps to high — set pi's default thinking to `max` via `/model` to match the app.
- ZCode rewrites its files on login and plan changes; new sessions pick that up with no plugin update. A session already running when the token rotates needs a restart.
- Requests are shaped to read like the app's own wire traffic — the gateway's WAF rejects anything else — via a local loopback transform proxy.

## License

MIT
