import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	buildLeanerInput,
	isLearnableMessage,
	LEARNER_SYSTEM_PROMPT,
	LEARNER_TOOLS,
	resolveTasteModel,
	runLearner,
	runTasteTool,
	stripReasoning,
} from "../learner.ts";
import type { StorePaths } from "../types.ts";

function store(root: string): StorePaths {
	return { dir: join(root, ".pi", "taste"), taste: join(root, ".pi", "taste", "taste.md"), lock: join(root, ".pi", "taste", ".lock"), scope: "project", projectRoot: root };
}

function stoppedResponse() {
	return {
		role: "assistant",
		content: [{ type: "text", text: "no changes" }],
		api: "test",
		provider: "test",
		model: "model-x",
		usage: { input: 1, output: 1, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
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

test("conversation normalization strips reasoning and includes optional session summary", () => {
	const unchanged = { role: "user", content: [{ type: "text", text: "hello" }] };
	assert.equal(stripReasoning(unchanged), unchanged);
	const stripped = stripReasoning({
		role: "assistant",
		content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "visible" }],
	});
	assert.deepEqual(stripped.content, [{ type: "text", text: "visible" }]);
	const input = buildLeanerInput(
		{ userText: "", assistantText: "" },
		"(empty)",
		[],
		[{ role: "assistant", content: [{ type: "text", text: "visible" }] }],
		"Compacted context",
	);
	assert.match(input, /Session summary:\nCompacted context/);
});

test("Taste tools expose Pi parameters and return bounded errors", async () => {
	for (const tool of LEARNER_TOOLS) {
		assert.equal(tool.parameters.type, "object");
		assert.ok(tool.parameters.properties);
		assert.equal("input_schema" in tool, false);
	}
	const root = await mkdtemp(join(tmpdir(), "pi-taste-tool-errors-"));
	try {
		const paths = store(root);
		await mkdir(paths.dir, { recursive: true });
		assert.equal(await runTasteTool(paths, "read_taste_file", { path: "missing/taste.md" }), "(file does not exist)");
		assert.match(await runTasteTool(paths, "unknown", { path: "taste.md" }), /unknown tool/);
		assert.match(await runTasteTool(paths, "write_taste_file", { path: "bad:windows/taste.md", content: "x" }), /must be/);
		assert.match(await runTasteTool(paths, "edit_taste_file", { path: "taste.md", old_text: "x", new_text: "y" }), /does not exist/);
		await writeFile(paths.taste, "- Existing. Confidence: 1.0\n");
		assert.match(await runTasteTool(paths, "edit_taste_file", { path: "taste.md", old_text: "absent", new_text: "y" }), /old_text not found/);
		assert.match(await runTasteTool(paths, "read_taste_file", { path: "../outside" }), /inside the taste directory/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("resolveTasteModel honors custom order and never falls back silently", () => {
	const inherited = { provider: "main", id: "model", reasoning: true };
	const unavailable = { provider: "custom", id: "unauth", reasoning: false, authenticated: false };
	const available = { provider: "custom", id: "ready", reasoning: false, authenticated: true };
	const ctx = {
		model: inherited,
		modelRegistry: {
			find: (provider: string, id: string) => [unavailable, available].find((model) => model.provider === provider && model.id === id),
			hasConfiguredAuth: (model: any) => model?.authenticated !== false,
		},
	} as any;
	const { config } = fakeContext();
	assert.equal(resolveTasteModel(ctx, config), inherited);
	config.observer.modelMode = "custom";
	config.observer.models = [
		{ provider: "custom", model: "unauth" },
		{ provider: "custom", model: "ready" },
	];
	assert.equal(resolveTasteModel(ctx, config), available);
	config.observer.models = [{ provider: "custom", model: "unauth" }];
	assert.equal(resolveTasteModel(ctx, config), undefined);
	assert.equal(resolveTasteModel(ctx, config, { provider: "custom", model: "ready" }), available);
});

test("runLearner reports unavailable models and provider stop errors", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-taste-learn-errors-"));
	try {
		const paths = store(root);
		const { config } = fakeContext();
		const noModel = {
			model: undefined,
			modelRegistry: { hasConfiguredAuth: () => false, find: () => undefined },
		} as any;
		await assert.rejects(
			() => runLearner(noModel, config, paths, { userText: "x", assistantText: "y" }, [], [], [], true),
			/No Taste Learner model/,
		);
		const failed = {
			model: { provider: "test", id: "model-x" },
			modelRegistry: {
				hasConfiguredAuth: () => true,
				complete: async () => ({ ...stoppedResponse(), stopReason: "error", errorMessage: "upstream failed" }),
			},
		} as any;
		await assert.rejects(
			() => runLearner(failed, config, paths, { userText: "x", assistantText: "y" }, [], [], [], true),
			/upstream failed/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("LEARNER_SYSTEM_PROMPT mirrors Command Code durable-only policy", () => {
	assert.match(LEARNER_SYSTEM_PROMPT, /durable, generalizable preferences/i);
	assert.match(LEARNER_SYSTEM_PROMPT, /Learn ONLY from the NEW messages/i);
	assert.match(LEARNER_SYSTEM_PROMPT, /Confidence:/);
});
