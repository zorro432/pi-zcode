// ZCode usage provider — the start-plan token buckets from the same
// billing/balance endpoint the desktop app's usage UI calls. Registered into
// pi-go-usage's globalThis provider registry when that package is installed;
// without it this module is inert (the registry is simply absent).
//
// Endpoint (captured via mitmproxy from the desktop app):
//   GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=X
//   authorization: Bearer <zcode JWT>   + the app's identity headers,
//   including x-device-mid — without it the endpoint answers 400/3001.
// Response envelope { code, msg, data }, data.balances[] holding one bucket
// per entitled model: total_units / used_units / remaining_units (tokens),
// show_name, expires_at (unix seconds).

import { homedir, release } from "node:os";
import {
	APP_VERSION,
	CREDENTIALS_FILE,
	readJson,
	START_PLAN_PRESET_KEY,
	TELEMETRY_FILE,
	CONFIG_FILE,
} from "./data-files.ts";
import {
	buildZcodeHeaders,
	credentialUsername,
	decryptCredentialEnvelope,
	deriveCredentialSecret,
	newUserAgent,
	type ZcodeConfigFile,
	type ZcodeCredentialsFile,
} from "./shared.ts";

// Structural twin of pi-go-usage's UsageWindow — deliberately local, so the
// two packages never depend on each other. The registry seam is the interface.
export interface ZcodeUsageWindow {
	label: string;
	usedPercent?: number;
	statusLabel?: string;
	resetAt?: Date;
}

const CREDENTIAL_JWT_KEY = "zcodejwttoken";
const BALANCE_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/balance";
const REQUEST_TIMEOUT_MS = 15_000;

// ─── Auth ────────────────────────────────────────────────────────────────────

export interface ZcodeTokenResolution {
	token: string;
	/** Where the token came from, for the meter's provenance line. */
	source: string;
}

/**
 * The start-plan JWT: ZCode rewrites these files on login/plan changes, so
 * this is resolved per fetch, never cached. The config's apiKey wins (it is
 * the key that carries the plan); the encrypted credential is the fallback.
 */
export function resolveZcodeToken(
	config: ZcodeConfigFile | null,
	creds: ZcodeCredentialsFile | null,
): ZcodeTokenResolution | null {
	const configKey = config?.provider?.[START_PLAN_PRESET_KEY]?.options?.apiKey?.trim();
	if (configKey) return { token: configKey, source: "~/.zcode/v2/config.json" };
	const envelope = creds?.[CREDENTIAL_JWT_KEY];
	if (!envelope) return null;
	try {
		const secret = deriveCredentialSecret({
			envSecret: process.env.ZCODE_CREDENTIAL_SECRET,
			platform: process.platform,
			homedir: homedir(),
			username: credentialUsername(),
		});
		const token = decryptCredentialEnvelope(envelope, secret).trim();
		if (!token) return null;
		return { token, source: "~/.zcode/v2/credentials.json (decrypted)" };
	} catch {
		return null;
	}
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

/** 299914597 → "299.9M", 200000000 → "200M", 1200000 → "1.2M", 9000 → "9K". */
export function formatTokens(value: number): string {
	if (value >= 1e9) return `${(value / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
	if (value >= 1e6) return `${(value / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
	if (value >= 1e3) return `${Math.round(value / 1e3)}K`;
	return `${Math.round(value)}`;
}

/** One usage window per token bucket; buckets with no total are skipped. */
export function parseZcodeBalance(payload: unknown): ZcodeUsageWindow[] {
	// Envelope: { code, msg, data: { plans: [...], balances: [...] } }.
	const data = asRecord(asRecord(payload)?.data);
	const balances = Array.isArray(data?.balances) ? data.balances : [];
	// plans[] carries display names keyed by plan_id. An account can hold
	// several active plans (e.g. a trial plus a "1024 Dev Day") whose buckets
	// repeat the same model show_names — prefix the plan name only when that's
	// the case, so the common single-plan meter keeps its short labels.
	const planNames = new Map<string, string>();
	if (Array.isArray(data?.plans)) {
		for (const raw of data.plans) {
			const plan = asRecord(raw);
			const id = typeof plan?.plan_id === "string" ? plan.plan_id : undefined;
			const name = typeof plan?.name === "string" ? plan.name.replace(/^ZCode\s+/i, "").trim() : "";
			if (id && name) planNames.set(id, name);
		}
	}
	// An account's plans stack: the gateway draws each model's usage from the
	// highest-priority bucket that still has units (plan_priority on the
	// bucket), falling to the next plan when one empties. Report only that
	// effective bucket per model capability — an exhausted trial bucket must
	// not read "limited" while a funded higher-priority plan covers the model.
	// Buckets without capabilities can't be ordered against anything, so they
	// always report.
	const prioOf = (b: Record<string, unknown>): number =>
		typeof b.plan_priority === "number" ? b.plan_priority
		: typeof b.priority === "number" ? b.priority
		: 0;
	const capOf = (b: Record<string, unknown>, index: number): string => {
		const caps = b.capabilities;
		const cap = Array.isArray(caps) && typeof caps[0] === "string" ? caps[0] : undefined;
		return cap ?? `bucket:${typeof b.bucket_id === "string" ? b.bucket_id : index}`;
	};
	const remainingOf = (b: Record<string, unknown>): number =>
		typeof b.remaining_units === "number" ? b.remaining_units : 0;
	const active = new Set<Record<string, unknown>>();
	const groups = new Map<string, Record<string, unknown>[]>();
	balances.forEach((raw, index) => {
		const bucket = asRecord(raw);
		if (!bucket) return;
		const cap = capOf(bucket, index);
		const group = groups.get(cap);
		if (group) group.push(bucket);
		else groups.set(cap, [bucket]);
	});
	for (const group of groups.values()) {
		const sorted = group.slice().sort((a, b) => prioOf(b) - prioOf(a));
		const top = sorted[0];
		if (top) active.add(sorted.find((b) => remainingOf(b) > 0) ?? top);
	}

	const distinctPlans = new Set(
		[...active]
			.map((b) => (typeof b.plan_id === "string" ? b.plan_id : undefined))
			.filter((id): id is string => !!id),
	).size;

	const windows: ZcodeUsageWindow[] = [];
	for (const raw of balances) {
		const bucket = asRecord(raw);
		if (!bucket || !active.has(bucket)) continue;
		const total = typeof bucket.total_units === "number" ? bucket.total_units : undefined;
		const used = typeof bucket.used_units === "number" ? bucket.used_units : undefined;
		const remaining = typeof bucket.remaining_units === "number" ? bucket.remaining_units : undefined;
		if (total === undefined || total <= 0 || used === undefined) continue;
		const showName = typeof bucket.show_name === "string" && bucket.show_name.trim() ? bucket.show_name.trim() : "tokens";
		const planName = distinctPlans > 1 && typeof bucket.plan_id === "string" ? planNames.get(bucket.plan_id) : undefined;
		const label = planName ? `${planName} · ${showName}` : showName;
		const expiresAt = typeof bucket.expires_at === "number" ? new Date(bucket.expires_at * 1000) : undefined;
		// "limited" is the meter's contract for an exhausted window — same word
		// the OpenCode Go provider uses, so error coloring and hints trigger.
		windows.push({
			label,
			usedPercent: Math.min(100, Math.max(0, (used / total) * 100)),
			statusLabel: remaining === 0 ? "limited" : remaining !== undefined ? `${formatTokens(remaining)} left` : undefined,
			resetAt: expiresAt,
		});
	}
	return windows;
}

// ─── Fetch ───────────────────────────────────────────────────────────────────

export async function fetchZcodeUsage(): Promise<
	| { state: "ready"; windows: ZcodeUsageWindow[]; note: string; source: string; updatedAt: Date }
	| { state: "unconfigured"; message: string; setupHint?: string }
	| { state: "expired"; message: string; reauthHint?: string }
	| { state: "error"; message: string; authHint?: string }
> {
	const config = readJson<ZcodeConfigFile>(CONFIG_FILE);
	const creds = readJson<ZcodeCredentialsFile>(CREDENTIALS_FILE);
	const auth = resolveZcodeToken(config, creds);
	if (!auth) {
		return {
			state: "unconfigured",
			message: "ZCode is not configured on this machine.",
			setupHint: "Fix: log in to the ZCode desktop app once (~/.zcode/v2/), then restart this session.",
		};
	}

	const telemetry = readJson<{ deviceMid?: string }>(TELEMETRY_FILE);
	const headers = buildZcodeHeaders({
		appVersion: APP_VERSION,
		userAgent: newUserAgent(APP_VERSION),
		token: auth.token,
		osVersion: release(),
	});
	// Balance is an app API, not a model API: drop the model-only headers, add
	// the ones the desktop app's own balance call carried (x-device-mid is
	// required — the endpoint 400s without it).
	const balanceHeaders: Record<string, string> = { ...headers };
	delete balanceHeaders["anthropic-version"];
	delete balanceHeaders["x-api-key"];
	balanceHeaders.authorization = `Bearer ${auth.token}`;
	if (telemetry?.deviceMid) balanceHeaders["x-device-mid"] = telemetry.deviceMid;
	balanceHeaders.accept = "*/*";
	balanceHeaders["accept-language"] = "*";
	balanceHeaders["sec-fetch-mode"] = "cors";

	const url = new URL(BALANCE_URL);
	url.searchParams.set("app_version", APP_VERSION);

	let response: Response;
	try {
		response = await fetch(url, {
			method: "GET",
			headers: balanceHeaders,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { state: "error", message: `ZCode balance request failed: ${message}` };
	}

	const body = await response.text();

	if (response.status === 401 || response.status === 403) {
		return {
			state: "expired",
			message: `ZCode token rejected (${response.status}).`,
			reauthHint: "Fix: open the ZCode desktop app once to rotate the JWT, then retry.",
		};
	}
	if (response.status < 200 || response.status >= 300) {
		let detail = body.replace(/\s+/g, " ").trim().slice(0, 160);
		try {
			const parsed = JSON.parse(body) as { code?: unknown; msg?: unknown };
			if (typeof parsed.msg === "string" && parsed.msg.trim()) detail = parsed.msg.trim();
		} catch {
			// keep raw snippet
		}
		return { state: "error", message: `ZCode balance request failed (${response.status}). ${detail}`.trim() };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return { state: "error", message: "ZCode balance response was not valid JSON." };
	}

	const windows = parseZcodeBalance(parsed);
	if (windows.length === 0) {
		return { state: "error", message: "ZCode balance response included no token buckets." };
	}

	return {
		state: "ready",
		windows,
		updatedAt: new Date(),
		source: auth.source,
		note: "official GET zcode.z.ai/api/v1/zcode-plan/billing/balance · start-plan token buckets",
	};
}

// ─── Registry plug-in ────────────────────────────────────────────────────────

// pi-go-usage's seam. Structural, not imported — the two packages must not
// depend on each other.
interface UsageProviderRegistryLike {
	version: 1;
	register(provider: unknown): void;
	list(): unknown[];
}

/**
 * Register the ZCode usage provider with pi-go-usage, if it is loaded. Safe
 * to call from activate() and on every session_start: registration is keyed
 * by provider id and idempotent, and fetchUsage re-resolves the token each
 * call, so JWT rotations need no re-registration.
 */
export function registerZcodeUsageProvider(): void {
	const registry = (globalThis as { __piUsageProviders?: UsageProviderRegistryLike }).__piUsageProviders;
	if (!registry || registry.version !== 1) return;
	registry.register({
		id: "zcode",
		label: "ZCode Start Plan",
		statusTag: "ZC",
		matchesModel: (model: { provider?: string; id?: string } | undefined) => model?.provider === "zcode",
		fetchUsage: fetchZcodeUsage,
	});
}
