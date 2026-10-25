import assert from "node:assert/strict";
import { test } from "node:test";
import { injectSystemPreamble, relocateSystemToMessages, type SystemBlock } from "../shared.ts";

const preamble: SystemBlock[] = [
	{ type: "text", text: "You are ZCode, an interactive coding agent" },
];

test("relocate: text system moves into a leading system message, preamble stays top-level", () => {
	const out = relocateSystemToMessages("You are an expert assistant.", [], preamble);
	assert.deepEqual(out.system, preamble);
	const msgs = out.messages as Array<{ role: string; content: unknown }>;
	assert.equal(msgs.length, 1);
	assert.equal(msgs[0]?.role, "system");
	assert.deepEqual(msgs[0]?.content, [{ type: "text", text: "You are an expert assistant." }]);
});

test("relocate: array system moves block-for-block, order preserved", () => {
	const system: SystemBlock[] = [
		{ type: "text", text: "part one" },
		{ type: "text", text: "part two" },
	];
	const messages = [{ role: "user", content: [{ type: "text", text: "Hi" }] }];
	const out = relocateSystemToMessages(system, messages, preamble);
	assert.deepEqual(out.system, preamble);
	const msgs = out.messages as Array<{ role: string; content: Array<{ text: string }> }>;
	assert.equal(msgs.length, 2);
	assert.equal(msgs[0]?.role, "system");
	assert.equal(msgs[0]?.content[0]?.text, "part one");
	assert.equal(msgs[0]?.content[1]?.text, "part two");
	assert.equal(msgs[1]?.role, "user");
});

test("relocate: merges into an existing leading system message", () => {
	const messages = [
		{ role: "system", content: [{ type: "text", text: "existing system note" }] },
		{ role: "user", content: [{ type: "text", text: "Hi" }] },
	];
	const out = relocateSystemToMessages("new system", messages, preamble);
	const msgs = out.messages as Array<{ role: string; content: Array<{ text: string }> }>;
	assert.equal(msgs.length, 2);
	assert.equal(msgs[0]?.role, "system");
	assert.deepEqual(
		(msgs[0]?.content ?? []).map((b) => b.text),
		["new system", "existing system note"],
	);
	assert.equal(msgs[1]?.role, "user");
});

test("relocate: empty caller system keeps preamble-only top level", () => {
	const out = relocateSystemToMessages("", [], preamble);
	assert.deepEqual(out.system, preamble);
	assert.deepEqual(out.messages, []);
});

test("relocate: without preamble falls back to inject semantics", () => {
	const out = relocateSystemToMessages("sys", [], []);
	assert.deepEqual(out.system, injectSystemPreamble("sys", []));
});
