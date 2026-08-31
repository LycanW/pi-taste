import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Preference, StorePaths, TasteScope } from "./types.ts";
import { Box, Text } from "@earendil-works/pi-tui";

export const TASTE_ACTIVITY_ENTRY = "taste-activity";

export type TasteActivityKind =
	| "observer"
	| "manual"
	| "import"
	| "move"
	| "review"
	| "forget"
	| "config"
	| "curate"
	| "error";
export type TasteActivityOutcome = "changed" | "unchanged" | "skipped" | "failed";

export interface TasteActivityChange {
	action: string;
	statement?: string;
	preferenceId?: string;
	scope?: TasteScope;
	status?: string;
	reason?: string;
}

export interface TasteActivityFile {
	scope: TasteScope;
	taste: string;
	changed: boolean;
}

export interface TasteActivityData {
	version: 1;
	eventId: string;
	timestamp: string;
	kind: TasteActivityKind;
	outcome: TasteActivityOutcome;
	title: string;
	changes: TasteActivityChange[];
	files: TasteActivityFile[];
	classification?: string;
	model?: string;
	detail?: string;
}

function actionGlyph(action: string): string {
	switch (action) {
		case "wrote":
			return "✍";
		case "edited":
			return "✎";
		case "added":
			return "＋";
		case "reinforced":
			return "↑";
		case "approved":
			return "✓";
		case "rejected":
			return "✗";
		case "deleted":
			return "–";
		case "reorganized":
			return "⇄";
		default:
			return "·";
	}
}

function statusEffect(status: string | undefined): string {
	switch (status) {
		case "approved":
			return "active next turn";
		case "pending":
			return "pending; not injected";
		case "rejected":
			return "not injected";
		case "superseded":
			return "no longer injected";
		default:
			return "";
	}
}

function scopePaths(paths: StorePaths, changedScopes: Set<TasteScope>): TasteActivityFile {
	return {
		scope: paths.scope,
		taste: paths.taste,
		changed: changedScopes.has(paths.scope),
	};
}

export function tasteActivityFiles(
	globalPaths: StorePaths,
	projectPaths: StorePaths | undefined,
	changes: TasteActivityChange[],
	includeProjectAudit = false,
	additionalChangedScopes: TasteScope[] = [],
): TasteActivityFile[] {
	const changedScopes = new Set([
		...changes.flatMap((change) => (change.scope ? [change.scope] : [])),
		...additionalChangedScopes,
	]);
	const files = [scopePaths(globalPaths, changedScopes)];
	if (projectPaths && (changedScopes.has("project") || includeProjectAudit)) {
		files.push(scopePaths(projectPaths, changedScopes));
	}
	return files;
}

export function appendTasteActivity(pi: ExtensionAPI, data: TasteActivityData): void {
	pi.appendEntry<TasteActivityData>(TASTE_ACTIVITY_ENTRY, data);
}

export function installTasteActivityRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<TasteActivityData>(TASTE_ACTIVITY_ENTRY, (entry, { expanded }, theme) => {
		const data = entry.data;
		if (!data) return new Text(theme.fg("muted", "Taste activity unavailable"), 1, 0);
		const color = data.outcome === "failed"
			? "error"
			: data.outcome === "changed"
				? "success"
				: data.outcome === "skipped"
					? "muted"
					: "accent";
		const icon = data.outcome === "failed" ? "✗" : data.outcome === "changed" ? "✓" : data.outcome === "skipped" ? "·" : "○";
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(`${theme.fg(color, `${icon} Taste`)} ${theme.bold(data.title)}`, 0, 0));

		const visibleChanges = expanded ? data.changes : data.changes.slice(0, 4);
		for (const change of visibleChanges) {
			const scope = change.scope ? `${change.scope}/` : "";
			const status = change.status ?? "";
			const label = scope || status ? `[${scope}${status}] ` : "";
			const statement = change.statement ?? change.reason ?? change.preferenceId ?? change.action;
			const effect = statusEffect(change.status);
			const id = expanded && change.preferenceId ? theme.fg("dim", ` [${change.preferenceId}]`) : "";
			box.addChild(
				new Text(
					`${theme.fg(change.status === "pending" ? "warning" : "toolTitle", actionGlyph(change.action))} ${theme.fg("accent", label)}${statement}${id}${effect ? theme.fg("muted", ` — ${effect}`) : ""}`,
					0,
					0,
				),
			);
			if (expanded && change.reason && change.statement) {
				box.addChild(new Text(theme.fg("dim", `  ${change.reason}`), 0, 0));
			}
		}
		if (!expanded && data.changes.length > visibleChanges.length) {
			box.addChild(new Text(theme.fg("muted", `… ${data.changes.length - visibleChanges.length} more changes (Ctrl+O to expand)`), 0, 0));
		}
		if (data.changes.length === 0 && data.detail) box.addChild(new Text(theme.fg("muted", data.detail), 0, 0));
		if (expanded && data.changes.length > 0 && data.detail) {
			box.addChild(new Text(theme.fg("dim", data.detail), 0, 0));
		}

		for (const file of data.files) {
			if (file.changed) {
				box.addChild(new Text(theme.fg("muted", `Taste [${file.scope}]: ${file.taste}`), 0, 0));
			}
			if (expanded || !file.changed) {
				box.addChild(new Text(theme.fg("dim", `State [${file.scope}]: ${file.taste}`), 0, 0));
			}
		}
		if (expanded) {
			if (data.classification) box.addChild(new Text(theme.fg("dim", `Classification: ${data.classification}`), 0, 0));
			if (data.model) box.addChild(new Text(theme.fg("dim", `Learner: ${data.model}`), 0, 0));
			box.addChild(new Text(theme.fg("dim", `Event: ${data.eventId}`), 0, 0));
		}
		return box;
	});
}
