import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTokens, parseZcodeBalance } from "../usage.ts";

// Fixtures mirror the real billing/balance envelope (captured from the
// desktop app via mitmproxy): { code, msg, data: { balances: [...] } }.

const SAMPLE = {
	code: 0,
	msg: "",
	data: {
		server_time: 1792810751,
		plans: [{ plan_id: "zcode-v3-start-plan-1024", status: "active" }],
		balances: [
			{
				bucket_id: "bucket_1",
				show_name: "GLM-5.3-Flash",
				total_units: 300000000,
				used_units: 85403,
				remaining_units: 299914597,
				expires_at: 1792976400,
			},
			{
				bucket_id: "bucket_2",
				show_name: "GLM-5.3",
				total_units: 200000000,
				used_units: 100000000,
				remaining_units: 100000000,
				expires_at: 1792976400,
			},
		],
	},
};

test("parseZcodeBalance: one window per bucket, percent from units", () => {
	const windows = parseZcodeBalance(SAMPLE);
	assert.equal(windows.length, 2);
	assert.deepEqual(
		windows.map((w) => w.label),
		["GLM-5.3-Flash", "GLM-5.3"],
	);
	// 85403 / 300000000 — far below 10%, so the sub-1% precision path matters.
	assert.ok((windows[0]?.usedPercent ?? 0) > 0 && (windows[0]?.usedPercent ?? 1) < 0.1);
	assert.equal(windows[1]?.usedPercent, 50);
	assert.equal(windows[0]?.statusLabel, "299.9M left");
	assert.ok(windows[0]?.resetAt instanceof Date);
});

test("parseZcodeBalance: skips buckets without a usable total", () => {
	const windows = parseZcodeBalance({
		data: {
			balances: [
				{ show_name: "X", used_units: 5 },
				{ show_name: "Y", total_units: 0, used_units: 0 },
				null,
			],
		},
	});
	assert.equal(windows.length, 0);
});

test("parseZcodeBalance: tolerates garbage", () => {
	assert.deepEqual(parseZcodeBalance(undefined), []);
	assert.deepEqual(parseZcodeBalance("nope"), []);
	assert.deepEqual(parseZcodeBalance({ data: {} }), []);
});

test("parseZcodeBalance: exhausted bucket reads as limited", () => {
	const windows = parseZcodeBalance({
		data: { balances: [{ show_name: "GLM-5.3", total_units: 100, used_units: 100, remaining_units: 0 }] },
	});
	assert.equal(windows[0]?.statusLabel, "limited");
	assert.equal(windows[0]?.usedPercent, 100);
});

test("formatTokens: humanized buckets", () => {
	assert.equal(formatTokens(299914597), "299.9M");
	assert.equal(formatTokens(200000000), "200M");
	assert.equal(formatTokens(1_500_000), "1.5M");
	assert.equal(formatTokens(1_200_000_000), "1.2B");
	assert.equal(formatTokens(9000), "9K");
});
