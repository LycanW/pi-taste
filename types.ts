export type TasteScope = "global" | "project";
export type PreferenceStatus = "approved" | "pending" | "rejected" | "superseded";
export type EvidenceSignal = "explicit_preference" | "implicit_correction" | "manual" | "review";

export interface PreferenceEvidence {
	eventId: string;
	at: string;
	quote: string;
	signal: EvidenceSignal;
	sessionId?: string;
}

export interface Preference {
	id: string;
	statement: string;
	key: string;
	scope: TasteScope;
	status: PreferenceStatus;
	source: "observer" | "manual";
	createdAt: string;
	updatedAt: string;
	evidence: PreferenceEvidence[];
	supportCount: number;
	contradictionCount: number;
	reviewed: boolean;
	confidence: number;
	conflictsWith: string[];
	supersedes: string[];
}

export interface PreferenceFile {
	version: 1;
	updatedAt: string;
	preferences: Preference[];
}

export interface ObserverModelRef {
	provider: string;
	model: string;
}

export interface TasteConfig {
	version: 1;
	learningEnabled: boolean;
	injectionEnabled: boolean;
	observer: {
		modelMode: "inherit" | "custom";
		models: ObserverModelRef[];
		reasoning: "minimal" | "low" | "medium";
		maxOutputTokens: number;
		timeoutMs: number;
		maxInputChars: number;
	};
	injection: {
		includeCommandCode: boolean;
		maxPreferences: number;
		maxChars: number;
	};
}

export type FeedbackKind =
	| "explicit_preference"
	| "implicit_correction"
	| "task_constraint"
	| "correctness_fix"
	| "acknowledgement"
	| "unrelated_request"
	| "none";

export interface ObserverProposal {
	statement: string;
	scope: TasteScope;
	signal: "explicit_preference" | "implicit_correction";
	persistence: "durable" | "uncertain" | "turn_only";
	quote: string;
	relation: {
		type: "new" | "supports" | "contradicts" | "refines";
		preferenceId: string | null;
	};
}

export interface ObserverResult {
	classification: {
		kind: FeedbackKind;
		reason: string;
	};
	proposals: ObserverProposal[];
}

export interface AgentOutcome {
	at: string;
	assistantText: string;
	toolSummary: Array<{
		name: string;
		path?: string;
		isError?: boolean;
	}>;
	changedFiles: string[];
}

export interface ReductionChange {
	preferenceId?: string;
	action: "added" | "reinforced" | "approved" | "rejected" | "superseded" | "skipped";
	status?: PreferenceStatus;
	reason?: string;
	statement?: string;
	scope?: TasteScope;
}

export interface ReductionResult {
	changes: ReductionChange[];
}

export interface ObserverUsage {
	provider: string;
	model: string;
	inputTokens?: number;
	outputTokens?: number;
	cost?: number;
}

export interface TasteEvent {
	version: 1;
	id: string;
	timestamp: string;
	type: "observer" | "manual" | "import" | "move" | "review" | "forget" | "config" | "curate";
	sessionId?: string;
	projectRoot?: string;
	interaction?: {
		previousAgentOutcome?: AgentOutcome;
		currentUserFeedback: string;
	};
	observer?: {
		status: "completed" | "skipped" | "failed";
		result?: ObserverResult;
		usage?: ObserverUsage;
		reason?: string;
	};
	reducer?: ReductionResult;
	details?: Record<string, unknown>;
}

export type CurationOperationType = "merge" | "rewrite" | "supersede" | "flag_conflict" | "move_scope";

export interface CurationOperation {
	id: string;
	type: CurationOperationType;
	sourceIds: string[];
	statement?: string;
	targetScope?: TasteScope;
	winnerId?: string;
	reason: string;
}

export interface CurationPlan {
	version: 1;
	id: string;
	createdAt: string;
	projectRoot?: string;
	model: ObserverModelRef;
	snapshotHash: string;
	summary: string;
	operations: CurationOperation[];
	appliedAt?: string;
}

export interface StorePaths {
	dir: string;
	preferences: string;
	taste: string;
	events: string;
	lock: string;
	scope: TasteScope;
	projectRoot?: string;
}

export interface ImportedTaste {
	scope: TasteScope;
	statement: string;
	sourcePath: string;
}
