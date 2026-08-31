import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildLeanerInput, isLearnableMessage, LEARNER_SYSTEM_PROMPT, runLearner } from "../learner.ts";
import type { StorePaths } from "../types.ts";

function store(root: string): StorePaths {
	return { dir: join(root, ".pi", "taste"), taste: join(root, ".pi", "taste", "taste.md"), lock: join(root, ".pi", "taste", ".lock"), scope: "project", projectRoot: root };
}

function fakeContext() {
	const calls: any[] = [];
	return {
		ctx: {
			model: { provider: "test", id: "model-x", reasoning: true },
			modelRegistry: {
				hasConfiguredAuth: () => true,
				find: () => ({ provider: "test", id: "model-x", reasoning: true }),
				complete: async (_model: any, context: any, options: any) => {
					calls.push({ context, options });
					const messages = context.messages as any[];
					const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
					if (lastAssistant && lastAssistant.content?.some((c: any) => c?.type === "toolCall")) {
						return {
							role: "assistant",
							content: [{ type: "text", text: "no changes" }],
							api: "test",
							provider: "test",
							model: "model-x",
							usage: { input: 10, output: 5, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
							stopReason: "stop",
							timestamp: Date.now(),
						};
					}
					return {
						role: "assistant",
						content: [{ type: "toolCall", id: "call-1", name: "write_taste_file", arguments: { path: "taste.md", content: "- Use tabs. Confidence: 0.8\n" } }],
						api: "test",
						provider: "test",
						model: "model-x",
						usage: { input: 10, output: 5, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
						stopReason: "toolUse",
						timestamp: Date.now(),
					};
				},
			},
			scopedModels: [],
		} as any,
		config: {
			version: 3,
			learningEnabled: true,
			observer: { modelMode: "inherit", models: [], reasoning: "low", maxOutputTokens: 6000, timeoutMs: 90_000, maxInputChars: 30_000 },
			injection: { maxChars: 16_000 },
		} as any,
		calls,
	};
}

test("isLearnableMessage excludes tool results, meta, and summary", () => {
	assert.equal(isLearnableMessage({ role: "user", content: [{ type: "text", text: "hello" }], meta: { source: "user" } }), true);
	assert.equal(isLearnableMessage({ role: "user", content: [{ type: "toolResult" }] }), false);
	assert.equal(isLearnableMessage({ role: "toolResult", content: [{ type: "text", text: "secret output" }] }), false);
	assert.equal(isLearnableMessage({ role: "user", content: [{ type: "text", text: "x" }], meta: { isAutomated: true } }), false);
	assert.equal(isLearnableMessage({ role: "user", content: [{ type: "text", text: "x" }], meta: { isSummary: true } }), false);
});

test("buildLeanerInput includes taste structure and new-message split", () => {
	const input = buildLeanerInput(
		{ userText: "以后用 tabs", assistantText: "好的" },
		"taste.md (1 learnings)",
		[{ role: "assistant", content: [{ type: "text", text: "old" }] }],
		[{ role: "user", content: [{ type: "text", text: "以后用 tabs" }], meta: { source: "user" } }],
	);
	assert.match(input, /Previously analyzed conversation/);
	assert.match(input, /NEW messages to analyze/);
	assert.match(input, /taste\.md \(1 learnings\)/);
	assert.match(input, /以后用 tabs/);
	assert.match(input, /好的/);
});

test("buildLeanerInput falls back to InteractionContext for an empty NEW message array", () => {
	const input = buildLeanerInput(
		{ userText: "性能测试不要依赖人工进游戏", assistantText: "会建立量化测量台" },
		"taste.md (empty)",
		[{ role: "toolResult", content: [{ type: "text", text: "must not leak" }] }],
		[],
	);
	assert.match(input, /性能测试不要依赖人工进游戏/);
	assert.match(input, /会建立量化测量台/);
	assert.doesNotMatch(input, /must not leak/);
	assert.doesNotMatch(input, /NEW messages to analyze[^]*\[\]/);
});

test("runLearner executes model tool calls and writes taste.md", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-taste-learn-"));
	try {
		const paths = store(root);
		await mkdir(paths.dir, { recursive: true });
		const { ctx, config, calls } = fakeContext();
		const result = await runLearner(
			ctx,
			config,
			paths,
			{ userText: "以后用 tabs", assistantText: "好的" },
			[],
			[{ role: "user", content: [{ type: "text", text: "以后用 tabs" }], meta: { source: "user" } }],
			[],
			true,
		);
		assert.equal(result.changes.length >= 1, true);
		const content = await readFile(paths.taste, "utf8");
		assert.match(content, /Use tabs/);
		assert.match(content, /Confidence: 0\.8/);
		assert.equal(calls.length >= 1, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("LEARNER_SYSTEM_PROMPT mirrors Command Code durable-only policy", () => {
	assert.match(LEARNER_SYSTEM_PROMPT, /durable, generalizable preferences/i);
	assert.match(LEARNER_SYSTEM_PROMPT, /Learn ONLY from the NEW messages/i);
	assert.match(LEARNER_SYSTEM_PROMPT, /Confidence:/);
});
