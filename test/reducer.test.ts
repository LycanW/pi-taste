import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { movePreference, reduceObserverResult, rememberPreferences } from "../reducer.ts";
import { loadPreferenceFile } from "../storage.ts";
import type { ObserverResult, StorePaths, TasteScope } from "../types.ts";

function store(root: string, scope: TasteScope): StorePaths {
	const dir = join(root, scope);
	return {
		dir,
		preferences: join(dir, "preferences.json"),
		taste: join(dir, "taste.md"),
		events: join(dir, "events.jsonl"),
		lock: join(dir, ".lock"),
		scope,
		...(scope === "project" ? { projectRoot: root } : {}),
	};
}

test("manual batch remember is approved, deduplicated, and rendered", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-taste-reducer-"));
	try {
		const paths = store(root, "global");
		const context = { eventId: "event-1", at: "2026-01-01T00:00:00.000Z" };
		const first = await rememberPreferences(paths, ["Always show exact file paths."], context);
		const second = await rememberPreferences(paths, ["Always show exact file paths."], {
			eventId: "event-2",
			at: "2026-01-02T00:00:00.000Z",
		});
		assert.equal(first[0].action, "added");
		assert.equal(second[0].action, "reinforced");
		const file = await loadPreferenceFile(paths);
		assert.equal(file.preferences.length, 1);
		assert.equal(file.preferences[0].status, "approved");
		assert.equal(file.preferences[0].supportCount, 2);
		assert.match(await readFile(paths.taste, "utf8"), /Always show exact file paths\./);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("automatic Global scope requires both an enabled switch and explicit global evidence", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-taste-auto-scope-"));
	try {
		const globalPaths = store(root, "global");
		const projectPaths = store(root, "project");
		const result = (quote: string): ObserverResult => ({
			classification: { kind: "explicit_preference", reason: "explicit durable preference" },
			proposals: [
				{
					statement: "Always show exact file paths.",
					scope: "global",
					signal: "explicit_preference",
					persistence: "durable",
					quote,
					relation: { type: "new", preferenceId: null },
				},
			],
		});

		const disabled = await reduceObserverResult(
			result("所有项目以后都必须显示准确文件路径"),
			{
				eventId: "event-disabled",
				at: "2026-01-01T00:00:00.000Z",
				userFeedback: "所有项目以后都必须显示准确文件路径",
				allowGlobalLearning: false,
			},
			globalPaths,
			projectPaths,
		);
		assert.equal(disabled.changes[0].scope, "project");
		assert.match(disabled.changes[0].reason ?? "", /Global learning is off/);
		assert.equal((await loadPreferenceFile(globalPaths)).preferences.length, 0);
		assert.equal((await loadPreferenceFile(projectPaths)).preferences.length, 1);

		await rm(projectPaths.dir, { recursive: true, force: true });
		const ambiguous = await reduceObserverResult(
			result("以后必须显示准确文件路径"),
			{
				eventId: "event-ambiguous",
				at: "2026-01-02T00:00:00.000Z",
				userFeedback: "以后必须显示准确文件路径",
				allowGlobalLearning: true,
			},
			globalPaths,
			projectPaths,
		);
		assert.equal(ambiguous.changes[0].scope, "project");
		assert.match(ambiguous.changes[0].reason ?? "", /not explicit/);
		assert.equal((await loadPreferenceFile(globalPaths)).preferences.length, 0);

		await rm(projectPaths.dir, { recursive: true, force: true });
		const enabled = await reduceObserverResult(
			result("所有项目以后都必须显示准确文件路径"),
			{
				eventId: "event-enabled",
				at: "2026-01-03T00:00:00.000Z",
				userFeedback: "所有项目以后都必须显示准确文件路径",
				allowGlobalLearning: true,
			},
			globalPaths,
			projectPaths,
		);
		assert.equal(enabled.changes[0].scope, "global");
		assert.equal((await loadPreferenceFile(globalPaths)).preferences.length, 1);
		assert.equal((await loadPreferenceFile(projectPaths)).preferences.length, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("moving scope supersedes the source and preserves an approved target", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-taste-move-"));
	try {
		const globalPaths = store(root, "global");
		const projectPaths = store(root, "project");
		const [remembered] = await rememberPreferences(globalPaths, ["Keep explanations concise."], {
			eventId: "event-1",
			at: "2026-01-01T00:00:00.000Z",
		});
		const moved = await movePreference(globalPaths, projectPaths, remembered.preference.id, {
			eventId: "event-2",
			at: "2026-01-02T00:00:00.000Z",
		});
		assert.equal(moved.source.status, "superseded");
		assert.equal(moved.target.status, "approved");
		assert.equal(moved.target.scope, "project");
		assert.ok(moved.target.supersedes.includes(moved.source.id));
		assert.doesNotMatch(await readFile(globalPaths.taste, "utf8"), /Keep explanations concise\./);
		assert.match(await readFile(projectPaths.taste, "utf8"), /Keep explanations concise\./);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
