import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	rememberPreference,
	reduceLearnerResult,
} from "../reducer.ts";
import { loadPreferences, normalizePreferenceKey, preferenceId } from "../storage.ts";
import type { Preference, StorePaths } from "../types.ts";

async function tempStore(scope: "global" | "project"): Promise<{ paths: StorePaths; dir: string }> {
	const dir = await mkdtemp(join(tmpdir(), "pi-taste-reducer-"));
	const paths: StorePaths = {
		dir,
		taste: join(dir, "taste.md"),
		auditDir: join(dir, "audit"),
		audit: join(dir, "audit", "current.jsonl"),
		lock: join(dir, ".lock"),
		scope,
	};
	return { paths, dir };
}

test("preferenceId is deterministic and scope-scoped", () => {
	assert.equal(preferenceId("Use tabs", "project"), preferenceId("Use tabs", "project"));
	assert.notEqual(preferenceId("Use tabs", "project"), preferenceId("Use tabs", "global"));
});

test("explicit durable learning is approved", async () => {
	const { paths, dir } = await tempStore("project");
	try {
		const result = await reduceLearnerResult(
			{
				learnings: [
					{
						statement: "Always use tabs instead of spaces.",
						scope: "project",
						confidence: 0.9,
						explicit: true,
						quote: "always use tabs",
					},
				],
			},
			{
				eventId: "e1",
				at: "2026-01-01T00:00:00Z",
				userFeedback: "Always use tabs instead of spaces.",
				allowGlobalLearning: true,
			},
			paths,
		);
		assert.ok(result.changes.some((change) => change.action === "added"));
		const preferences = await loadPreferences(paths);
		assert.equal(preferences.length, 1);
		assert.equal(preferences[0].status, "approved");
		assert.equal(preferences[0].confidence, 0.9);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("implicit correction is pending until approved or repeated", async () => {
	const { paths, dir } = await tempStore("project");
	try {
		const result = await reduceLearnerResult(
			{
				learnings: [
					{
						statement: "Prefers diagrams before implementation.",
						scope: "project",
						confidence: 0.4,
						explicit: false,
						quote: "先画图",
					},
				],
			},
			{
				eventId: "e1",
				at: "2026-01-01T00:00:00Z",
				userFeedback: "下次先画图再写代码",
				allowGlobalLearning: true,
			},
			paths,
		);
		assert.ok(result.changes.some((change) => change.status === "pending"));
		const preferences = await loadPreferences(paths);
		assert.equal(preferences[0].status, "pending");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("duplicate statement is reinforced, not duplicated", async () => {
	const { paths, dir } = await tempStore("project");
	try {
		await reduceLearnerResult(
			{
				learnings: [
					{ statement: "Never create worktrees.", scope: "project", confidence: 0.9, explicit: true },
				],
			},
			{ eventId: "e1", at: "2026-01-01T00:00:00Z", userFeedback: "never create worktrees", allowGlobalLearning: true },
			paths,
		);
		const result = await reduceLearnerResult(
			{
				learnings: [
					{ statement: "Never create worktrees.", scope: "project", confidence: 0.95, explicit: true },
				],
			},
			{ eventId: "e2", at: "2026-01-02T00:00:00Z", userFeedback: "never create worktrees", allowGlobalLearning: true },
			paths,
		);
		assert.equal(result.changes[0].action, "reinforced");
		const preferences = await loadPreferences(paths);
		assert.equal(preferences.length, 1);
		assert.equal(preferences[0].confidence, 0.95);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("quote not present in feedback is rejected", async () => {
	const { paths, dir } = await tempStore("project");
	try {
		const result = await reduceLearnerResult(
			{
				learnings: [
					{
						statement: "Use pnpm.",
						scope: "project",
						confidence: 0.8,
						explicit: true,
						quote: "use yarn",
					},
				],
			},
			{ eventId: "e1", at: "2026-01-01T00:00:00Z", userFeedback: "Use pnpm.", allowGlobalLearning: true },
			paths,
		);
		assert.equal(result.changes.length, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("global learning constrained when allowGlobalLearning=false", async () => {
	const { paths, dir } = await tempStore("global");
	try {
		// Global paths with global learning disabled: proposal must lose global scope
		const result = await reduceLearnerResult(
			{
				learnings: [
					{ statement: "All projects use tabs.", scope: "global", confidence: 0.9, explicit: true },
				],
			},
			{ eventId: "e1", at: "2026-01-01T00:00:00Z", userFeedback: "all projects use tabs", allowGlobalLearning: false },
			paths,
		);
		// Only global paths are writable here; the proposal is constrained to project,
		// and project is unavailable, so no change.
		assert.equal(result.changes.length, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("manual remember marks approved with confidence 1", async () => {
	const { paths, dir } = await tempStore("project");
	try {
		const outcome = await rememberPreference(
			paths,
			"Always document public APIs.",
			{ eventId: "l1", at: "2026-01-01T00:00:00Z" },
		);
		assert.equal(outcome.action, "added");
		assert.equal(outcome.preference.status, "approved");
		assert.equal(outcome.preference.confidence, 1);
		const preferences = await loadPreferences(paths);
		assert.equal(preferences.length, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("manual remember of existing statement reinforces", async () => {
	const { paths, dir } = await tempStore("project");
	try {
		await reduceLearnerResult(
			{ learnings: [{ statement: "Use tabs.", scope: "project", confidence: 0.5, explicit: false }] },
			{ eventId: "e1", at: "2026-01-01T00:00:00Z", userFeedback: "use tabs", allowGlobalLearning: true },
			paths,
		);
		const outcome = await rememberPreference(
			paths,
			"Use tabs.",
			{ eventId: "l1", at: "2026-01-02T00:00:00Z" },
		);
		assert.equal(outcome.action, "reinforced");
		const preferences = await loadPreferences(paths);
		assert.equal(preferences[0].status, "approved");
		await rm(dir, { recursive: true, force: true });
	} catch (error) {
		await rm(dir, { recursive: true, force: true });
		throw error;
	}
});
