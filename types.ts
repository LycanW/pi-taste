export type TasteScope = "global" | "project";

/**
 * A single learned preference line in taste.md.
 * v2: taste.md is the single authoritative file. History and evidence live in
 * Pi session JSONL; this struct is only the current effective conclusion plus
 * the minimal operational state needed for safe injection.
 */
export interface Preference {
	id: string;
	statement: string;
	scope: TasteScope;
	/** approved = injected; pending = awaiting review; rejected/superseded = excluded. */
	status: "approved" | "pending" | "rejected" | "superseded";
	/** Model-maintained 0..1 like Command Code's "Confidence: 0.9". */
	confidence: number;
	/** Optional short exact user excerpt that justified this line (best effort). */
	quote?: string;
}

export interface ObserverModelRef {
	provider: string;
	model: string;
}

export interface TasteConfig {
	version: 2;
	learningEnabled: boolean;
	observer: {
		modelMode: "inherit" | "custom";
		models: ObserverModelRef[];
		reasoning: "minimal" | "low" | "medium";
		maxOutputTokens: number;
		timeoutMs: number;
		maxInputChars: number;
	};
	injection: {
		maxPreferences: number;
		maxChars: number;
	};
}

/** v2 Learner result — semantic, self-determined; no classification buckets. */
export interface LearnerProposal {
	statement: string;
	scope: TasteScope;
	confidence: number;
	/** true = explicitly stated by the user; false = inferred from behavior/correction. */
	explicit: boolean;
	quote?: string;
}

export interface LearnerResult {
	/** "no changes" when nothing durable; otherwise list of learnings. */
	learnings: LearnerProposal[];
}

/** Visible conversational context for the Learner: user/assistant text only. */
export interface InteractionContext {
	userText: string;
	assistantText: string;
	summary?: string;
}

export interface ReductionChange {
	preferenceId?: string;
	action: "added" | "reinforced" | "approved" | "rejected" | "superseded" | "skipped";
	status?: Preference["status"];
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
	version: 2;
	id: string;
	timestamp: string;
	type: "observer" | "manual" | "import" | "move" | "review" | "forget" | "config" | "curate";
	sessionId?: string;
	projectRoot?: string;
	interaction?: {
		userText: string;
		assistantText: string;
	};
	observer?: {
		status: "completed" | "skipped" | "failed";
		result?: LearnerResult;
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
	version: 2;
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
	taste: string;
	auditDir: string;
	audit: string;
	lock: string;
	scope: TasteScope;
	projectRoot?: string;
}

export interface ImportedTaste {
	scope: TasteScope;
	statement: string;
	sourcePath: string;
}
