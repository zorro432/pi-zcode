import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { release } from "node:os";
import { startZcodeTransformProxy, type TransformProxy } from "./proxy.ts";
import { resolveZcodeToken, registerZcodeUsageProvider } from "./usage.ts";
import { APP_VERSION, CONFIG_FILE, CREDENTIALS_FILE, readJson, START_PLAN_PRESET_KEY } from "./data-files.ts";
import {
	buildZcodeHeaders,
	normalizeOsCategory,
	newUserAgent,
	startPlanModelConfigs,
	type ZcodeConfigFile,
	type ZcodeCredentialsFile,
} from "./shared.ts";

// pi-zcode — run the local ZCode desktop app's start-plan quota from pi.
// The only module here that touches disk or pi's API; pure core is shared.ts.

const PROVIDER_ID = "zcode";
const PROVIDER_NAME = "ZCode (Z.ai Start Plan)";

function registerProviderFor(pi: ExtensionAPI, baseUrl: string, token: string, models: ReturnType<typeof startPlanModelConfigs>) {
	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl,
		apiKey: token,
		authHeader: true,
		api: "anthropic-messages",
		headers: buildZcodeHeaders({
			appVersion: APP_VERSION,
			userAgent: newUserAgent(APP_VERSION),
			token,
			osVersion: release(),
		}),
		models,
	});
}

function resolveBaseUrl(config: ZcodeConfigFile | null): string {
	return config?.provider?.[START_PLAN_PRESET_KEY]?.options?.baseURL?.trim()
		|| "https://zcode.z.ai/api/v1/zcode-plan/anthropic";
}

export default function activate(pi: ExtensionAPI) {
	const sessionId = crypto.randomUUID();
	let proxy: TransformProxy | null = null;
	// Notices raised before a session context exists flush through ctx.ui.notify
	// on session_start — console.error during TUI init hijacks the input box.
	const pendingNotices: string[] = [];

	function notice(message: string): void {
		pendingNotices.push(message);
	}

	async function ensureProxy(token: string, upstreamOrigin: string): Promise<string> {
		const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? undefined;
		if (proxy) {
			proxy.setToken(token);
			return `http://127.0.0.1:${proxy.port}`;
		}
		// ZCODE_HTTPS_PROXY chains the upstream through a CONNECT proxy for debug
		// capture; proxy binds loopback so pi->proxy stays plain.
		proxy = await startZcodeTransformProxy({
			upstreamOrigin,
			appVersion: APP_VERSION,
			userAgent: newUserAgent(APP_VERSION),
			token,
			osVersion: release(),
			timeZone,
			sessionId,
		});
		return `http://127.0.0.1:${proxy.port}`;
	}

	function register(): number {
		const config = readJson<ZcodeConfigFile>(CONFIG_FILE);
		const creds = readJson<ZcodeCredentialsFile>(CREDENTIALS_FILE);
		const token = resolveZcodeToken(config, creds)?.token;
		if (!token) return 0;

		const models = startPlanModelConfigs(config?.provider?.[START_PLAN_PRESET_KEY]?.models);
		const upstreamOrigin = resolveBaseUrl(config);

		ensureProxy(token, upstreamOrigin)
			.then((baseUrl) => {
				dbg(`transform proxy on ${baseUrl} -> ${upstreamOrigin}`);
				registerProviderFor(pi, baseUrl, token, models);
			})
			.catch(() => {
				// No local proxy (port bind failure?) — direct may trip the WAF,
				// but a broken provider beats a missing one.
				notice("transform proxy unavailable, using direct endpoint (may hit the WAF)");
				registerProviderFor(pi, upstreamOrigin, token, models);
			});
		return models.length;
	}

	const registered = register();

	process.on("exit", () => proxy?.close());

	pi.on("session_start", (_event, ctx) => {
		// ZCode rewrites these files on login/plan changes; re-read each session.
		register();
		for (const message of pendingNotices.splice(0)) {
			try {
				ctx.ui.notify(`[pi-zcode] ${message}`, "warning");
			} catch {
				console.error(`[pi-zcode] ${message}`);
			}
		}
	});

	if (registered === 0) {
		notice("no ZCode start-plan token found — log in to the ZCode desktop app once, then restart this session");
	}

	// Plug the ZCode usage provider into pi-go-usage's registry (no-op when
	// that package isn't installed). Fetches re-resolve the token, so this
	// once here is enough.
	registerZcodeUsageProvider();
}

// Anything written to pi's stderr during TUI init lands in the input box as
// if typed; diagnostics stay silent unless PI_ZCODE_DEBUG is set.
function dbg(message: string): void {
	if (process.env.PI_ZCODE_DEBUG) console.error(`[pi-zcode] ${message}`);
}
