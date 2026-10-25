import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import {
	buildModelRequestHeaders,
	buildZcodeHeaders,
	decryptCredentialEnvelope,
	deriveCredentialSecret,
	newUserAgent,
	normalizeOsCategory,
	startPlanModelConfigs,
	thinkingLevelMapFor,
	transformRequestBody,
	type HeaderSource,
	type SystemBlock,
	type ZcodeModelSpec,
} from "../shared.ts";

// Replicates ZCode's encrypt side so decrypt runs a real round-trip.
function encryptEnvelope(plaintext: string, secret: string): string {
	const key = createHash("sha256").update(secret).digest();
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	const b = (x: Buffer) => x.toString("base64url");
	return `enc:v1:${b(iv)}.${b(tag)}.${b(ciphertext)}`;
}

test("credential round-trip decrypts what ZCode's scheme encrypts", () => {
	const secret = deriveCredentialSecret({ platform: "linux", homedir: "/home/x", username: "u" });
	const token = "eyJhbGciOiJIUzI1NiJ9.payload.sig";
	assert.equal(decryptCredentialEnvelope(encryptEnvelope(token, secret), secret), token);
});

test("non-envelope values pass through untouched", () => {
	assert.equal(decryptCredentialEnvelope("plaintext-key", "any-secret"), "plaintext-key");
});

test("malformed envelopes throw with a clear error", () => {
	const secret = "s";
	assert.throws(() => decryptCredentialEnvelope("enc:v1:onlyonepart", secret));
	assert.throws(() => decryptCredentialEnvelope("enc:v1:!!notbase64!!.aa.bb", secret));
});

test("secret derivation prefers env, falls back to platform string", () => {
	assert.equal(
		deriveCredentialSecret({ envSecret: "custom", platform: "linux", homedir: "/h", username: "u" }),
		"custom",
	);
	assert.equal(
		deriveCredentialSecret({ platform: "linux", homedir: "/h", username: "u" }),
		"zcode-credential-fallback:linux:/h:u",
	);
	assert.equal(
		deriveCredentialSecret({ platform: "linux", homedir: "/h", username: "" }),
		"zcode-credential-fallback:linux:/h:unknown",
	);
});

test("identity headers carry the captured wire shape", () => {
	const token = "tok";
	const headers = buildZcodeHeaders({ appVersion: "3.16.3", userAgent: newUserAgent("3.16.3"), token });
	assert.match(headers["user-agent"] ?? "", /^ZCode\/3\.16\.3 ai-sdk\/provider-utils/);
	assert.equal(headers["x-zcode-app-version"], "3.16.3");
	assert.equal(headers["x-zcode-agent"], "glm");
	assert.equal(headers["http-referer"], "https://zcode.z.ai");
	assert.equal(headers["x-api-key"], token); // app sends the JWT here too
	assert.equal(headers["anthropic-version"], "2023-06-01");
	assert.match(headers["x-request-id"] ?? "", /^[0-9a-f-]{36}$/);
	assert.match(headers["x-session-id"] ?? "", /^session_[0-9a-f-]{36}$/);
});

test("platform headers derive from the running platform, like the app", () => {
	// App rule (zcode.cjs normalizeOsCategory / buildZCodeSourceHeadersFromContext).
	assert.equal(normalizeOsCategory("darwin"), "macos");
	assert.equal(normalizeOsCategory("win32"), "windows");
	assert.equal(normalizeOsCategory("linux"), "linux");
	assert.equal(normalizeOsCategory("freebsd"), "linux");

	// x-platform is ${process.platform}-${process.arch}; osCategory defaults
	// from the same platform when not passed.
	const headers = buildZcodeHeaders({ appVersion: "3.16.3", userAgent: "ua", token: "t" });
	assert.equal(headers["x-platform"], `${process.platform}-${process.arch}`);
	assert.equal(headers["x-os-category"], normalizeOsCategory(process.platform));
});

test("model request headers match the app's captured order and completeness", () => {
	const source: HeaderSource = {
		appVersion: "3.16.3",
		osCategory: "linux",
		userAgent: newUserAgent("3.16.3"),
		token: "jwt",
		osVersion: "7.2.11-200.fc44.x86_64",
	};
	const headers = buildModelRequestHeaders(source);
	const names = headers.map(([n]) => n.toLowerCase());
	// The app's captured order, anthropic-beta first.
	assert.deepEqual(
		names.slice(0, 4),
		["anthropic-beta", "anthropic-version", "authorization", "content-type"],
	);
	// Never present — fetch-style clients get blocked on these.
	for (const banned of ["accept", "accept-language", "sec-fetch-mode", "accept-encoding", "x-stainless-lang"]) {
		assert.ok(!names.includes(banned), `must not send ${banned}`);
	}
	const map = Object.fromEntries(headers);
	assert.equal(map["anthropic-beta"], "mid-conversation-system-2026-04-07");
	assert.equal(map["x-api-key"], "jwt");
	assert.equal(map["authorization"], "Bearer jwt");
	assert.equal(map["x-os-version"], "7.2.11-200.fc44.x86_64");
	assert.match(headers.find(([n]) => n === "x-session-id")?.[1] ?? "", /^session_[0-9a-f-]{36}$/u);
});

test("preset overlays the fallback pair, non-entitled entries drop", () => {
	const specs: Record<string, ZcodeModelSpec> = {
		"GLM-5.3-Flash": {
			reasoning: { enabled: true },
			limit: { context: 1_000_000, output: 128_000 },
			modalities: { input: ["text", "image", "video"] },
		},
		"GLM-4.7": { reasoning: { enabled: false } }, // not entitled — must drop
	};
	const configs = startPlanModelConfigs(specs);
	// GLM-5.3-Flash from the preset + GLM-5.3 kept from the fallback even
	// though the preset cache omitted it (it has before).
	assert.deepEqual(configs.map((m) => m.id), ["glm-5.3-flash", "glm-5.3"]);
	assert.deepEqual(configs[0]?.input, ["text", "image"]); // video is not a pi modality
	assert.equal(configs[0]?.cost.input, 0);
	assert.equal(configs[0]?.contextWindow, 1_000_000);
});

test("a preset spec wins over the fallback for the same model", () => {
	const configs = startPlanModelConfigs({
		"GLM-5.3": { limit: { context: 200_000, output: 64_000 } },
	});
	const glm53 = configs.find((m) => m.id === "glm-5.3");
	assert.equal(glm53?.contextWindow, 200_000);
});

test("transformRequestBody rewrites pi's adaptive thinking to the app's bare enabled, effort preserved", () => {
	const body: Record<string, unknown> = {
		model: "glm-5.3",
		thinking: { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } },
		output_config: { effort: "max" },
		messages: [{ role: "user", content: "hi" }],
	};
	const out = transformRequestBody(body, []);
	assert.deepEqual(out.thinking, { type: "enabled" });
	assert.deepEqual(out.output_config, { effort: "max" });
	assert.deepEqual(out.messages, body.messages);
	assert.deepEqual(body.thinking, { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } }, "input must not be mutated");

	// A stray budget path rewrites bare too (the gateway rejects budget_tokens).
	const budgeted = transformRequestBody({ thinking: { type: "enabled", budget_tokens: 16384, display: "summarized" } }, []);
	assert.deepEqual(budgeted.thinking, { type: "enabled" });

	// pi never requests off (hidden); a stray disabled param drops instead of leaking —
	// undefined-valued keys vanish at stringify, same wire as absent.
	const dropped = transformRequestBody({ thinking: { type: "disabled" }, output_config: {} }, []);
	assert.ok(!("thinking" in JSON.parse(JSON.stringify(dropped))));

	// Non-thinking bodies pass through untouched.
	const out2 = transformRequestBody({ messages: [] }, []);
	assert.deepEqual(JSON.parse(JSON.stringify(out2)), { messages: [] });
});

test("transformRequestBody applies system relocation and thinking rules as one wire reshape", () => {
	const preamble: SystemBlock[] = [{ type: "text", text: "app preamble" }];
	const out = transformRequestBody(
		{
			system: [{ type: "text", text: "pi's system" }],
			messages: [{ role: "user", content: "hi" }],
			thinking: { type: "adaptive", display: "summarized" },
			output_config: { effort: "high" },
		},
		preamble,
	);
	assert.deepEqual(out.system, preamble, "preamble stands alone at top level");
	assert.deepEqual(out.messages, [
		{ role: "system", content: [{ type: "text", text: "pi's system" }] },
		{ role: "user", content: "hi" },
	]);
	assert.deepEqual(out.thinking, { type: "enabled" });
});

test("empty or missing presets fall back to the known start-plan pair", () => {
	assert.deepEqual(startPlanModelConfigs(undefined).map((m) => m.id), ["glm-5.3-flash", "glm-5.3"]);
	assert.deepEqual(startPlanModelConfigs({}).map((m) => m.id), ["glm-5.3-flash", "glm-5.3"]);
});

test("thinking levels match the app's effort variants: low, high, max via output_config", () => {
	// Captured from the ZCode app and canonically published on models.dev:
	// effort values [low, high, max], never budget_tokens. pi must take the
	// effort path, not the budget path.
	const configs = startPlanModelConfigs(undefined);
	for (const model of configs) {
		assert.equal(model.compat.forceAdaptiveThinking, true);
		assert.equal(model.thinkingLevelMap?.off, null, "the plan exposes no off");
	}
	const glm53 = configs.find((m) => m.id === "glm-5.3");
	assert.deepEqual(glm53?.thinkingLevelMap, {
		off: null,
		minimal: null,
		low: "low",
		medium: null,
		high: "high",
		xhigh: null,
		max: "max",
	});
});

test("effort variants map identity per pi-zen's buildThinkingLevelMap rule", () => {
	assert.deepEqual(thinkingLevelMapFor({ reasoning: { enabled: true, variants: ["low", "max", "high"] } }), {
		off: null,
		minimal: null,
		low: "low",
		medium: null,
		high: "high",
		xhigh: null,
		max: "max",
	});
	// Partial lists map identity and hide the rest — high never derives from max.
	const partial = thinkingLevelMapFor({ reasoning: { enabled: true, variants: ["high", "max"] } });
	assert.equal(partial.low, null);
	assert.equal(partial.high, "high");
	assert.equal(partial.max, "max");
	// "none" means off where a plan actually allows disabling.
	assert.equal(thinkingLevelMapFor({ reasoning: { enabled: true, variants: ["none", "low"] } }).off, "none");
	// Unknown variant shapes fall back to the canonical trio instead of guessing.
	assert.equal(thinkingLevelMapFor({ reasoning: { enabled: true, variants: ["enabled", "off"] } }).high, "high");
	assert.equal(thinkingLevelMapFor(undefined).high, "high");
});
