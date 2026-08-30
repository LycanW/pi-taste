import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readTasteImport } from "../importer.ts";

test("imports Command Code-style Markdown conservatively", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-taste-import-"));
	try {
		const path = join(root, "taste.md");
		await writeFile(
			path,
			[
				"# Taste",
				"",
				"- Always show changed file paths. Confidence: 0.8",
				"- Always show changed file paths.",
				"- Never claim tests passed unless they ran.",
				"- api_key=sk_test_12345678901234567890",
				"",
			].join("\n"),
		);
		const preview = await readTasteImport(path, root);
		assert.deepEqual(preview.statements, [
			"Always show changed file paths.",
			"Never claim tests passed unless they ran.",
		]);
		assert.ok(preview.skipped >= 2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
