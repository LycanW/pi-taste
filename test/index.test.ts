import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import tasteExtension, { buildTasteSection } from "../index.ts";
import { globalStorePaths, loadConfig, loadPreferences, projectStorePaths } from "../storage.ts";

function stoppedResponse() {
	return {
		role: "assistant",
		content: [{ type: "text", text: "no changes" }],
		api: "test",
		provider: "test",
		model: "model-x",
		usage: {
			input: 10,
			output: 5,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

interface HarnessOptions {
	mode?: "rpc" | "tui";
	complete?: (model: any, context: any, options: any) => Promise<any>;
	confirm?: boolean;
}

async function createHarness(options: HarnessOptions = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-taste-index-"));
	const previousTasteDir = process.env.PI_TASTE_DIR;
	process.env.PI_TASTE_DIR = join(root, "global-taste");
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, any>();
	const entries: any[] = [];
	const notifications: Array<{ text: string; level: string }> = [];
	const branch: any[] = [];
	const models = [
		{ provider: "test", id: "model-x", reasoning: true },
		{ provider: "other", id: "model-y", reasoning: false },
	];
	const pi = {
		on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerEntryRenderer: () => {},
		appendEntry: (type: string, data: any) => entries.push({ type, data }),
	} as any;
	await tasteExtension(pi);
	const ctx = {
		cwd: root,
		mode: options.mode ?? "rpc",
		model: models[0],
		thinkingLevel: "low",
		modelRegistry: {
			hasConfiguredAuth: (model: any) => model?.authenticated !== false,
			find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
			getAvailable: () => models,
			complete: options.complete ?? (async () => stoppedResponse()),
		},
		scopedModels: [],
		sessionManager: {
			getBranch: () => branch,
			getSessionId: () => "test-session",
			getSessionFile: () => undefined,
			getEntries: () => branch,
			getCwd: () => root,
			getSessionName: () => undefined,
		},
		getContextUsage: () => ({ contextWindow: 128_000, percent: 10 }),
		ui: {
			notify: (text: string, level: string) => notifications.push({ text, level }),
			confirm: async () => options.confirm ?? true,
			select: async () => undefined,
			custom: async () => undefined,
			setFooter: () => {},
		},
	} as any;
	return {
		root,
		globalDir: process.env.PI_TASTE_DIR,
		handlers,
		commands,
		entries,
		notifications,
		branch,
		ctx,
		async command(args: string) {
			await commands.get("taste").handler(args, ctx);
		},
		async cleanup() {
			if (previousTasteDir === undefined) delete process.env.PI_TASTE_DIR;
			else process.env.PI_TASTE_DIR = previousTasteDir;
			await rm(root, { recursive: true, force: true });
		},
	};
}

test("agent_settled sends current user/assistant messages and writes Project Taste", async () => {
	let learnerPrompt = "";
	let learnerCalls = 0;
	const harness = await createHarness({
		complete: async (_model, context) => {
			learnerPrompt = context.messages[0].content[0].text;
			learnerCalls += 1;
			if (learnerCalls === 1) {
				return {
					...stoppedResponse(),
					content: [{
						type: "toolCall",
						id: "call-1",
						name: "write_taste_file",
						arguments: { path: "taste.md", content: "- Prefer quantitative benchmarks. Confidence: 1.0\n" },
					}],
					stopReason: "toolUse",
				};
			}
			return stoppedResponse();
		},
	});
	try {
		harness.branch.push({
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "previous response" }] },
		});
		harness.handlers.get("input")?.(
			{ source: "user", text: "性能测试不要依赖人工进游戏", streamingBehavior: "followUp" },
			harness.ctx,
		);
		harness.handlers.get("agent_start")?.({}, harness.ctx);
		harness.handlers.get("message_end")?.(
			{ message: { role: "assistant", content: [{ type: "text", text: "会建立量化测量台" }] } },
			harness.ctx,
		);
		harness.handlers.get("agent_settled")?.({}, harness.ctx);
		await harness.handlers.get("session_shutdown")?.({}, harness.ctx);

		const newSection = learnerPrompt.split("NEW messages to analyze (learn ONLY from these):\n")[1] ?? "";
		assert.match(newSection, /性能测试不要依赖人工进游戏/);
		assert.match(newSection, /会建立量化测量台/);
		assert.doesNotMatch(newSection, /previous response/);
		assert.match(await readFile(join(harness.root, ".pi", "taste", "taste.md"), "utf8"), /quantitative benchmarks/);
		assert.equal(harness.entries.at(-1)?.data?.outcome, "changed");
		assert.deepEqual(
			harness.entries.at(-1)?.data?.files.map((file: any) => [file.scope, file.changed]),
			[["global", false], ["project", true]],
		);
	} finally {
		await harness.cleanup();
	}
});

test("buildTasteSection deduplicates imports, supports Project-only mode, and bounds content", () => {
	const config = {
		version: 3,
		learningEnabled: true,
		observer: { modelMode: "inherit", models: [], reasoning: "low", maxOutputTokens: 6000, timeoutMs: 90_000, maxInputChars: 30_000 },
		injection: { maxChars: 120 },
	} as any;
	const built = buildTasteSection(
		"# Project\n- Prefer tabs. Confidence: 0.8\n" + "x".repeat(200),
		"- Global rule. Confidence: 0.9\n",
		[
			{ scope: "project", statement: "Prefer tabs.", confidence: 0.8, sourcePath: "/command/project" },
			{ scope: "global", statement: "Imported global.", confidence: 0.6, sourcePath: "/command/global" },
		],
		config,
		false,
	);
	assert.match(built.section, /# Project/);
	assert.match(built.section, /Confidence: 0\.8/);
	assert.doesNotMatch(built.section, /Global rule|Imported global/);
	assert.equal((built.section.match(/Prefer tabs/g) ?? []).length, 1);
	assert.match(built.section, /chars omitted/);
});

test("before_agent_start preserves raw Global/Project Taste and off disables injection", async () => {
	const harness = await createHarness();
	try {
		const projectDir = join(harness.root, ".pi", "taste");
		await mkdir(projectDir, { recursive: true });
		await writeFile(
			join(projectDir, "taste.md"),
			"# Project workflow\n- Prefer project benchmarks. Confidence: 0.7\nSee [graphics/taste.md](graphics/taste.md)\n",
		);
		await mkdir(join(projectDir, "graphics"));
		await writeFile(
			join(projectDir, "graphics", "taste.md"),
			"# Graphics\n- Prefer stable frame pacing. Confidence: 0.95\n",
		);
		await writeFile(
			join(harness.globalDir, "taste.md"),
			"# Global style\n- Prefer concise answers. Confidence: 0.9\n",
		);
		const injected = await harness.handlers.get("before_agent_start")?.(
			{ systemPrompt: "BASE SYSTEM" },
			harness.ctx,
		);
		assert.match(injected.systemPrompt, /^BASE SYSTEM/);
		assert.match(injected.systemPrompt, /# Project workflow/);
		assert.match(injected.systemPrompt, /Confidence: 0\.7/);
		assert.match(injected.systemPrompt, /See \[graphics\/taste\.md\]/);
		assert.match(injected.systemPrompt, /graphics[/\\]taste\.md/);
		assert.match(injected.systemPrompt, /Prefer stable frame pacing\. Confidence: 0\.95/);
		assert.match(injected.systemPrompt, /# Global style/);
		assert.match(injected.systemPrompt, /Confidence: 0\.9/);
		assert.match(injected.systemPrompt, /<taste>[\s\S]*<\/taste>/);

		await harness.command("off");
		const disabled = await harness.handlers.get("before_agent_start")?.(
			{ systemPrompt: "BASE SYSTEM" },
			harness.ctx,
		);
		assert.equal(disabled.systemPrompt, "BASE SYSTEM");
		assert.equal((await loadConfig()).learningEnabled, false);
		await harness.command("on");
		assert.equal((await loadConfig()).learningEnabled, true);
	} finally {
		await harness.cleanup();
	}
});

test("remember/list/status/paths/help/retry and error reporting cover command basics", async () => {
	const harness = await createHarness();
	try {
		await harness.command("remember Prefer exact file paths");
		await harness.command("remember Prefer exact file paths");
		await harness.command("remember -g Keep responses concise.");
		const project = await loadPreferences(projectStorePaths(harness.root)!);
		const global = await loadPreferences(globalStorePaths());
		assert.equal(project.length, 1);
		assert.equal(project[0].statement, "Prefer exact file paths");
		assert.equal(global.length, 1);

		for (const command of ["list", "status", "paths", "help", "retry"]) await harness.command(command);
		const allText = harness.notifications.map((item) => item.text).join("\n");
		assert.match(allText, /\[P\].*Prefer exact file paths/);
		assert.match(allText, /\[G\].*Keep responses concise/);
		assert.match(allText, /Taste: on/);
		assert.match(allText, /Project taste\.md:/);
		assert.match(allText, /\/taste remember/);
		assert.match(allText, /Manual retry is not needed/);

		await harness.command("remember -g --project impossible");
		await harness.command("unknown");
		assert.equal(harness.notifications.at(-2)?.level, "error");
		assert.equal(harness.notifications.at(-1)?.level, "error");
	} finally {
		await harness.cleanup();
	}
});

test("import/move/forget handles scope changes, deduplication, secrets, and confirmation", async () => {
	const harness = await createHarness();
	try {
		await writeFile(
			join(harness.root, "prefs.md"),
			[
				"- Prefer tabs. Confidence: 0.8",
				"- Prefer tabs. Confidence: 0.9",
				"- API key: sk-test_abcdefghijklmnopqrstuvwxyz",
				"- Run full tests.",
			].join("\n"),
		);
		await harness.command("import prefs.md --yes");
		let project = await loadPreferences(projectStorePaths(harness.root)!);
		assert.deepEqual(project.map((item) => item.statement), ["Prefer tabs.", "Run full tests."]);
		const id = project[0].id;
		await harness.command(`move ${id.slice(0, 8)} global`);
		project = await loadPreferences(projectStorePaths(harness.root)!);
		let global = await loadPreferences(globalStorePaths());
		assert.equal(project.length, 1);
		assert.equal(global.length, 1);
		await harness.command(`forget ${global[0].id.slice(0, 8)}`);
		global = await loadPreferences(globalStorePaths());
		assert.equal(global.length, 0);

		await harness.command("import prefs.md");
		assert.match(harness.notifications.at(-1)?.text ?? "", /Use --yes/);
		assert.equal(harness.notifications.at(-1)?.level, "error");
	} finally {
		await harness.cleanup();
	}
});

test("model commands configure custom order without silent fallback", async () => {
	const harness = await createHarness();
	try {
		await harness.command("model only other/model-y");
		let config = await loadConfig();
		assert.equal(config.observer.modelMode, "custom");
		assert.deepEqual(config.observer.models, [{ provider: "other", model: "model-y" }]);
		await harness.command("model add test/model-x");
		config = await loadConfig();
		assert.deepEqual(config.observer.models, [
			{ provider: "other", model: "model-y" },
			{ provider: "test", model: "model-x" },
		]);
		await harness.command("model remove other/model-y");
		await harness.command("model status");
		await harness.command("model list model-y");
		assert.match(harness.notifications.at(-2)?.text ?? "", /Active: test\/model-x/);
		assert.match(harness.notifications.at(-1)?.text ?? "", /other\/model-y/);
		await harness.command("model inherit");
		assert.equal((await loadConfig()).observer.modelMode, "inherit");
		await harness.command("model only missing/model");
		assert.equal(harness.notifications.at(-1)?.level, "error");
	} finally {
		await harness.cleanup();
	}
});

test("Learner queue is single-concurrency and records provider errors", async () => {
	let active = 0;
	let maxActive = 0;
	let calls = 0;
	const harness = await createHarness({
		complete: async () => {
			calls += 1;
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active -= 1;
			if (calls === 2) throw new Error("provider unavailable");
			return stoppedResponse();
		},
	});
	try {
		harness.handlers.get("input")?.({ source: "extension", text: "ignored" }, harness.ctx);
		harness.handlers.get("input")?.({ source: "user", text: "First durable preference" }, harness.ctx);
		harness.handlers.get("input")?.({ source: "user", text: "Second durable preference" }, harness.ctx);
		harness.handlers.get("agent_start")?.({}, harness.ctx);
		harness.handlers.get("message_end")?.(
			{ message: { role: "assistant", content: [{ type: "text", text: "acknowledged" }] } },
			harness.ctx,
		);
		harness.handlers.get("agent_settled")?.({}, harness.ctx);
		await harness.handlers.get("session_shutdown")?.({}, harness.ctx);
		assert.equal(calls, 2);
		assert.equal(maxActive, 1);
		assert.deepEqual(harness.entries.map((entry) => entry.data.outcome), ["unchanged", "failed"]);
		assert.match(harness.entries.at(-1)?.data?.detail ?? "", /provider unavailable/);
	} finally {
		await harness.cleanup();
	}
});
