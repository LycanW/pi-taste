import assert from "node:assert/strict";
import test from "node:test";
import {
	installTasteActivityRenderer,
	tasteActivityFiles,
	TASTE_ACTIVITY_ENTRY,
} from "../activity.ts";
import type { StorePaths } from "../types.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as any;

const globalPaths: StorePaths = {
	dir: "/global",
	taste: "/global/taste.md",
	lock: "/global/.lock",
	scope: "global",
};
const projectPaths: StorePaths = {
	dir: "/project/.pi/taste",
	taste: "/project/.pi/taste/taste.md",
	lock: "/project/.pi/taste/.lock",
	scope: "project",
	projectRoot: "/project",
};

test("tasteActivityFiles reports only scopes that actually changed", () => {
	assert.deepEqual(tasteActivityFiles(globalPaths, projectPaths, [{ action: "edited", scope: "project" }]), [
		{ scope: "global", taste: "/global/taste.md", changed: false },
		{ scope: "project", taste: "/project/.pi/taste/taste.md", changed: true },
	]);
	assert.deepEqual(tasteActivityFiles(globalPaths, projectPaths, [], true, ["global"]), [
		{ scope: "global", taste: "/global/taste.md", changed: true },
		{ scope: "project", taste: "/project/.pi/taste/taste.md", changed: false },
	]);
});

test("activity renderer covers changed, failed, skipped, expanded, and missing entries", () => {
	let renderer: any;
	installTasteActivityRenderer({
		registerEntryRenderer: (name: string, value: any) => {
			assert.equal(name, TASTE_ACTIVITY_ENTRY);
			renderer = value;
		},
	} as any);
	assert.equal(typeof renderer, "function");
	const changes = [
		{ action: "wrote", statement: "Root file", scope: "project", status: "approved", preferenceId: "p_1", reason: "explicit" },
		{ action: "edited", statement: "Edited preference", status: "pending" },
		{ action: "added", statement: "Added preference", status: "rejected" },
		{ action: "reinforced", statement: "Reinforced preference", status: "superseded" },
		{ action: "approved", statement: "Approved preference" },
		{ action: "rejected", statement: "Rejected preference" },
		{ action: "deleted", statement: "Deleted preference" },
		{ action: "reorganized", reason: "Moved category" },
	];
	const data = {
		version: 1 as const,
		eventId: "event-1",
		timestamp: "2026-09-01T00:00:00.000Z",
		kind: "observer" as const,
		outcome: "changed" as const,
		title: "Taste updated",
		changes,
		files: tasteActivityFiles(globalPaths, projectPaths, changes as any, true),
		classification: "durable",
		model: "test/model-x",
		detail: "details",
	};
	const collapsed = renderer({ data }, { expanded: false }, theme).render(120).join("\n");
	assert.match(collapsed, /Taste updated/);
	assert.match(collapsed, /4 more/);
	const expanded = renderer({ data }, { expanded: true }, theme).render(140).join("\n");
	assert.match(expanded, /Root file/);
	assert.match(expanded, /active next turn/);
	assert.match(expanded, /pending; not injected/);
	assert.match(expanded, /Moved category/);
	assert.match(expanded, /test\/model-x/);
	assert.match(expanded, /event-1/);
	assert.match(expanded, /\[project\]: \/project\/\.pi\/taste\/taste\.md/);

	for (const outcome of ["failed", "skipped", "unchanged"] as const) {
		const text = renderer(
			{ data: { ...data, outcome, changes: [], title: outcome, files: [] } },
			{ expanded: true },
			theme,
		).render(80).join("\n");
		assert.match(text, new RegExp(outcome));
	}
	const missing = renderer({ data: undefined }, { expanded: false }, theme).render(80).join("\n");
	assert.match(missing, /unavailable/);
});
