import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	findProjectRoot,
	loadProjectConfig,
	projectStorePaths,
	saveProjectConfig,
} from "../storage.ts";

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

test("project storage defaults to Global injection and learning and initializes readable state", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-taste-project-config-"));
	try {
		const paths = projectStorePaths(root)!;
		assert.deepEqual(await loadProjectConfig(paths), { version: 1, includeGlobalTaste: true });
		await Promise.all([
			access(paths.preferences),
			access(paths.taste),
			access(paths.events),
			access(join(paths.dir, "config.json")),
			access(join(paths.dir, ".gitignore")),
		]);
		await saveProjectConfig(paths, { version: 1, includeGlobalTaste: false });
		assert.deepEqual(await loadProjectConfig(paths), { version: 1, includeGlobalTaste: false });
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
