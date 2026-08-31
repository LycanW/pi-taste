import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installTasteFooter, type TasteFooterState } from "../footer.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as any;

test("installTasteFooter is inert outside TUI mode", () => {
	let called = false;
	installTasteFooter(
		{ mode: "rpc", ui: { setFooter: () => { called = true; } } } as any,
		() => ({ learningEnabled: true, queuedJobs: 0, hasError: false }),
		() => {},
	);
	assert.equal(called, false);
});

test("Taste footer renders usage, queue/error state, model, cwd, and extension statuses", () => {
	let footerFactory: any;
	let renderReady: (() => void) | undefined;
	let renderRequests = 0;
	let unsubscribed = false;
	let cwd = join(homedir(), "work", "project");
	let contextUsage: any = { contextWindow: 2_000_000, percent: 95.25 };
	const state: TasteFooterState = {
		learningEnabled: true,
		queuedJobs: 2,
		hasError: true,
		model: { provider: "test", id: "model-x", reasoning: true },
		thinkingLevel: "high",
	};
	const entries = [
		{
			type: "message",
			message: {
				role: "assistant",
				usage: {
					input: 1_500,
					output: 15_000,
					cacheRead: 1_000_000,
					cacheWrite: 11_000_000,
					cost: { total: 0.1234 },
				},
			},
		},
		{ type: "toolResult", message: { role: "toolResult", usage: { input: 2, output: 3 } } },
		{ type: "branch_summary", usage: { input: 4, output: 5, cost: { total: 0.001 } } },
	];
	const ctx = {
		mode: "tui",
		ui: { setFooter: (factory: any) => { footerFactory = factory; } },
		sessionManager: {
			getEntries: () => entries,
			getCwd: () => cwd,
			getSessionName: () => "coverage",
		},
		getContextUsage: () => contextUsage,
	} as any;
	installTasteFooter(ctx, () => state, (request) => { renderReady = request; });
	assert.equal(typeof footerFactory, "function");
	const footerData = {
		onBranchChange: (_callback: () => void) => () => { unsubscribed = true; },
		getAvailableProviderCount: () => 2,
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map([
			["taste", "ignored"],
			["z", " status\nwith\ttabs "],
		]),
	};
	const component = footerFactory({ requestRender: () => { renderRequests += 1; } }, theme, footerData);
	assert.equal(typeof renderReady, "function");
	renderReady?.();
	assert.equal(renderRequests, 1);
	const lines = component.render(160);
	assert.match(lines[0], /~.*work.*project \(main\).*coverage/);
	assert.match(lines[1], /↑1\.5k/);
	assert.match(lines[1], /↓15k/);
	assert.match(lines[1], /R1\.0M/);
	assert.match(lines[1], /W11M/);
	assert.match(lines[1], /CH/);
	assert.match(lines[1], /\$0\.124/);
	assert.match(lines[1], /95\.3%\/2\.0M/);
	assert.match(lines[1], /Taste:on·2!/);
	assert.match(lines[1], /\(test\) model-x • high/);
	assert.equal(lines[2], "status with tabs");

	state.learningEnabled = false;
	state.hasError = false;
	state.queuedJobs = 0;
	state.model = undefined;
	contextUsage = { contextWindow: 128_000, percent: 80 };
	cwd = "/outside/home";
	const warningLines = component.render(160);
	assert.match(warningLines[0], /outside/);
	assert.match(warningLines[1], /Taste:off/);
	assert.equal(component.render(20).length, 3);
	contextUsage = { contextWindow: 128_000, percent: undefined };
	assert.match(component.render(160)[1], /\?\/128k/);
	component.invalidate();
	component.dispose();
	assert.equal(unsubscribed, true);
});
