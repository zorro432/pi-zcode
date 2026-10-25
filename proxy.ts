// Local transform proxy: pi -> 127.0.0.1 (plain http) -> zcode.z.ai.
//
// pi's Anthropic client injects Stainless headers and the ?beta=true query
// the ZCode gateway's WAF flags. The proxy rebuilds each request to the
// desktop app's captured shape — ordered native-https upstream, no fetch
// (fetch re-adds spec headers the app never sends).

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect as tlsConnect } from "node:tls";
import { Agent as HttpsAgent } from "node:https";
import { buildModelRequestHeaders, transformRequestBody, type HeaderSource, type SystemBlock } from "./shared.ts";

export interface TransformProxy {
	port: number;
	/** Point the upstream Authorization at a rotated JWT; takes effect next request. */
	setToken(token: string): void;
	close(): void;
}

// Debug-only upstream chain through a CONNECT proxy (mitmproxy), so the
// transformed request can be inspected. Inert unless ZCODE_HTTPS_PROXY is set.
class ConnectTunnelAgent extends HttpsAgent {
	private readonly proxyUrl: string;
	constructor(proxyUrl: string) {
		super();
		this.proxyUrl = proxyUrl;
	}
	// Callback-pending creation: node's Agent types allow returning null with
	// the socket arriving via cb.
	override createConnection(
		options: Parameters<HttpsAgent["createConnection"]>[0],
		cb: (err: Error | null, socket?: unknown) => void,
	): null {
		const target = `${options.host}:${options.port ?? 443}`;
		const proxy = new URL(this.proxyUrl);
		const req = httpRequest({
			host: proxy.hostname,
			port: Number(proxy.port ?? 8080),
			method: "CONNECT",
			path: target,
			headers: { host: target },
		});
		req.on("connect", (res, socket) => {
			if (res.statusCode !== 200) {
				cb(new Error(`CONNECT failed: ${res.statusCode}`));
				socket.destroy();
				return;
			}
			const tls = tlsConnect({ socket, servername: options.host ?? undefined });
			tls.once("secureConnect", () => cb(null, tls));
			tls.once("error", (err) => cb(err));
		});
		req.on("error", (err) => cb(err));
		req.end();
		return null;
	}
}

export async function startZcodeTransformProxy(input: HeaderSource & {
	upstreamOrigin: string;
}): Promise<TransformProxy> {
	const upstream = new URL(input.upstreamOrigin);
	const secure = upstream.protocol === "https:";
	const debugProxy = process.env.ZCODE_HTTPS_PROXY;
	const agent = secure && debugProxy ? new ConnectTunnelAgent(debugProxy) : undefined;

	// Headers stamp per request; the token is read through this indirection so
	// setToken() applies without rebuilding the proxy.
	let currentToken = input.token;

	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const preambleFile = join(moduleDir, "wire-preamble.json");
	let preambleCache: SystemBlock[] | null = null;
	function loadPreamble(): SystemBlock[] {
		if (preambleCache) return preambleCache;
		try {
			const parsed = JSON.parse(readFileSync(preambleFile, "utf-8")) as { blocks?: SystemBlock[] };
			// The captured text embeds the capturing machine's visualization dir
			// as {{ZCODE_VISUALIZATION_DIR}}; fill it in per session so the file
			// carries no machine-specific paths.
			const visDir = join(homedir(), ".zcode", "v2", "visualizations", input.sessionId?.replace(/-/g, "") || "session");
			preambleCache = (parsed.blocks ?? []).map((b) => ({
				...b,
				text: b.text.split("{{ZCODE_VISUALIZATION_DIR}}").join(visDir),
			}));
		} catch {
			preambleCache = [];
		}
		return preambleCache;
	}

	const server = createServer((req, res) => {
		req.on("error", () => {});
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			forward(req, res, chunks).catch(() => {
				if (!res.headersSent) res.writeHead(502);
				res.end();
			});
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const port = (server.address() as { port: number }).port;

	function close() {
		server.closeAllConnections();
		server.close();
		agent?.destroy();
	}

	async function forward(req: IncomingMessage, res: ServerResponse, chunks: Buffer[]) {
		// The gateway's WAF scores the top-level system field additively; big
		// multi-section systems trip "unusual activity" even though the same
		// text passes inside messages (proven by bisect). Relocate pi's system
		// into a leading role:"system" message — the desktop app's own wire
		// shape (mid-conversation-system beta) — keeping the app's preamble as
		// the top-level system.
		let body = Buffer.concat(chunks);
		try {
			const parsed = JSON.parse(body.toString("utf-8")) as Record<string, unknown>;
			if (parsed && typeof parsed === "object") {
				body = Buffer.from(JSON.stringify(transformRequestBody(parsed, loadPreamble())), "utf-8");
			}
		} catch {
			// Non-JSON body: forward as-is.
		}
		// pi appends ?beta=true and the /v1/messages path; the upstream origin
		// already carries the plan route prefix (/api/v1/zcode-plan/anthropic).
		const inPath = ((req.url ?? "/").split("?")[0] ?? "/");
		const path = `${upstream.pathname.replace(/\/$/, "")}${inPath}${upstream.search}`;
		// The app's set, in its captured order — no accept/accept-language/
		// sec-fetch-mode/accept-encoding, Connection: close like the app.
		const headers = Object.fromEntries(buildModelRequestHeaders({ ...input, token: currentToken })) as Record<string, string>;
		headers["connection"] = "close";
		if (body.length > 0) headers["content-length"] = String(body.length);

		const upstreamReq = (secure ? httpsRequest : httpRequest)({
			hostname: upstream.hostname,
			port: upstream.port || (secure ? 443 : 80),
			path,
			method: "POST",
			headers,
			...(agent ? { agent } : {}),
		});
		upstreamReq.on("response", (upRes) => {
			const out: Record<string, string> = {};
			for (const [n, v] of Object.entries(upRes.headers)) {
				if (["transfer-encoding", "connection", "content-length"].includes(n)) continue;
				if (typeof v === "string") out[n] = v;
			}
			res.writeHead(upRes.statusCode ?? 502, out);
			upRes.pipe(res);
		});
		upstreamReq.on("error", () => {
			if (!res.headersSent) res.writeHead(502);
			res.end();
		});
		if (body.length > 0) upstreamReq.write(body);
		upstreamReq.end();
	}

	return { port, close, setToken: (token: string) => { currentToken = token; } };
}
