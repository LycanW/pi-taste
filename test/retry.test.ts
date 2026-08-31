import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendEvent, findRetryableObserverEvent } from "../storage.ts";
import type { StorePaths, TasteEvent } from "../types.ts";

function globalStore(root: string): StorePaths {
	return {
		dir: join(root, "global"),
		preferences: join(root, "global", "preferences.json"),
		taste: join(root, "global", "taste.md"),
		events: join(root, "global", "events.jsonl"),
		lock: join(root, "global", ".lock"),
		scope: "global",
	};
}

function failedEvent(id: string, projectRoot: string): TasteEvent {
	return {
		version: 1,
		id,
		timestamp: "2026-01-01T00:00:00.000Z",
		type: "observer",
		projectRoot,
		interaction: { currentUserFeedback: "以后始终显示准确路径" },
		observer: { status: "failed", reason: "server overloaded" },
	};
}

test("manual retry lookup stays project-local and ignores successfully retried failures", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-taste-retry-"));
	try {
		const paths = globalStore(root);
		const projectRoot = join(root, "workspace");
		await appendEvent(paths, failedEvent("failed-other", join(root, "other")));
		await appendEvent(paths, failedEvent("failed-root", projectRoot));
		await appendEvent(paths, {
			...failedEvent("retry-attempt", projectRoot),
			details: { retryOf: "failed-root" },
		});

		const fromLatest = await findRetryableObserverEvent(paths, projectRoot);
		assert.equal(fromLatest.event?.id, "failed-root");
		const fromAttemptId = await findRetryableObserverEvent(paths, projectRoot, "retry-attempt");
		assert.equal(fromAttemptId.event?.id, "failed-root");

		await appendEvent(paths, {
			version: 1,
			id: "retry-success",
			timestamp: "2026-01-02T00:00:00.000Z",
			type: "observer",
			projectRoot,
			details: { retryOf: "failed-root" },
			interaction: { currentUserFeedback: "以后始终显示准确路径" },
			observer: {
				status: "completed",
				result: { classification: { kind: "explicit_preference", reason: "explicit" }, proposals: [] },
			},
		});

		const none = await findRetryableObserverEvent(paths, projectRoot);
		assert.equal(none.event, undefined);
		assert.match(none.reason ?? "", /No retryable/);
		const alreadyDone = await findRetryableObserverEvent(paths, projectRoot, "failed-root");
		assert.equal(alreadyDone.event, undefined);
		assert.match(alreadyDone.reason ?? "", /already retried successfully/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
