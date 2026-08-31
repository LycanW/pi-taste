export type TasteScope = "global" | "project";

/**
 * A single learned preference line in taste.md.
 * v3: taste.md is the single authoritative file. No state machine, no audit,
 * no evidence arrays. Format is Command Code compatible:
 *   - statement. Confidence: 0-n
 */
export interface Preference {
	id: string;
	statement: string;
	scope: TasteScope;
	confidence: number;
}

export interface ObserverModelRef {
	provider: string;
	model: string;
}

export interface TasteConfig {
	version: 3;
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
		maxChars: number;
	};
}

/** Visible conversational context for the Learner: user/assistant text only. */
export interface InteractionContext {
	userText: string;
	assistantText: string;
	summary?: string;
}

export interface ObserverUsage {
	provider: string;
	model: string;
	inputTokens?: number;
	outputTokens?: number;
	cost?: number;
}

export interface StorePaths {
	dir: string;
	taste: string;
	lock: string;
	scope: TasteScope;
	projectRoot?: string;
}

export interface ImportedTaste {
	scope: TasteScope;
	statement: string;
	confidence: number;
	sourcePath: string;
}

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
