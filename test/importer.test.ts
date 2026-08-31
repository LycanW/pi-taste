import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readTasteImport } from "../importer.ts";

test("readTasteImport parses bullets, strips legacy metadata, deduplicates, and rejects secrets", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-taste-import-"));
	try {
		const source = join(root, "prefs.md");
		await writeFile(source, [
			"# Preferences",
			"- Prefer tabs. Confidence: 0.8",
			"* Prefer tabs. [approved]",
			"- Run all tests.",
			"- password=supersecretvalue",
			"> ignored quote",
		].join("\r\n"));
		const preview = await readTasteImport('"prefs.md"', root);
		assert.equal(preview.sourcePath, source);
		assert.deepEqual(preview.statements, ["Prefer tabs.", "Run all tests."]);
		assert.equal(preview.skipped > 0, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("readTasteImport supports plain-line fallback and validates source shape", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-taste-import-plain-"));
	try {
		await writeFile(join(root, "plain.md"), "# Heading\nPrefer concise output.\n<!-- hidden -->\nUse exact paths.\n");
		assert.deepEqual((await readTasteImport("plain.md", root)).statements, ["Prefer concise output.", "Use exact paths."]);
		await mkdir(join(root, "directory"));
		await assert.rejects(() => readTasteImport("directory", root), /not a file/);
		await writeFile(join(root, "empty.md"), "# only heading\n> quote\n");
		await assert.rejects(() => readTasteImport("empty.md", root), /No importable/);
		await assert.rejects(() => readTasteImport("missing.md", root), /ENOENT/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("readTasteImport enforces file, item, and statement limits", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-taste-import-limits-"));
	try {
		await writeFile(join(root, "large.md"), "x".repeat(256_001));
		await assert.rejects(() => readTasteImport("large.md", root), /too large/);
		await writeFile(
			join(root, "many.md"),
			Array.from({ length: 101 }, (_, index) => `- Preference number ${index}.`).join("\n"),
		);
		await assert.rejects(() => readTasteImport("many.md", root), /more than 100/);
		await writeFile(join(root, "long.md"), `- ${"x".repeat(501)}\n- Valid fallback preference.\n`);
		const preview = await readTasteImport("long.md", root);
		assert.deepEqual(preview.statements, ["Valid fallback preference."]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
