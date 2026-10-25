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

test("parseZcodeBalance: reports the effective bucket per model when plans stack", () => {
	// Real shape: trial + "1024 Dev Day" both expose GLM-5.3 buckets. The
	// gateway draws from the highest-priority bucket with units left — an
	// exhausted trial must not read "limited" while the 1024 plan funds it.
	const twoPlans = {
		code: 0,
		data: {
			plans: [
				{ plan_id: "zcode-v3-start-plan", name: "ZCode Start Plan", status: "active" },
				{ plan_id: "zcode-v3-start-plan-1024", name: "ZCode 1024 Dev Day", status: "active" },
			],
			balances: [
				// Trial: GLM-5.3 exhausted, Flash nearly full — both shadowed.
				{ plan_id: "zcode-v3-start-plan", capabilities: ["model:glm-5.3"], plan_priority: 100, show_name: "GLM-5.3", total_units: 3_000_000, used_units: 3_000_000, remaining_units: 0, expires_at: 1792976400 },
				{ plan_id: "zcode-v3-start-plan", capabilities: ["model:glm-5.3-flash"], plan_priority: 100, show_name: "GLM-5.3-Flash", total_units: 5_000_000, used_units: 300_000, remaining_units: 4_700_000, expires_at: 1792976400 },
				// 1024 plan: funded, higher priority — the effective buckets.
				{ plan_id: "zcode-v3-start-plan-1024", capabilities: ["model:glm-5.3-flash"], plan_priority: 101, show_name: "GLM-5.3-Flash", total_units: 300_000_000, used_units: 21_000_000, remaining_units: 279_000_000, expires_at: 1792976400 },
				{ plan_id: "zcode-v3-start-plan-1024", capabilities: ["model:glm-5.3"], plan_priority: 101, show_name: "GLM-5.3", total_units: 200_000_000, used_units: 19_000_000, remaining_units: 181_000_000, expires_at: 1792976400 },
			],
		},
	};
	const windows = parseZcodeBalance(twoPlans);
	// One effective window per model; shadowed buckets don't render.
	assert.deepEqual(windows.map((w) => w.label), ["GLM-5.3-Flash", "GLM-5.3"]);
	assert.equal(Math.round(windows[0]?.usedPercent ?? -1), 7);
	assert.equal(windows[1]?.usedPercent, 9.5);
	// Nothing reads limited while funded buckets cover every model.
	assert.ok(windows.every((w) => w.statusLabel !== "limited"));

	// Higher-priority plan empties: the next plan's bucket becomes effective.
	const fallback = structuredClone(twoPlans);
	for (const b of fallback.data.balances) {
		if (b.plan_id === "zcode-v3-start-plan-1024") {
			b.used_units = b.total_units;
			b.remaining_units = 0;
		}
	}
	const downgraded = parseZcodeBalance(fallback);
	assert.deepEqual(downgraded.map((w) => w.label), ["Start Plan · GLM-5.3-Flash", "1024 Dev Day · GLM-5.3"]);
	// Flash falls to the trial's funded bucket; GLM-5.3 is empty everywhere,
	// so its highest-priority bucket truthfully reports limited.
	assert.notEqual(downgraded[0]?.statusLabel, "limited");
	assert.equal(downgraded[1]?.statusLabel, "limited");

	// Every bucket empty: the highest-priority bucket reports limited.
	const empty = structuredClone(twoPlans);
	for (const b of empty.data.balances) {
		b.used_units = b.total_units;
		b.remaining_units = 0;
	}
	const limited = parseZcodeBalance(empty);
	// Only the highest-priority plan's buckets display, so labels stay short.
	assert.deepEqual(limited.map((w) => w.label), ["GLM-5.3-Flash", "GLM-5.3"]);
	assert.ok(limited.every((w) => w.statusLabel === "limited"));
});
