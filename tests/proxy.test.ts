import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { startZcodeTransformProxy } from "../proxy.ts";
import { newUserAgent } from "../shared.ts";

test("proxy forwards to the app's shape end-to-end", async () => {
	// Upstream origin includes a path prefix, like /api/v1/zcode-plan/anthropic —
	// the 404 regression hid here once: the proxy must join it, not drop it.
	const capturedRef: { current?: { path: string; headers: Record<string, string>; body: string } } = {};
	const upstream = createServer((req: IncomingMessage, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			capturedRef.current = { path: req.url ?? "", headers: req.headers as Record<string, string>, body };
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write("event: ping\ndata: {}\n\n");
			res.end();
		});
	});
	await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
	const upstreamPort = (upstream.address() as { port: number }).port;

	const proxy = await startZcodeTransformProxy({
		upstreamOrigin: `http://127.0.0.1:${upstreamPort}/api/v1/zcode-plan/anthropic`,
		appVersion: "3.16.3",
		osCategory: "linux",
		userAgent: newUserAgent("3.16.3"),
		token: "test-jwt",
	});

	try {
		const piRequest = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
			const req = httpRequest(`http://127.0.0.1:${proxy.port}/v1/messages?beta=true`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-stainless-runtime": "node",
					"anthropic-dangerous-direct-browser-access": "true",
					"anthropic-beta": "interleaved-thinking-2025-05-14",
					"authorization": "Bearer test-jwt",
					"accept": "application/json",
				},
			}, (res) => {
				let body = "";
				res.on("data", (c) => (body += c));
				res.on("end", () => resolve({ status: res.statusCode, body }));
			});
			req.on("error", reject);
			req.end(JSON.stringify({ model: "glm-5.3-flash", max_tokens: 16, messages: [{ role: "user", content: "Hi" }] }));
		});
		assert.equal(piRequest.status, 200);
		assert.match(piRequest.body, /event: ping/);

		const seen: { path: string; headers: Record<string, string>; body: string } | undefined = capturedRef.current;
	assert.ok(seen, "upstream saw no request");
		assert.equal(seen.path, "/api/v1/zcode-plan/anthropic/v1/messages", "origin path prefix must survive");
		assert.ok(!("x-stainless-runtime" in seen.headers), "stainless must be stripped");
		assert.ok(!("anthropic-dangerous-direct-browser-access" in seen.headers));
		// fetch re-adds these when absent; the upstream hop uses native http
		// precisely so they stay absent, like the app's request.
		for (const banned of ["accept", "accept-language", "sec-fetch-mode", "accept-encoding"]) {
			assert.ok(!(banned in seen.headers), `must not forward ${banned}`);
		}
		assert.equal(seen.headers["anthropic-beta"], "mid-conversation-system-2026-04-07");
		assert.equal(seen.headers["x-api-key"], "test-jwt");
		assert.equal(seen.headers["authorization"], "Bearer test-jwt");
		assert.match(seen.headers["user-agent"] ?? "", /^ZCode\/3\.16\.3/);
		assert.match(seen.body, /glm-5\.3-flash/);
	} finally {
		proxy.close();
		await new Promise<void>((resolve, reject) => upstream.close((err) => (err ? reject(err) : resolve())));
	}
});

test("proxy injects the ZCode system preamble into pi requests", async () => {
	let seenSystem: unknown = undefined;
	const upstream = createServer((req: IncomingMessage, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
			seenSystem = parsed.system;
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{}");
		});
	});
	await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
	const upstreamPort = (upstream.address() as { port: number }).port;

	const proxy = await startZcodeTransformProxy({
		upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
		appVersion: "3.16.3",
		osCategory: "linux",
		userAgent: newUserAgent("3.16.3"),
		token: "test-jwt",
	});

	try {
		const status = await new Promise<number | undefined>((resolve, reject) => {
			const req = httpRequest(`http://127.0.0.1:${proxy.port}/v1/messages`, {
				method: "POST",
				headers: { "content-type": "application/json", "authorization": "Bearer test-jwt" },
			}, (res) => {
				res.on("data", () => {});
				res.on("end", () => resolve(res.statusCode));
			});
			req.on("error", reject);
			req.end(JSON.stringify({
				model: "glm-5.3-flash",
				max_tokens: 16,
				stream: false,
				system: [{ type: "text", text: "pi's own system prompt" }],
				messages: [{ role: "user", content: "Hi" }],
			}));
		});
		assert.equal(status, 200);
		assert.ok(Array.isArray(seenSystem) && seenSystem.length === 3, "preamble two blocks + pi block");
		assert.match((seenSystem as { text: string }[])[0]?.text ?? "", /You are ZCode/);
		assert.match((seenSystem as { text: string }[])[1]?.text ?? "", /You are an interactive ZCode agent/);
		assert.equal((seenSystem as { text: string }[])[2]?.text, "pi's own system prompt");
	} finally {
		proxy.close();
		await new Promise<void>((resolve, reject) => upstream.close((err) => (err ? reject(err) : resolve())));
	}
});

test("setToken rotates the upstream credential on the next request", async () => {
	const authSeen: string[] = [];
	const upstream = createServer((req: IncomingMessage, res) => {
		req.on("data", () => {});
		req.on("end", () => {
			authSeen.push(String(req.headers["x-api-key"]));
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{}");
		});
	});
	await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
	const port = (upstream.address() as { port: number }).port;

	const proxy = await startZcodeTransformProxy({
		upstreamOrigin: `http://127.0.0.1:${port}`,
		appVersion: "3.16.3",
		osCategory: "linux",
		userAgent: newUserAgent("3.16.3"),
		token: "jwt-old",
	});

	try {
		const send = () => new Promise<number | undefined>((resolve, reject) => {
			const req = httpRequest(`http://127.0.0.1:${proxy.port}/v1/messages`, {
				method: "POST",
				headers: { "content-type": "application/json", "authorization": "Bearer whatever" },
			}, (res) => {
				res.on("data", () => {});
				res.on("end", () => resolve(res.statusCode));
			});
			req.on("error", reject);
			req.end("{}");
		});
		await send();
		proxy.setToken("jwt-new");
		await send();
		assert.deepEqual(authSeen, ["jwt-old", "jwt-new"], "upstream x-api-key must follow setToken");
	} finally {
		proxy.close();
		await new Promise<void>((resolve, reject) => upstream.close((err) => (err ? reject(err) : resolve())));
	}
});
