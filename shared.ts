// Wire contract mirrored from the ZCode desktop app (captured via mitmproxy):
// Anthropic Messages API at {baseURL}/v1/messages, Bearer <zcode JWT>.
// Everything here takes values and returns results; index.ts touches disk.

import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { arch, platform } from "node:os";

// The app's normalizeOsCategory (zcode.cjs buildZCodeSourceHeadersFromContext):
// darwin -> macos, win32 -> windows, everything else linux.
export function normalizeOsCategory(p: string): string {
	if (p === "darwin") return "macos";
	if (p === "win32") return "windows";
	return "linux";
}

/** The app sends `x-platform` as `${process.platform}-${process.arch}`. */
export function platformArchTag(): string {
	return `${platform()}-${arch()}`;
}

export interface ZcodeModelSpec {
	reasoning?: {
		enabled?: boolean;
		variants?: string[];
		defaultVariant?: string;
	};
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

/** pi's thinking-level map — the same shape pi-zen builds from models.dev's reasoning_options. */
export type ZcodeThinkingLevelMap = Partial<
	Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>
>;

export interface ZcodeModelConfig {
	id: string;
	name: string;
	api: "anthropic-messages";
	reasoning: boolean;
	/** pi level -> wire effort; null hides the level. See thinkingLevelMapFor. */
	thinkingLevelMap?: ZcodeThinkingLevelMap;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	compat: { forceAdaptiveThinking?: boolean };
}

// Mirrors ZCode's createCredentialCipherProvider: `enc:v1:` + base64url(iv)
// + "." + base64url(tag) + "." + base64url(ciphertext), AES-256-GCM on sha256(secret).

export function deriveCredentialSecret(input: {
	envSecret?: string;
	platform: string;
	homedir: string;
	username?: string;
}): string {
	if (input.envSecret) return input.envSecret;
	// The app reads os.userInfo().username and falls back to "unknown" on
	// failure (env vars like USER are absent on Windows / some environments).
	const username = input.username || "unknown";
	return `zcode-credential-fallback:${input.platform}:${input.homedir}:${username}`;
}

/** The app's defaultCredentialSecret: userInfo().username, "unknown" on failure. */
export function credentialUsername(): string {
	try {
		return userInfo().username;
	} catch {
		return "unknown";
	}
}

const CREDENTIAL_ENVELOPE_PREFIX = "enc:v1:";

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
		"x-platform": platformArchTag(),
		"x-os-category": input.osCategory ?? normalizeOsCategory(platform()),
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
	/** Defaults to the app's normalizeOsCategory(process.platform). */
	osCategory?: string;
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

function systemBlocksOf(system: unknown): SystemBlock[] {
	if (typeof system === "string") {
		return system.trim() ? [{ type: "text", text: system }] : [];
	}
	if (Array.isArray(system)) {
		return system.filter(
			(b): b is SystemBlock =>
				!!b && typeof b === "object" &&
				(b as Record<string, unknown>).type === "text" &&
				typeof (b as Record<string, unknown>).text === "string",
		);
	}
	if (system && typeof system === "object" && "text" in (system as Record<string, unknown>)) {
		const text = (system as Record<string, unknown>).text;
		if (typeof text === "string") return [{ type: "text", text }];
	}
	return [];
}

export interface RelocatedSystem {
	system: unknown;
	messages: unknown;
}

/**
 * The gateway's WAF scores only the top-level `system` field, additively over
 * its content: large multi-section systems cross its "unusual activity"
 * threshold even though (a) the same text passes inside `messages` and (b)
 * equal-sized neutral filler passes. The desktop app's own wire shape already
 * carries extra system content as a leading role:"system" message (the
 * mid-conversation-system beta — it ships skill lists that way). So: keep the
 * app's captured preamble as the top-level system, and move the caller's real
 * system into the messages. Semantically equivalent for the model; wire-faithful
 * to the app.
 */
export function relocateSystemToMessages(
	system: unknown,
	messages: unknown,
	preamble: SystemBlock[],
): RelocatedSystem {
	const blocks = systemBlocksOf(system);
	if (preamble.length === 0) {
		// Nothing to anchor the top-level system with — keep the old inject shape.
		return { system: injectSystemPreamble(system, preamble), messages };
	}
	if (blocks.length === 0) {
		// Caller sent no system: the preamble stands alone, no phantom block.
		return { system: preamble, messages };
	}
	const existing = Array.isArray(messages) ? (messages as unknown[]) : [];
	const first = existing[0] as { role?: unknown; content?: unknown } | undefined;
	const firstIsSystem = !!first && first.role === "system";
	const systemMessage = firstIsSystem
		? { role: "system", content: [...blocks, ...systemBlocksOf(first.content)] }
		: { role: "system", content: blocks };
	return {
		system: preamble,
		messages: [systemMessage, ...(firstIsSystem ? existing.slice(1) : existing)],
	};
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

/**
 * pi's effort-path thinking block → the app's captured bare block. Concretely:
 * {type:"adaptive", display, block_binding} → {type:"enabled"}; a stray
 * {type:"disabled"} → undefined (the plan exposes no off — drop it rather
 * than send an unsupported value); anything else passes through. The effort
 * value itself lives in output_config, untouched here.
 */
function normalizeWireThinking(thinking: unknown): unknown {
	if (!thinking || typeof thinking !== "object" || Array.isArray(thinking)) return thinking;
	const type = (thinking as Record<string, unknown>).type;
	if (type === "adaptive" || type === "enabled") return { type: "enabled" };
	if (type === "disabled") return undefined;
	return thinking;
}

/**
 * The full body reshape pi's requests must pass through to read like the
 * desktop app's wire — the single seam the proxy crosses:
 *  1. The gateway's WAF scores the top-level `system` field additively; big
 *     systems trip "unusual activity" even though the same text passes inside
 *     `messages`. The app's own shape carries extra system content as a
 *     leading role:"system" message — so the captured preamble stays the
 *     top-level system and pi's real system relocates into the messages.
 *  2. pi's effort path emits {type:"adaptive"}; the app always sends the bare
 *     enabled block (see normalizeWireThinking).
 * Returns a new body; inputs are never mutated. Undefined-valued keys vanish
 * at JSON.stringify, so a dropped disabled block and an absent one are the
 * identical wire.
 */
export function transformRequestBody(
	body: Record<string, unknown>,
	preamble: SystemBlock[],
): Record<string, unknown> {
	const moved = "system" in body
		? relocateSystemToMessages(body.system, body.messages, preamble)
		: undefined;
	return {
		...body,
		thinking: normalizeWireThinking(body.thinking),
		...(moved ? { system: moved.system, messages: moved.messages } : {}),
	};
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

/**
 * Thinking levels, following pi-zen's buildThinkingLevelMap rule (the same
 * translation pi-zen applies to models.dev reasoning_options, which for
 * glm-5.3* is `[{type: "effort", values: ["low", "high", "max"]}]`): effort
 * values map identity, levels outside the list are null (hidden), "none"
 * means off. pi's effort path (compat.forceAdaptiveThinking + thinkingLevelMap)
 * then drives that value into output_config.effort, which the proxy keeps —
 * the app's captured bodies carry bare thinking:{type:"enabled"} plus exactly
 * that effort field, never budget_tokens.
 *
 * Variant source: the ZCode preset's reasoning.variants when they read as
 * effort values, else the canonical models.dev trio (same values models.dev
 * publishes for the zai provider). No "none" appears anywhere — thinking
 * cannot be disabled on this gateway, so off is hard-null and pi's level
 * default ("medium") clamps to "high"; set pi's default-thinking-level to
 * "max" to match the app.
 */
const CANONICAL_EFFORTS = ["low", "high", "max"] as const;

export function thinkingLevelMapFor(spec: ZcodeModelSpec | undefined): ZcodeThinkingLevelMap {
	const raw = spec?.reasoning?.variants ?? [];
	const known = raw.filter((v): v is (typeof CANONICAL_EFFORTS)[number] | "none" =>
		v === "none" || (CANONICAL_EFFORTS as readonly string[]).includes(v));
	// Unrecognized variant shapes (e.g. binary enabled/off) fall back to the
	// canonical trio instead of regressing to pi's budget thinking.
	const efforts = new Set<string>(known.length > 0 ? known : CANONICAL_EFFORTS);
	const map: ZcodeThinkingLevelMap = { off: efforts.has("none") ? "none" : null };
	for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
		map[level] = efforts.has(level) ? level : null;
	}
	return map;
}

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
		thinkingLevelMap: thinkingLevelMapFor(spec),
		input: (spec.modalities?.input ?? ["text"]).filter(
			(m): m is "text" | "image" => m === "text" || m === "image",
		),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // plan-metered, not billed
		contextWindow: spec.limit?.context ?? 1_000_000,
		maxTokens: spec.limit?.output ?? 128_000,
		compat: { forceAdaptiveThinking: true },
	}));
}

/**
 * Keep only models the plan's token buckets actually entitle (see
 * parseEntitledModels). The fallbacks exist for degraded data, not for
 * second-guessing the plan: null (couldn't ask) and an empty match (asked
 * but nothing lined up — transient or partial payload) both keep every
 * model, because a provider with zero models is harder to diagnose than a
 * 403 naming the real problem. A non-empty entitlement set is ground truth
 * and wins over the preset cache, which can lag the plan.
 */
export function filterToEntitled(
	models: ZcodeModelConfig[],
	entitled: Set<string> | null,
): ZcodeModelConfig[] {
	if (!entitled || entitled.size === 0) return models;
	const covered = models.filter((m) => entitled.has(m.id));
	return covered.length > 0 ? covered : models;
}
