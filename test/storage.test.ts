import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	countLearnings,
	getTasteStructure,
	isValidTasteFilePath,
	loadCommandCodeTaste,
	loadPreferences,
	parseLearnings,
	reorganizeIfNeeded,
	resolveTastePath,
} from "../storage.ts";
import { runTasteTool } from "../learner.ts";
import type { StorePaths } from "../types.ts";

function store(root: string, scope: "project" | "global" = "project"): StorePaths {
	return {
		dir: join(root, ".pi", "taste"),
		taste: join(root, ".pi", "taste", "taste.md"),
		lock: join(root, ".pi", "taste", ".lock"),
		scope,
		...(scope === "project" ? { projectRoot: root } : {}),
	};
}

test("parseLearnings reads Command Code style lines with confidence", () => {
	const content = [
		"- Prefers tabs over spaces. Confidence: 0.9",
		"- Avoid worktrees. Confidence: 0.4",
		"- Malformed line without confidence",
	].join("\n");
	const parsed = parseLearnings(content, "project");
	assert.equal(parsed.length, 2);
	assert.equal(parsed[0].confidence, 0.9);
	assert.equal(parsed[0].scope, "project");
});

test("countLearnings counts Confidence bullets", () => {
	const content = "- A. Confidence: 0.9\n- B. Confidence: 0.5\nnot a bullet";
	assert.equal(countLearnings(content), 2);
});

test("resolveTastePath rejects traversal and absolute paths", () => {
	const paths = store("/workspace");
	assert.deepEqual(resolveTastePath(paths, "taste.md")?.segments, ["taste.md"]);
	assert.deepEqual(resolveTastePath(paths, "category/taste.md")?.segments, ["category", "taste.md"]);
	assert.equal(resolveTastePath(paths, "../secret"), null);
	assert.equal(resolveTastePath(paths, "/etc/passwd"), null);
	assert.deepEqual(resolveTastePath(paths, "other.md")?.segments, ["other.md"]);
});

test("isValidTasteFilePath enforces Command Code path policy", () => {
	assert.equal(isValidTasteFilePath(["taste.md"]), true);
	assert.equal(isValidTasteFilePath(["category", "taste.md"]), true);
	assert.equal(isValidTasteFilePath(["deep", "category", "taste.md"]), false);
	assert.equal(isValidTasteFilePath(["other.md"]), false);
});

test("runTasteTool writes and edits taste.md with Command Code semantics", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-taste-tool-"));
	try {
		const paths = store(root);
		await mkdir(paths.dir, { recursive: true });
		await writeFile(paths.taste, "");
		const wrote = await runTasteTool(paths, "write_taste_file", {
			path: "taste.md",
			content: "- Use tabs. Confidence: 0.9\n",
		});
		assert.equal(wrote, "wrote taste.md");
		assert.equal(await readFile(paths.taste, "utf8"), "- Use tabs. Confidence: 0.9\n");
		const edited = await runTasteTool(paths, "edit_taste_file", {
			path: "taste.md",
			old_text: "Use tabs.",
			new_text: "Use spaces.",
		});
		assert.equal(edited, "edited taste.md");
		assert.match(await readFile(paths.taste, "utf8"), /Use spaces/);
		const read = await runTasteTool(paths, "read_taste_file", { path: "taste.md" });
		assert.match(read, /Use spaces/);
		const rejected = await runTasteTool(paths, "write_taste_file", { path: "../bad.md", content: "x" });
		assert.match(rejected, /error/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("reorganizeIfNeeded moves >5 learning categories into folders", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-taste-reorg-"));
	try {
		const paths = store(root);
		await mkdir(paths.dir, { recursive: true });
		const bullets = Array.from({ length: 6 }, (_, i) => `- Style rule ${i + 1}. Confidence: 0.8`);
		const content = `# Styling\n${bullets.join("\n")}\n\n# Tools\n- Use pnpm. Confidence: 0.9\n`;
		await writeFile(paths.taste, content);
		const moved = await reorganizeIfNeeded(paths);
		assert.equal(moved.length, 1);
		assert.equal(moved[0].category, "Styling");
		const rootAfter = await readFile(paths.taste, "utf8");
		assert.match(rootAfter, /See \[styling\/taste.md\]/);
		const categoryFile = await readFile(join(paths.dir, "styling", "taste.md"), "utf8");
		assert.match(categoryFile, /Style rule 1/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("getTasteStructure renders tree like Command Code", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-taste-tree-"));
	try {
		const paths = store(root);
		await mkdir(paths.dir, { recursive: true });
		await writeFile(paths.taste, "- A. Confidence: 0.9\n");
		const tree = await getTasteStructure(paths);
		assert.match(tree, /taste\.md \(1 learnings\)/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("loadPreferences round-trips empty and populated files", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-taste-load-"));
	try {
		const paths = store(root);
		await mkdir(paths.dir, { recursive: true });
		assert.deepEqual(await loadPreferences(paths), []);
		await writeFile(paths.taste, "- Prefer x. Confidence: 1.0\n");
		const loaded = await loadPreferences(paths);
		assert.equal(loaded.length, 1);
		assert.equal(loaded[0].statement, "Prefer x.");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
