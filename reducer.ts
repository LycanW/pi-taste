import type {
	LearnerProposal,
	Preference,
	ReductionChange,
	ReductionResult,
	StorePaths,
	TasteScope,
} from "./types.ts";
import {
	loadPreferences,
	mutatePreferences,
	mutatePreferencesMultiple,
	normalizePreferenceKey,
	preferenceId,
} from "./storage.ts";

const MAX_PROPOSALS = 5;
const MAX_STATEMENT_CHARS = 500;
const MAX_QUOTE_CHARS = 800;

export interface MutationContext {
	eventId: string;
	at: string;
	sessionId?: string;
}

export interface ReductionContext extends MutationContext {
	userFeedback: string;
	allowGlobalLearning: boolean;
}

function cleanStatement(value: string): string {
	return value
		.trim()
		.replace(/^[-*]\s+/, "")
		.replace(/\s+Confidence:\s*(?:0(?:\.\d+)?|1(?:\.0+)?)\s*\.?\s*$/i, "")
		.replace(/\s+\[(?:approved|pending|rejected|superseded)\]\s*$/i, "")
		.replace(/\s+/g, " ")
		.trim();
}

function quoteAppearsInFeedback(quote: string, feedback: string): boolean {
	const needle = quote.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
	const haystack = feedback.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
	return needle.length >= 2 && haystack.includes(needle);
}

export interface ValidatedProposal extends LearnerProposal {
	statement: string;
	scope: TasteScope;
	status: Preference["status"];
}

function validateProposal(
	proposal: LearnerProposal,
	feedback: string,
	projectAvailable: boolean,
	allowGlobalLearning: boolean,
	allowExplicit: boolean,
): { proposal?: ValidatedProposal; reason?: string } {
	if (!proposal || typeof proposal !== "object") return { reason: "proposal is not an object" };
	const statement = cleanStatement(typeof proposal.statement === "string" ? proposal.statement : "");
	const quote = typeof proposal.quote === "string" ? proposal.quote.trim() : "";
	if (statement.length < 6 || statement.length > MAX_STATEMENT_CHARS) return { reason: "invalid statement length" };
	if (!normalizePreferenceKey(statement)) return { reason: "empty normalized statement" };
	if (quote && (quote.length < 2 || quote.length > MAX_QUOTE_CHARS || !quoteAppearsInFeedback(quote, feedback))) {
		return { reason: "evidence quote is not an exact excerpt of the current user feedback" };
	}
	const scope = proposal.scope === "global" ? "global" : "project";
	const effectiveScope = scope === "global" && !allowGlobalLearning ? "project" : scope;
	if (effectiveScope === "project" && !projectAvailable) {
		return { reason: "project scope is unavailable for the current working directory" };
	}
	const confidence = Number.isFinite(proposal.confidence) ? Math.min(1, Math.max(0, proposal.confidence)) : 0.5;
	return {
		proposal: {
			statement,
			quote: quote || undefined,
			scope: effectiveScope,
			confidence,
			explicit: Boolean(proposal.explicit),
			status: proposal.explicit ? "approved" : "pending",
		},
	};
}

function newPreference(proposal: ValidatedProposal, context: ReductionContext): Preference {
	return {
		id: preferenceId(proposal.statement, proposal.scope),
		statement: proposal.statement,
		scope: proposal.scope,
		status: proposal.status,
		confidence: proposal.confidence,
		...(proposal.quote ? { quote: proposal.quote } : {}),
	};
}

function updateExisting(
	preference: Preference,
	proposal: ValidatedProposal,
	context: ReductionContext,
): ReductionChange {
	const wasPending = preference.status === "pending";
	const wasRejected = preference.status === "rejected" || preference.status === "superseded";
	const maxConfidence = Math.max(preference.confidence, proposal.confidence);
	preference.confidence = maxConfidence;
	if (wasRejected && proposal.explicit) preference.status = "approved";
	else if (preference.status === "pending" && proposal.explicit) preference.status = "approved";
	return {
		preferenceId: preference.id,
		action: wasPending && preference.status === "approved" ? "approved" : "reinforced",
		status: preference.status,
		statement: preference.statement,
		scope: preference.scope,
	};
}

function applyProposals(
	preferences: Preference[],
	proposals: ValidatedProposal[],
	context: ReductionContext,
	allExisting: Map<string, Preference>,
): ReductionChange[] {
	const changes: ReductionChange[] = [];
	for (const proposal of proposals) {
		const exactIndex = preferences.findIndex((item) => normalizePreferenceKey(item.statement) === normalizePreferenceKey(proposal.statement));
		if (exactIndex >= 0) {
			const existing = preferences[exactIndex];
			const change = updateExisting(existing, proposal, context);
			allExisting.set(existing.id, existing);
			changes.push(change);
			continue;
		}
		const preference = newPreference(proposal, context);
		preferences.unshift(preference);
		allExisting.set(preference.id, preference);
		changes.push({
			preferenceId: preference.id,
			action: "added",
			status: preference.status,
			statement: preference.statement,
			scope: preference.scope,
		});
	}
	return changes;
}

export async function reduceLearnerResult(
	result: { learnings: LearnerProposal[] },
	context: ReductionContext,
	globalPaths: StorePaths,
	projectPaths?: StorePaths,
): Promise<ReductionResult> {
	const stores = [
		globalPaths,
		...(projectPaths ? [projectPaths] : []),
	] as StorePaths[];
	const proposals = result.learnings.slice(0, MAX_PROPOSALS);
	const validateAgainst: Record<TasteScope, boolean> = {
		global: globalPaths.scope === "global" || Boolean(projectPaths && projectPaths.scope === "global"),
		project: Boolean(projectPaths) || globalPaths.scope === "project",
	};
	const validated: ValidatedProposal[] = [];
	const skippedReasons: string[] = [];
	for (const proposal of proposals) {
		const outcome = validateProposal(
			proposal,
			context.userFeedback,
			validateAgainst.project,
			context.allowGlobalLearning,
			true,
		);
		if (outcome.proposal) validated.push(outcome.proposal);
		else skippedReasons.push(outcome.reason ?? "invalid proposal");
	}

	if (validated.length === 0) return { changes: [] };

	const changes: ReductionChange[] = [];
	await mutatePreferencesMultiple(stores, async (files) => {
		// Map every preference (both scopes) for relation lookup.
		const allExisting = new Map<string, Preference>();
		for (const prefs of files.values()) for (const preference of prefs) allExisting.set(preference.id, preference);
		// Scope-split proposals.
		for (const proposal of validated) {
			const target = files.get(proposal.scope);
			if (!target) continue;
			changes.push(...applyProposals(target, [proposal], context, allExisting));
		}
	});
	return { changes };
}

// ---------------------------------------------------------------------------
// Manual command mutations (v2: operate on taste.md directly)
// ---------------------------------------------------------------------------

export async function rememberPreference(
	paths: StorePaths,
	statement: string,
	context: MutationContext,
	explicitScope?: TasteScope,
): Promise<{ preference: Preference; action: "added" | "reinforced" }> {
	const result = await mutatePreferences(paths, (preferences) => {
		const clean = cleanStatement(statement);
		const key = normalizePreferenceKey(clean);
		const existing = preferences.find((item) => normalizePreferenceKey(item.statement) === key);
		if (existing) {
			existing.status = "approved";
			existing.confidence = 1;
			return { preference: existing, action: "reinforced" as const };
		}
		const preference: Preference = {
			id: preferenceId(clean, paths.scope),
			statement: clean,
			scope: paths.scope,
			status: "approved",
			confidence: 1,
		};
		preferences.push(preference);
		return { preference, action: "added" as const };
	});
	return result;
}

export async function setPreferenceStatus(
	paths: StorePaths,
	id: string,
	status: "approved" | "pending" | "rejected" | "superseded",
	context: MutationContext,
): Promise<Preference> {
	return mutatePreferences(paths, (preferences) => {
		const preference = preferences.find((item) => item.id === id || item.id.startsWith(id));
		if (!preference) throw new Error(`No preference matches ${id}`);
		preference.status = status;
		return preference;
	});
}

function eqPreference(a: Preference, b: Preference): boolean {
	return a.scope === b.scope && normalizePreferenceKey(a.statement) === normalizePreferenceKey(b.statement);
}

export async function movePreference(
	sourcePaths: StorePaths,
	targetPaths: StorePaths,
	id: string,
	context: MutationContext,
): Promise<{ source: Preference; target: Preference; targetExisted: boolean }> {
	let moved: Preference | undefined;
	let targetExisted = false;
	const source = await mutatePreferences(sourcePaths, (preferences) => {
		const index = preferences.findIndex((item) => item.id === id || item.id.startsWith(id));
		if (index < 0) throw new Error(`No preference matches ${id}`);
		moved = preferences[index];
		if (moved.scope !== sourcePaths.scope) throw new Error("Preference scope does not match its store.");
		const targetMoved = { ...moved, scope: targetPaths.scope, id: preferenceId(moved.statement, targetPaths.scope) };
		preferences.splice(index, 1);
		return targetMoved;
	});
	const target = await mutatePreferences(targetPaths, (preferences) => {
		const existingIndex = preferences.findIndex((item) => eqPreference(item, source));
		if (existingIndex >= 0) {
			targetExisted = true;
			preferences[existingIndex].status = "approved";
			preferences[existingIndex].confidence = 1;
			return preferences[existingIndex];
		}
		preferences.push(source);
		return source;
	});
	return { source: moved!, target, targetExisted };
}

export async function forgetPreference(
	paths: StorePaths,
	id: string,
	context: MutationContext,
): Promise<Preference> {
	return mutatePreferences(paths, (preferences) => {
		const index = preferences.findIndex((item) => item.id === id || item.id.startsWith(id));
		if (index < 0) throw new Error(`No preference matches ${id}`);
		const [removed] = preferences.splice(index, 1);
		return removed;
	});
}
