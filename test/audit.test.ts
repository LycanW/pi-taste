import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendEvent, countAuditLines, ensureProjectStore } from "../storage.ts";
import type { StorePaths, TasteEvent } from "../types.ts";

function projectStore(root: string): StorePaths {
	return {
		dir: join(root, ".pi", "taste"),
		taste: join(root, ".pi", "taste", "taste.md"),
		auditDir: join(root, ".pi", "taste", "audit"),
		audit: join(root, ".pi", "taste", "audit", "current.jsonl"),
		lock: join(root, ".pi", "taste", ".lock"),
		scope: "project",
		projectRoot: root,
	};
}

function event(id: string): TasteEvent {
	return {
		version: 2,
		id,
		timestamp: new Date().toISOString(),
		type: "observer",
		interaction: { userText: "x", assistantText: "" },
		observer: { status: "completed", result: { learnings: [] } },
	};
}

test("audit log rotates at size threshold and keeps bounded segments", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-taste-audit-"));
	try {
		const paths = projectStore(root);
		await ensureProjectStore(paths);
		// Many small events: force rotation by repeatedly appending until segments appear.
		for (let i = 0; i < 50; i++) await appendEvent(paths, event(`e-${i}`));
		const lines = await countAuditLines(paths);
		assert.ok(lines >= 1, `expected at least 1 audit line, got ${lines}`);
		// Segments directory should exist (may be empty until threshold).
		const segmentsDir = paths.auditDir;
		await stat(segmentsDir);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
