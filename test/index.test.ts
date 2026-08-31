import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import tasteExtension from "../index.ts";

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

test("agent_settled sends the current user and assistant messages to the Learner", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-taste-index-"));
	const previousTasteDir = process.env.PI_TASTE_DIR;
	process.env.PI_TASTE_DIR = join(root, "global-taste");
	try {
		const handlers = new Map<string, (...args: any[]) => any>();
		const entries: any[] = [];
		let learnerPrompt = "";
		const pi = {
			on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
			registerCommand: () => {},
			registerEntryRenderer: () => {},
			appendEntry: (type: string, data: any) => entries.push({ type, data }),
		} as any;
		await tasteExtension(pi);

		const branch = [
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "previous response" }] },
			},
		];
		const model = { provider: "test", id: "model-x", reasoning: true };
		const ctx = {
			cwd: root,
			model,
			modelRegistry: {
				hasConfiguredAuth: () => true,
				find: () => model,
				complete: async (_model: any, context: any) => {
					learnerPrompt = context.messages[0].content[0].text;
					return stoppedResponse();
				},
			},
			scopedModels: [],
			sessionManager: {
				getBranch: () => branch,
				getSessionId: () => "test-session",
				getSessionFile: () => undefined,
			},
		} as any;

		handlers.get("input")?.(
			{ source: "user", text: "性能测试不要依赖人工进游戏", streamingBehavior: "followUp" },
			ctx,
		);
		handlers.get("agent_start")?.({}, ctx);
		handlers.get("message_end")?.(
			{ message: { role: "assistant", content: [{ type: "text", text: "会建立量化测量台" }] } },
			ctx,
		);
		handlers.get("agent_settled")?.({}, ctx);
		await handlers.get("session_shutdown")?.({}, ctx);

		const newSection = learnerPrompt.split("NEW messages to analyze (learn ONLY from these):\n")[1] ?? "";
		assert.match(newSection, /性能测试不要依赖人工进游戏/);
		assert.match(newSection, /会建立量化测量台/);
		assert.doesNotMatch(newSection, /previous response/);
		assert.equal(entries.at(-1)?.data?.outcome, "unchanged");
	} finally {
		if (previousTasteDir === undefined) delete process.env.PI_TASTE_DIR;
		else process.env.PI_TASTE_DIR = previousTasteDir;
		await rm(root, { recursive: true, force: true });
	}
});
