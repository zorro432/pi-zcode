// Wire contract mirrored from the ZCode desktop app (captured via mitmproxy):
// Anthropic Messages API at {baseURL}/v1/messages, Bearer <zcode JWT>.
// Everything here takes values and returns results; index.ts touches disk.

import { createDecipheriv, createHash, randomUUID } from "node:crypto";

export interface ZcodeModelSpec {
	reasoning?: { enabled?: boolean; defaultVariant?: string };
	limit?: { context?: number; output?: number };
	modalities?: { input?: string[] };
}

export interface ZcodeProviderPreset {
	name?: string;
	kind?: string;
	enabled?: boolean;
	options?: { apiKey?: string; baseURL?: string };
	models?: Record<string, ZcodeModelSpec>;
}

export interface ZcodeConfigFile {
	provider?: Record<string, ZcodeProviderPreset>;
}

export interface ZcodeCredentialsFile {
	[key: string]: string;
}

export interface ZcodeModelConfig {
	id: string;
	name: string;
	api: "anthropic-messages";
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	compat: Record<string, never>;
}

// Mirrors ZCode's createCredentialCipherProvider: `enc:v1:` + base64url(iv)
// + "." + base64url(tag) + "." + base64url(ciphertext), AES-256-GCM on sha256(secret).

export const CREDENTIAL_ENVELOPE_PREFIX = "enc:v1:";

export function deriveCredentialSecret(input: {
	envSecret?: string;
	platform: string;
	homedir: string;
	username: string;
}): string {
	if (input.envSecret) return input.envSecret;
	const username = input.username || "unknown";
	return `zcode-credential-fallback:${input.platform}:${input.homedir}:${username}`;
}

export function decryptCredentialEnvelope(envelope: string, secret: string): string {
	if (!envelope.startsWith(CREDENTIAL_ENVELOPE_PREFIX)) return envelope;
	const parts = envelope.slice(CREDENTIAL_ENVELOPE_PREFIX.length).split(".");
	if (parts.length !== 3 || !parts[0] || !parts[1] || parts[2] === undefined) {
		throw new Error("invalid credential envelope");
	}
	const iv = Buffer.from(parts[0], "base64url");
	const tag = Buffer.from(parts[1], "base64url");
	const ciphertext = Buffer.from(parts[2], "base64url");
	if (iv.length !== 12) throw new Error("invalid credential envelope: iv");
	if (tag.length !== 16) throw new Error("invalid credential envelope: tag");
	const key = createHash("sha256").update(secret).digest();
	const decipher = createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
}

// Desktop app's header set, minus session/query/trace ids — those belong to pi per request.

export interface ZcodeIdentityHeaders extends Record<string, string> {
	"user-agent": string;
	"http-referer": string;
	"x-title": string;
	"x-zcode-app-version": string;
	"x-platform": string;
	"x-os-category": string;
	"x-os-version": string;
	"x-release-channel": string;
	"x-zcode-agent": string;
	"x-zcode-session-type": string;
	"x-zcode-query-source": string;
	"x-request-id": string;
	"x-query-id": string;
	"x-zcode-trace-id": string;
	"x-session-id": string;
	"x-client-language": string;
	"x-client-timezone": string;
	"anthropic-version": string;
	"x-api-key": string;
}

export function buildZcodeHeaders(input: HeaderSource): ZcodeIdentityHeaders {
	const tz = input.timeZone ?? "UTC";
	return {
		"user-agent": input.userAgent,
		"http-referer": "https://zcode.z.ai",
		"x-title": "Z Code@electron",
		"x-zcode-app-version": input.appVersion,
		"x-platform": "linux-x64",
		"x-os-category": input.osCategory,
		"x-os-version": input.osVersion ?? "",
		"x-release-channel": "production",
		"x-zcode-agent": "glm",
		"x-zcode-session-type": "main",
		"x-zcode-query-source": "main_turn",
		"x-request-id": randomUUID(),
		"x-query-id": randomUUID(),
		"x-zcode-trace-id": randomUUID(),
		"x-session-id": input.sessionId ? `session_${input.sessionId}` : `session_${randomUUID()}`,
		"x-client-language": "en-US",
		"x-client-timezone": tz,
		"anthropic-version": "2023-06-01",
		"x-api-key": input.token,
	};
}

export interface HeaderSource {
	appVersion: string;
	osCategory: string;
	userAgent: string;
	/** Start-plan JWT — the app sends it as both Authorization and x-api-key. */
	token: string;
	osVersion?: string;
	timeZone?: string;
	sessionId?: string;
}

/**
 * The exact upstream header set, in the app's captured order (native https
 * preserves order; undici fetch re-adds stripped spec headers, so the
 * upstream hop must not use fetch).
 */
// The gateway's WAF scores the system prompt: requests whose system doesn't
// read like ZCode's own agent preamble get 405/3012 even with perfect headers.
// The fix is to prefix the app's real preamble (wire-preamble.json, captured
// from the desktop app via mitmproxy) ahead of pi's system.

export interface SystemBlock {
	type: "text";
	text: string;
}

export function injectSystemPreamble(
	system: unknown,
	preamble: SystemBlock[],
): unknown {
	if (preamble.length === 0) return system;
	if (typeof system === "string") {
		return [...preamble, { type: "text", text: system }];
	}
	if (Array.isArray(system)) return [...preamble, ...system];
	if (system && typeof system === "object" && "text" in (system as Record<string, unknown>)) {
		return [...preamble, system];
	}
	return [...preamble, { type: "text", text: "" }];
}

export function buildModelRequestHeaders(source: HeaderSource): Array<[string, string]> {
	const base = buildZcodeHeaders(source);
	return [
		["anthropic-beta", "mid-conversation-system-2026-04-07"],
		["anthropic-version", "2023-06-01"],
		["authorization", `Bearer ${source.token}`],
		["content-type", "application/json"],
		["http-referer", base["http-referer"]],
		["user-agent", base["user-agent"]],
		["x-api-key", source.token],
		["x-client-language", base["x-client-language"]],
		["x-client-timezone", base["x-client-timezone"]],
		["x-os-category", base["x-os-category"]],
		["x-os-version", base["x-os-version"]],
		["x-platform", base["x-platform"]],
		["x-query-id", base["x-query-id"]],
		["x-release-channel", base["x-release-channel"]],
		["x-request-id", base["x-request-id"]],
		["x-session-id", base["x-session-id"]],
		["x-title", base["x-title"]],
		["x-zcode-agent", base["x-zcode-agent"]],
		["x-zcode-app-version", base["x-zcode-app-version"]],
		["x-zcode-query-source", base["x-zcode-query-source"]],
		["x-zcode-session-type", base["x-zcode-session-type"]],
		["x-zcode-trace-id", base["x-zcode-trace-id"]],
	];
}

export function newUserAgent(appVersion: string): string {
	return `ZCode/${appVersion} ai-sdk/provider-utils/4.0.27 runtime/node.js/24`;
}

// Entitlements meter exact ids (model:glm-5.3-flash, model:glm-5.3); anything
// else in the preset would 403 on first use. ZCode's preset cache can lag the
// plan (it has dropped flash while the bucket still exists), so the fallback
// pair is always the base and preset specs overlay it.

const START_PLAN_COVERED = new Set(["glm-5.3-flash", "glm-5.3"]);

const FALLBACK_SPECS: Record<string, ZcodeModelSpec> = {
	"GLM-5.3-Flash": {
		reasoning: { enabled: true },
		limit: { context: 1_000_000, output: 128_000 },
		modalities: { input: ["text", "image"] },
	},
	"GLM-5.3": {
		reasoning: { enabled: true },
		limit: { context: 1_000_000, output: 128_000 },
		modalities: { input: ["text"] },
	},
};

export function startPlanModelConfigs(
	presetModels: Record<string, ZcodeModelSpec> | undefined,
): ZcodeModelConfig[] {
	const merged: Record<string, ZcodeModelSpec> = { ...FALLBACK_SPECS };
	for (const [name, spec] of Object.entries(presetModels ?? {})) {
		if (START_PLAN_COVERED.has(name.toLowerCase())) merged[name] = spec;
	}
	return Object.entries(merged).map(([name, spec]) => ({
		id: name.toLowerCase(),
		name,
		api: "anthropic-messages" as const,
		reasoning: spec.reasoning?.enabled ?? true,
		input: (spec.modalities?.input ?? ["text"]).filter(
			(m): m is "text" | "image" => m === "text" || m === "image",
		),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // plan-metered, not billed
		contextWindow: spec.limit?.context ?? 1_000_000,
		maxTokens: spec.limit?.output ?? 128_000,
		compat: {},
	}));
}
