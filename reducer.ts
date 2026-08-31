import { createHash } from "node:crypto";
import type {
	ObserverProposal,
	ObserverResult,
	Preference,
	PreferenceEvidence,
	PreferenceFile,
	ReductionChange,
	ReductionResult,
	StorePaths,
	TasteScope,
} from "./types.ts";
import { loadPreferenceFile, mutatePreferenceFile, mutatePreferenceFiles, normalizePreferenceKey } from "./storage.ts";

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

interface ValidatedProposal extends ObserverProposal {
	statement: string;
	quote: string;
	effectiveSignal: "explicit_preference" | "implicit_correction";
	scopeConstraintReason?: string;
}

function roundConfidence(value: number): number {
	return Math.round(Math.max(0.05, Math.min(1, value)) * 100) / 100;
}

export function computeConfidence(preference: Preference): number {
	if (preference.source === "manual") {
		if (preference.status === "rejected") return 0.2;
		if (preference.status === "superseded") return 0.4;
		return 1;
	}
	const hasExplicit = preference.evidence.some((item) => item.signal === "explicit_preference");
	let score = hasExplicit ? 0.82 : 0.36;
	score += Math.min(3, Math.max(0, preference.supportCount - 1)) * 0.07;
	if (preference.reviewed) score += 0.1;
	score -= Math.min(3, preference.contradictionCount) * 0.15;
	if (preference.status === "pending") score = Math.min(score, 0.69);
	if (preference.status === "superseded") score = Math.min(score, 0.4);
	if (preference.status === "rejected") score = Math.min(score, 0.2);
	return roundConfidence(score);
}

export function preferenceId(statement: string, scope: TasteScope): string {
	const digest = createHash("sha256").update(`${scope}\0${normalizePreferenceKey(statement)}`).digest("hex").slice(0, 12);
	return `${scope === "global" ? "g" : "p"}_${digest}`;
}

export function isLowSignalFeedback(text: string): boolean {
	let normalized = text.normalize("NFKC").trim().toLocaleLowerCase().replace(/[\s.!！?？,，。~～]+/g, " ").trim();
	if (!normalized) return true;
	normalized = normalized
		.replace(/\bthank you\b/g, "thanks")
		.replace(/\bgo on\b/g, "continue")
		.replace(/\blooks good\b/g, "good")
		.replace(/\bno problem\b/g, "ok");
	const acknowledgements = new Set([
		"ok",
		"okay",
		"yes",
		"yep",
		"sure",
		"good",
		"great",
		"nice",
		"thank",
		"thanks",
		"continue",
		"proceed",
		"lgtm",
		"好",
		"好的",
		"行",
		"可以",
		"继续",
		"请继续",
		"谢谢",
		"不错",
		"很好",
		"没问题",
		"就这样",
	]);
	return normalized.split(" ").every((token) => acknowledgements.has(token));
}

function hasDurableMarker(text: string): boolean {
	return /(?:\b(?:always|never|remember|prefer|preference|from now on|going forward|by default|unless|must|do not|don't|all (?:my )?projects|future (?:tasks|work))\b|以后|今后|从现在起|记住|偏好|喜欢|不喜欢|始终|永远|默认|除非|必须|不要|不得|未经|所有项目|每个项目|后续)/i.test(
		text,
	);
}

function hasTurnOnlyMarker(text: string): boolean {
	return /(?:\b(?:this time|for this (?:task|turn|request)|for now|right now|not yet|today|temporarily)\b|这次|本次|当前任务|这一轮|暂时|临时|先别|先不要|现在先)/i.test(
		text,
	);
}

function hasExplicitGlobalScopeMarker(text: string): boolean {
	return /(?:\b(?:all|every|any)\s+(?:my\s+)?(?:projects?|repos?|repositories|codebases?|workspaces?|responses?|answers?|coding tasks?)\b|\bacross\s+(?:all\s+)?(?:projects?|repos?|repositories|codebases?|workspaces?)\b|\bglobally\b|\bglobal\s+(?:preference|default|habit|rule)\b|\bmy\s+(?:global\s+)?default\b|\bmy\s+general\s+preference\b|所有(?:的)?(?:项目|仓库|代码库|工作区|回答|编码任务)|每个(?:项目|仓库|代码库|工作区)|任何(?:项目|仓库|代码库|工作区)|全部(?:项目|仓库|代码库|工作区)|跨项目|全局(?:偏好|习惯|默认|规则)?|我的(?:全局)?默认(?:习惯|偏好)?)/i.test(
		text,
	);
}

function cleanStatement(value: string): string {
	return value
		.trim()
		.replace(/^[-*]\s+/, "")
		.replace(/\s+Confidence:\s*(?:0(?:\.\d+)?|1(?:\.0+)?)\s*\.?\s*$/i, "")
		.replace(/\s+/g, " ")
		.trim();
}

function quoteAppearsInFeedback(quote: string, feedback: string): boolean {
	const needle = quote.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
	const haystack = feedback.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
	return needle.length >= 2 && haystack.includes(needle);
}

function validateProposal(
	proposal: ObserverProposal,
	feedback: string,
	projectAvailable: boolean,
	allowExplicit: boolean,
	allowGlobalLearning: boolean,
): { proposal?: ValidatedProposal; reason?: string } {
	if (!proposal || typeof proposal !== "object") return { reason: "proposal is not an object" };
	const statement = cleanStatement(typeof proposal.statement === "string" ? proposal.statement : "");
	const quote = typeof proposal.quote === "string" ? proposal.quote.trim() : "";
	if (statement.length < 6 || statement.length > MAX_STATEMENT_CHARS) return { reason: "invalid statement length" };
	if (!normalizePreferenceKey(statement)) return { reason: "empty normalized statement" };
	if (quote.length < 2 || quote.length > MAX_QUOTE_CHARS || !quoteAppearsInFeedback(quote, feedback)) {
		return { reason: "evidence quote is not an exact excerpt of the current user feedback" };
	}
	if (proposal.scope !== "global" && proposal.scope !== "project") return { reason: "invalid scope" };
	const globalScopeConstrained =
		proposal.scope === "global" && (!allowGlobalLearning || !hasExplicitGlobalScopeMarker(feedback));
	const effectiveScope = globalScopeConstrained ? "project" : proposal.scope;
	if (effectiveScope === "project" && !projectAvailable) {
		return { reason: "project scope is unavailable for the current working directory" };
	}
	if (proposal.signal !== "explicit_preference" && proposal.signal !== "implicit_correction") {
		return { reason: "invalid evidence signal" };
	}
	if (proposal.persistence === "turn_only" || hasTurnOnlyMarker(quote)) {
		return { reason: "turn-only constraints are never persisted" };
	}
	if (proposal.persistence !== "durable" && proposal.persistence !== "uncertain") {
		return { reason: "invalid persistence" };
	}
	if (
		!proposal.relation ||
		!(["new", "supports", "contradicts", "refines"] as const).includes(proposal.relation.type) ||
		!(proposal.relation.preferenceId === null || typeof proposal.relation.preferenceId === "string")
	) {
		return { reason: "invalid relation" };
	}

	const explicitIsGrounded =
		allowExplicit &&
		proposal.signal === "explicit_preference" &&
		proposal.persistence === "durable" &&
		hasDurableMarker(quote) &&
		!hasTurnOnlyMarker(quote);
	return {
		proposal: {
			...proposal,
			scope: effectiveScope,
			statement,
			quote,
			effectiveSignal: explicitIsGrounded ? "explicit_preference" : "implicit_correction",
			...(globalScopeConstrained
				? {
						scopeConstraintReason: allowGlobalLearning
							? "Global scope was not explicit; constrained to project scope"
							: "Global learning is off; constrained to project scope",
					}
				: {}),
		},
	};
}

function addEvidence(preference: Preference, evidence: PreferenceEvidence): boolean {
	if (preference.evidence.some((item) => item.eventId === evidence.eventId && item.signal === evidence.signal)) return false;
	preference.evidence.push(evidence);
	if (evidence.signal === "explicit_preference" || evidence.signal === "implicit_correction" || evidence.signal === "manual") {
		preference.supportCount += 1;
	}
	return true;
}

function newPreference(proposal: ValidatedProposal, context: ReductionContext): Preference {
	const explicit = proposal.effectiveSignal === "explicit_preference";
	const evidence: PreferenceEvidence = {
		eventId: context.eventId,
		at: context.at,
		quote: proposal.quote,
		signal: proposal.effectiveSignal,
		...(context.sessionId ? { sessionId: context.sessionId } : {}),
	};
	const preference: Preference = {
		id: preferenceId(proposal.statement, proposal.scope),
		statement: proposal.statement,
		key: normalizePreferenceKey(proposal.statement),
		scope: proposal.scope,
		status: explicit ? "approved" : "pending",
		source: "observer",
		createdAt: context.at,
		updatedAt: context.at,
		evidence: [evidence],
		supportCount: 1,
		contradictionCount: 0,
		reviewed: false,
		confidence: 0.36,
		conflictsWith: [],
		supersedes: [],
	};
	preference.confidence = computeConfidence(preference);
	return preference;
}

function updateExisting(
	preference: Preference,
	proposal: ValidatedProposal,
	context: ReductionContext,
): ReductionChange {
	const wasPending = preference.status === "pending";
	const signal = proposal.effectiveSignal;
	const added = addEvidence(preference, {
		eventId: context.eventId,
		at: context.at,
		quote: proposal.quote,
		signal,
		...(context.sessionId ? { sessionId: context.sessionId } : {}),
	});
	if (!added) {
		return {
			preferenceId: preference.id,
			action: "skipped",
			status: preference.status,
			reason: "event already counted",
			statement: preference.statement,
			scope: preference.scope,
		};
	}
	if (preference.status === "rejected" || preference.status === "superseded") {
		if (signal === "explicit_preference") preference.status = "approved";
		else preference.status = "pending";
	}
	if (preference.status === "pending" && (signal === "explicit_preference" || preference.supportCount >= 2)) {
		preference.status = "approved";
	}
	preference.updatedAt = context.at;
	preference.confidence = computeConfidence(preference);
	return {
		preferenceId: preference.id,
		action: wasPending && preference.status === "approved" ? "approved" : "reinforced",
		status: preference.status,
		statement: preference.statement,
		scope: preference.scope,
		...(proposal.scopeConstraintReason ? { reason: proposal.scopeConstraintReason } : {}),
	};
}

function applyToFile(
	file: PreferenceFile,
	proposals: ValidatedProposal[],
	context: ReductionContext,
	allExisting: Map<string, Preference>,
): ReductionChange[] {
	const changes: ReductionChange[] = [];
	for (const proposal of proposals) {
		const exact = file.preferences.find((item) => item.key === normalizePreferenceKey(proposal.statement));
		const related = proposal.relation.preferenceId
			? allExisting.get(proposal.relation.preferenceId)
			: undefined;
		const sameScopeRelated = related?.scope === proposal.scope
			? file.preferences.find((item) => item.id === related.id)
			: undefined;

		if (exact && proposal.relation.type !== "contradicts" && proposal.relation.type !== "refines") {
			changes.push(updateExisting(exact, proposal, context));
			allExisting.set(exact.id, exact);
			continue;
		}
		if (sameScopeRelated && proposal.relation.type === "supports") {
			changes.push(updateExisting(sameScopeRelated, proposal, context));
			allExisting.set(sameScopeRelated.id, sameScopeRelated);
			continue;
		}

		if (exact) {
			changes.push(updateExisting(exact, proposal, context));
			allExisting.set(exact.id, exact);
			continue;
		}

		const created = newPreference(proposal, context);
		if (related && (proposal.relation.type === "contradicts" || proposal.relation.type === "refines")) {
			created.conflictsWith.push(related.id);
			if (proposal.effectiveSignal === "explicit_preference" && sameScopeRelated) {
				sameScopeRelated.status = "superseded";
				sameScopeRelated.contradictionCount += 1;
				sameScopeRelated.updatedAt = context.at;
				sameScopeRelated.confidence = computeConfidence(sameScopeRelated);
				created.supersedes.push(sameScopeRelated.id);
				changes.push({
					preferenceId: sameScopeRelated.id,
					action: "superseded",
					status: sameScopeRelated.status,
					statement: sameScopeRelated.statement,
					scope: sameScopeRelated.scope,
				});
			} else if (sameScopeRelated) {
				sameScopeRelated.contradictionCount += 1;
				sameScopeRelated.updatedAt = context.at;
				sameScopeRelated.confidence = computeConfidence(sameScopeRelated);
			}
		}
		file.preferences.push(created);
		allExisting.set(created.id, created);
		changes.push({
			preferenceId: created.id,
			action: "added",
			status: created.status,
			statement: created.statement,
			scope: created.scope,
			...(proposal.scopeConstraintReason ? { reason: proposal.scopeConstraintReason } : {}),
		});
	}
	return changes;
}

export async function reduceObserverResult(
	result: ObserverResult,
	context: ReductionContext,
	globalPaths: StorePaths,
	projectPaths?: StorePaths,
): Promise<ReductionResult> {
	const changes: ReductionChange[] = [];
	const globalSnapshot = await loadPreferenceFile(globalPaths);
	const projectSnapshot = projectPaths ? await loadPreferenceFile(projectPaths) : undefined;
	const allExisting = new Map<string, Preference>();
	for (const preference of [...globalSnapshot.preferences, ...(projectSnapshot?.preferences ?? [])]) {
		allExisting.set(preference.id, preference);
	}

	const validated: ValidatedProposal[] = [];
	const eventKeys = new Set<string>();
	const classificationAllowsLearning =
		result.classification.kind === "explicit_preference" || result.classification.kind === "implicit_correction";
	if (!classificationAllowsLearning && result.proposals.length > 0) {
		return {
			changes: result.proposals.slice(0, MAX_PROPOSALS).map(() => ({
				action: "skipped" as const,
				reason: `classification ${result.classification.kind} is not persistable`,
			})),
		};
	}
	for (const raw of result.proposals.slice(0, MAX_PROPOSALS)) {
		const checked = validateProposal(
			raw,
			context.userFeedback,
			Boolean(projectPaths),
			result.classification.kind === "explicit_preference",
			context.allowGlobalLearning,
		);
		if (!checked.proposal) {
			changes.push({ action: "skipped", reason: checked.reason });
			continue;
		}
		const eventKey = `${checked.proposal.scope}:${normalizePreferenceKey(checked.proposal.statement)}`;
		if (eventKeys.has(eventKey)) {
			changes.push({ action: "skipped", reason: "duplicate proposal in one feedback event" });
			continue;
		}
		eventKeys.add(eventKey);
		validated.push(checked.proposal);
	}

	const globalProposals = validated.filter((proposal) => proposal.scope === "global");
	if (globalProposals.length > 0) {
		changes.push(...(await mutatePreferenceFile(globalPaths, (file) => applyToFile(file, globalProposals, context, allExisting))));
	}
	const projectProposals = validated.filter((proposal) => proposal.scope === "project");
	if (projectPaths && projectProposals.length > 0) {
		changes.push(
			...(await mutatePreferenceFile(projectPaths, (file) => applyToFile(file, projectProposals, context, allExisting))),
		);
	}
	return { changes };
}

export interface RememberPreferenceResult {
	preference: Preference;
	action: "added" | "reinforced" | "approved";
}

export async function rememberPreferences(
	paths: StorePaths,
	statementInputs: string[],
	context: MutationContext,
): Promise<RememberPreferenceResult[]> {
	const statements = statementInputs.map(cleanStatement);
	if (statements.some((statement) => statement.length < 4 || statement.length > MAX_STATEMENT_CHARS)) {
		throw new Error(`Each preference must be between 4 and ${MAX_STATEMENT_CHARS} characters.`);
	}
	return mutatePreferenceFile(paths, (file) => {
		const results: RememberPreferenceResult[] = [];
		for (const statement of statements) {
			const key = normalizePreferenceKey(statement);
			let preference = file.preferences.find((item) => item.key === key);
			const priorStatus = preference?.status;
			if (!preference) {
				preference = {
					id: preferenceId(statement, paths.scope),
					statement,
					key,
					scope: paths.scope,
					status: "approved",
					source: "manual",
					createdAt: context.at,
					updatedAt: context.at,
					evidence: [],
					supportCount: 0,
					contradictionCount: 0,
					reviewed: true,
					confidence: 1,
					conflictsWith: [],
					supersedes: [],
				};
				file.preferences.push(preference);
			}
			preference.status = "approved";
			preference.source = "manual";
			preference.reviewed = true;
			preference.updatedAt = context.at;
			addEvidence(preference, {
				eventId: context.eventId,
				at: context.at,
				quote: statement,
				signal: "manual",
				...(context.sessionId ? { sessionId: context.sessionId } : {}),
			});
			preference.confidence = computeConfidence(preference);
			results.push({
				preference,
				action: priorStatus === undefined ? "added" : priorStatus === "approved" ? "reinforced" : "approved",
			});
		}
		return results;
	});
}

export async function rememberPreference(
	paths: StorePaths,
	statementInput: string,
	context: MutationContext,
): Promise<Preference> {
	return (await rememberPreferences(paths, [statementInput], context))[0].preference;
}

export async function setPreferenceReview(
	paths: StorePaths,
	id: string,
	action: "approve" | "reject",
	context: MutationContext,
): Promise<Preference> {
	return mutatePreferenceFile(paths, (file) => {
		const preference = file.preferences.find((item) => item.id === id);
		if (!preference) throw new Error(`Preference not found: ${id}`);
		preference.status = action === "approve" ? "approved" : "rejected";
		preference.reviewed = true;
		preference.updatedAt = context.at;
		if (!preference.evidence.some((item) => item.eventId === context.eventId)) {
			preference.evidence.push({
				eventId: context.eventId,
				at: context.at,
				quote: action,
				signal: "review",
				...(context.sessionId ? { sessionId: context.sessionId } : {}),
			});
		}
		preference.confidence = computeConfidence(preference);
		return preference;
	});
}

export interface MovePreferenceResult {
	source: Preference;
	target: Preference;
	targetExisted: boolean;
}

export async function movePreference(
	sourcePaths: StorePaths,
	targetPaths: StorePaths,
	id: string,
	context: MutationContext,
): Promise<MovePreferenceResult> {
	if (sourcePaths.scope === targetPaths.scope) throw new Error(`Preference is already ${targetPaths.scope}.`);
	// Persist the target first. A rare second-write failure leaves duplicate active content,
	// which injection deduplicates, rather than dropping the preference from both scopes.
	return mutatePreferenceFiles([targetPaths, sourcePaths], (files) => {
		const sourceFile = files.get(sourcePaths.scope)!;
		const targetFile = files.get(targetPaths.scope)!;
		const source = sourceFile.preferences.find((item) => item.id === id);
		if (!source) throw new Error(`Preference not found: ${id}`);
		const targetKey = normalizePreferenceKey(source.statement);
		let target = targetFile.preferences.find((item) => item.key === targetKey);
		const targetExisted = Boolean(target);
		const reviewEvidence: PreferenceEvidence = {
			eventId: context.eventId,
			at: context.at,
			quote: `move to ${targetPaths.scope}`,
			signal: "review",
			...(context.sessionId ? { sessionId: context.sessionId } : {}),
		};
		if (!target) {
			target = {
				...structuredClone(source),
				id: preferenceId(source.statement, targetPaths.scope),
				scope: targetPaths.scope,
				status: "approved",
				updatedAt: context.at,
				reviewed: true,
				evidence: [...structuredClone(source.evidence), reviewEvidence],
				supersedes: Array.from(new Set([...source.supersedes, source.id])),
			};
			targetFile.preferences.push(target);
		} else {
			const evidence = [...target.evidence];
			const evidenceKeys = new Set(evidence.map((item) => `${item.eventId}\0${item.signal}\0${item.quote}`));
			for (const item of [...source.evidence, reviewEvidence]) {
				const key = `${item.eventId}\0${item.signal}\0${item.quote}`;
				if (evidenceKeys.has(key)) continue;
				evidenceKeys.add(key);
				evidence.push(structuredClone(item));
			}
			target.evidence = evidence;
			target.status = "approved";
			target.reviewed = true;
			target.updatedAt = context.at;
			target.source = target.source === "manual" || source.source === "manual" ? "manual" : "observer";
			target.supersedes = Array.from(new Set([...target.supersedes, ...source.supersedes, source.id]));
			target.conflictsWith = Array.from(new Set([...target.conflictsWith, ...source.conflictsWith])).filter(
				(conflictId) => conflictId !== source.id && conflictId !== target!.id,
			);
		}
		target.supportCount = target.evidence.filter((item) => item.signal !== "review").length;
		target.confidence = computeConfidence(target);
		source.status = "superseded";
		source.reviewed = true;
		source.updatedAt = context.at;
		source.confidence = computeConfidence(source);
		return { source, target, targetExisted };
	});
}

export async function forgetPreference(
	paths: StorePaths,
	id: string,
	context: MutationContext,
): Promise<Preference> {
	return setPreferenceReview(paths, id, "reject", context);
}
