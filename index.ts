import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform, release } from "node:os";
import { join } from "node:path";
import { startZcodeTransformProxy, type TransformProxy } from "./proxy.ts";
import {
	buildZcodeHeaders,
	decryptCredentialEnvelope,
	deriveCredentialSecret,
	newUserAgent,
	startPlanModelConfigs,
	type ZcodeConfigFile,
	type ZcodeCredentialsFile,
} from "./shared.ts";

// pi-zcode — run the local ZCode desktop app's start-plan quota from pi.
// The only module here that touches disk or pi's API; pure core is shared.ts.

const PROVIDER_ID = "zcode";
const PROVIDER_NAME = "ZCode (Z.ai Start Plan)";
const APP_VERSION = process.env.ZCODE_APP_VERSION ?? "3.16.3";
const START_PLAN_PRESET_KEY = "builtin:zai-start-plan";
const CREDENTIAL_JWT_KEY = "zcodejwttoken";

const V2_DIR = join(homedir(), ".zcode", "v2");
const CONFIG_FILE = join(V2_DIR, "config.json");
const CREDENTIALS_FILE = join(V2_DIR, "credentials.json");

function readJson<T>(path: string): T | null {
	try {
		if (!existsSync(path)) return null;
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return null;
	}
}

function registerProviderFor(pi: ExtensionAPI, baseUrl: string, token: string, models: ReturnType<typeof startPlanModelConfigs>) {
	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl,
		apiKey: token,
		authHeader: true,
		api: "anthropic-messages",
		headers: buildZcodeHeaders({
			appVersion: APP_VERSION,
			osCategory: "linux",
			userAgent: newUserAgent(APP_VERSION),
			token,
			osVersion: release(),
		}),
		models,
	});
}

function resolveToken(config: ZcodeConfigFile | null, creds: ZcodeCredentialsFile | null): string | null {
	const configKey = config?.provider?.[START_PLAN_PRESET_KEY]?.options?.apiKey?.trim();
	if (configKey) return configKey;
	const envelope = creds?.[CREDENTIAL_JWT_KEY];
	if (!envelope) return null;
	try {
		const secret = deriveCredentialSecret({
			envSecret: process.env.ZCODE_CREDENTIAL_SECRET,
			platform: platform(),
			homedir: homedir(),
			username: process.env.USER ?? "",
		});
		const token = decryptCredentialEnvelope(envelope, secret).trim();
		return token || null;
	} catch {
		return null;
	}
}

function resolveBaseUrl(config: ZcodeConfigFile | null): string {
	return config?.provider?.[START_PLAN_PRESET_KEY]?.options?.baseURL?.trim()
		|| "https://zcode.z.ai/api/v1/zcode-plan/anthropic";
}

export default function activate(pi: ExtensionAPI) {
	const sessionId = crypto.randomUUID();
	let proxy: TransformProxy | null = null;

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
			osCategory: "linux",
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
		const token = resolveToken(config, creds);
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
				registerProviderFor(pi, upstreamOrigin, token, models);
			});
		return models.length;
	}

	const registered = register();

	process.on("exit", () => proxy?.close());

	pi.on("session_start", () => {
		// ZCode rewrites these files on login/plan changes; re-read each session.
		register();
	});

	if (registered === 0 && process.env.PI_ZCODE_DEBUG) {
		console.error("[pi-zcode] no ZCode start-plan token found — log in to the ZCode desktop app once, then restart this session");
	}
}

// Anything written to pi's stderr during TUI init lands in the input box as
// if typed; diagnostics stay silent unless PI_ZCODE_DEBUG is set.
function dbg(message: string): void {
	if (process.env.PI_ZCODE_DEBUG) console.error(`[pi-zcode] ${message}`);
}
