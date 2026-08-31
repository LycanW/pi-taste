import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	ensureProjectStore,
	findProjectRoot,
	loadIncludeGlobalTaste,
	loadPreferences,
	parseTasteMarkdown,
	projectStorePaths,
	renderTasteMarkdown,
	saveProjectIncludeGlobal,
} from "../storage.ts";
import type { Preference } from "../types.ts";

test("a non-Git working directory is a valid project root", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-taste-workspace-"));
	try {
		const workspace = join(root, "ordinary-folder");
		await mkdir(workspace);
		assert.equal(findProjectRoot(workspace), resolve(workspace));
		assert.equal(projectStorePaths(findProjectRoot(workspace))?.dir, join(workspace, ".pi", "taste"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("project storage initializes readable state and defaults to Global injection", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-taste-project-init-"));
	try {
		const paths = projectStorePaths(root)!;
		await ensureProjectStore(paths);
		assert.equal(await loadIncludeGlobalTaste(paths), true);
		await Promise.all([
			access(paths.taste),
			access(join(paths.dir, ".gitignore")),
		]);
		await saveProjectIncludeGlobal(paths, false);
		assert.equal(await loadIncludeGlobalTaste(paths), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("the nearest Git root still wins for nested working directories", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-taste-git-root-"));
	try {
		const repository = join(root, "repository");
		const nested = join(repository, "packages", "app");
		await mkdir(join(repository, ".git"), { recursive: true });
		await mkdir(nested, { recursive: true });
		assert.equal(findProjectRoot(nested), resolve(repository));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("taste.md round-trips approved, pending, confidence, and frontmatter", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-taste-parse-"));
	try {
		const preferences: Preference[] = [
			{ id: "p_a", statement: "Use tabs.", scope: "project", status: "approved", confidence: 0.9 },
			{ id: "p_b", statement: "Never worktrees.", scope: "project", status: "pending", confidence: 0.4 },
		];
		const content = renderTasteMarkdown(preferences, "project", true);
		const parsed = parseTasteMarkdown(content, "project");
		assert.equal(parsed.includeGlobalTaste, true);
		assert.equal(parsed.preferences.length, 2);
		assert.equal(parsed.preferences[0].status, "approved");
		assert.equal(parsed.preferences[1].status, "pending");
		assert.equal(parsed.preferences[0].confidence, 0.9);

		// Persist and read back
		const paths = projectStorePaths(root)!;
		await ensureProjectStore(paths);
		await saveProjectIncludeGlobal(paths, true);
		const loaded = await loadPreferences(paths);
		assert.deepEqual(loaded.map((p) => p.statement), []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
