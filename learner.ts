import type { UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { InteractionContext, ObserverUsage, Preference, StorePaths, TasteConfig } from "./types.ts";
import {
	clipText,
	getTasteStructure,
	isValidTasteFilePath,
	loadPreferences,
	reorganizeIfNeeded,
	resolveTastePath,
} from "./storage.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const LEARNER_MAX_TURNS = 20;

export const LEARNER_SYSTEM_PROMPT = `You are the taste-learning agent for Command Code. Review the NEW messages and the user's current taste files, then record DURABLE, generalizable preferences the user revealed — coding style, tooling, workflow, and communication preferences — not one-off task details.

Learn ONLY from the NEW messages. The previously analyzed conversation was already mined by earlier passes — it is provided so you can resolve references, never to be re-learned. Do NOT re-record a preference that already exists in the taste files, and do NOT raise or lower an existing learning's confidence unless the NEW messages themselves contain fresh evidence for it. Seeing the same preference again in the previously analyzed context is not evidence.

Use the tools to update taste files. A taste file path MUST be either "taste.md" (the root file) or "{category}/taste.md" (a single category folder) — never any other name or nesting:
- write_taste_file to create/replace a file.
- edit_taste_file to amend an existing file.
- read_taste_file to inspect a file before editing.

Record each learning as a markdown bullet ending in a confidence score, e.g.
  - Prefers tabs over spaces. Confidence: 0.9
Only record clear, repeated, or explicitly-stated preferences. Prefer amending existing files over creating near-duplicates. When the new messages reveal nothing durable, make no tool calls and reply "no changes".`;

export const LEARNER_TOOLS = [
	{
		name: "read_taste_file",
		description: 'Read a taste file. Path is relative to the taste directory: "taste.md" or "{category}/taste.md".',
		parameters: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		},
	},
	{
		name: "write_taste_file",
		description: 'Create or replace a taste file. Path MUST be "taste.md" or "{category}/taste.md".',
		parameters: {
			type: "object",
			properties: {
				path: { type: "string" },
				content: { type: "string" },
			},
			required: ["path", "content"],
		},
	},
	{
		name: "edit_taste_file",
		description: 'Replace the first occurrence of old_text with new_text in a taste file. Path MUST be "taste.md" or "{category}/taste.md".',
		parameters: {
			type: "object",
			properties: {
				path: { type: "string" },
				old_text: { type: "string" },
				new_text: { type: "string" },
			},
			required: ["path", "old_text", "new_text"],
		},
	},
] as const;

// ---------------------------------------------------------------------------
// Conversation assembly (Command Code runLearningLoop 1:1)
// ---------------------------------------------------------------------------

interface ConversationSegment {
	previous: unknown[];
	current: unknown[];
}

export function isLearnableMessage(message: any): boolean {
	const meta = message?.meta;
	// Mirror Command Code: automated/meta/summary/tool-result messages are excluded.
	return !(
		meta?.isAutomated ||
		meta?.isMeta ||
		meta?.isSummary ||
		(message?.role === "user" && Array.isArray(message.content) && message.content.some((part: any) => part?.type === "toolResult")) ||
		(message?.role === "user" && meta?.source && meta.source !== "user")
	);
}

export function stripReasoning(message: any): any {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return message;
	const content = message.content.filter((part: any) => part?.type !== "thinking");
	return content.length === message.content.length ? message : { ...message, content };
}

export function buildLeanerInput(
	interaction: InteractionContext,
	tasteStructure: string,
	previousMessages: any[],
	newMessages: any[],
	sessionSummary?: string,
): string {
	const visible = (messages: any[]) =>
		messages
			.map((message) => stripReasoning(message))
			.filter((message) => isLearnableMessage(message) || message.role === "assistant")
			.map((message) => ({
				role: message.role,
				content: message.content
					?.filter((part: any) => part?.type === "text" || part?.type === "toolCall" || part?.type === "toolResult")
					.map((part: any) => ({
						type: part.type,
						...(part.type === "text" ? { text: part.text } : {}),
						...(part.type === "toolCall" ? { name: part.name, arguments: part.arguments } : {}),
						...(part.type === "toolResult" ? { toolCallId: part.toolCallId, content: part.content } : {}),
					})),
			}));
	const previousVisible = visible(previousMessages);
	const currentVisible = visible(newMessages);
	return [
		sessionSummary ? `Session summary:\n${clipText(sessionSummary, 3_000)}\n\n` : "",
		`Current taste structure:\n${tasteStructure}\n\n`,
		`Previously analyzed conversation (context only — already processed in earlier passes, do NOT learn from it again):\n${
			previousVisible.length > 0 ? JSON.stringify(previousVisible, null, 2) : "(none)"
		}\n\n`,
		`NEW messages to analyze (learn ONLY from these):\n${JSON.stringify(currentVisible, null, 2)}`,
	].join("");
}

// ---------------------------------------------------------------------------
// Tool execution (Command Code runTasteTool 1:1)
// ---------------------------------------------------------------------------

export async function runTasteTool(
	paths: StorePaths,
	name: string,
	input: Record<string, unknown>,
): Promise<string> {
	const relative = typeof input.path === "string" ? input.path : "";
	const resolved = resolveTastePath(paths, relative);
	if (!resolved) return "error: path must be inside the taste directory";
	const { absolute, segments } = resolved;
	if (name === "read_taste_file") {
		try {
			return await readFile(absolute, "utf8");
		} catch {
			return "(file does not exist)";
		}
	}
	const isWrite = name === "write_taste_file";
	if (!isWrite && name !== "edit_taste_file") return `error: unknown tool ${name}`;
	if (!isValidTasteFilePath(segments)) {
		return 'error: taste file must be "taste.md" or "{category}/taste.md"';
	}
	try {
		const exists = await statFile(absolute);
		const before = exists ? await readFile(absolute, "utf8") : "";
		if (isWrite) {
			const content = typeof input.content === "string" ? input.content : "";
			await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
			await writeFile(absolute, content, { encoding: "utf8", mode: 0o600 });
			return `wrote ${relative}`;
		}
		if (!exists) return "error: file does not exist";
		const oldText = typeof input.old_text === "string" ? input.old_text : "";
		const newText = typeof input.new_text === "string" ? input.new_text : "";
		if (!before.includes(oldText)) return "error: old_text not found";
		await writeFile(absolute, before.replace(oldText, newText), { encoding: "utf8", mode: 0o600 });
		return `edited ${relative}`;
	} catch (error) {
		return `error: ${error instanceof Error ? error.message : String(error)}`;
	}
}

async function statFile(path: string): Promise<boolean> {
	try {
		await readFile(path, "utf8");
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Learner loop (Command Code createLearner 1:1)
// ---------------------------------------------------------------------------

export interface LearnerRunResult {
	changes: Array<{ action: string; statement?: string; file?: string }>;
}

export async function runLearner(
	ctx: ExtensionContext,
	config: TasteConfig,
	paths: StorePaths,
	interaction: InteractionContext,
	previousMessages: any[],
	newMessages: any[],
	existingScopePreferences: Preference[],
	allowGlobal: boolean,
): Promise<LearnerRunResult> {
	const model = resolveTasteModel(ctx, config);
	if (!model) throw new Error("No Taste Learner model is available.");

	// Ensure dir/file exist (Command Code initTasteDir).
	await mkdir(paths.dir, { recursive: true, mode: 0o700 });
	await import("node:fs/promises").then(async ({ access }) => {
		try {
			await access(paths.taste);
		} catch {
			await writeFile(paths.taste, "", { encoding: "utf8", mode: 0o600 });
		}
	});

	const tasteStructure = await getTasteStructure(paths);
	const userPrompt = buildLeanerInput(interaction, tasteStructure, previousMessages, newMessages);

	const messages: any[] = [
		{
			role: "user",
			content: [{ type: "text", text: userPrompt }],
			timestamp: Date.now(),
		},
	];

	const changes: LearnerRunResult["changes"] = [];
	const signal = AbortSignal.timeout(config.observer.timeoutMs);
	for (let turn = 0; turn < LEARNER_MAX_TURNS; turn++) {
		const response = await ctx.modelRegistry.complete(
			model,
			{
				systemPrompt: LEARNER_SYSTEM_PROMPT,
				messages,
				tools: LEARNER_TOOLS as any,
			},
			{
				signal,
				timeoutMs: config.observer.timeoutMs,
				maxRetries: 1,
				maxTokens: config.observer.maxOutputTokens,
				reasoning: config.observer.reasoning,
			},
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			throw new Error(response.errorMessage || `Learner stopped with ${response.stopReason}`);
		}
		const toolCalls = response.content.filter((part): part is Extract<typeof part, { type: "toolCall" }> => part.type === "toolCall");
		if (toolCalls.length === 0) break;
		messages.push({ role: "assistant", content: response.content, timestamp: Date.now() });
		for (const call of toolCalls) {
			const input = (call.arguments ?? {}) as Record<string, unknown>;
			const result = await runTasteTool(paths, call.name, input);
			messages.push({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: result }],
				timestamp: Date.now(),
			});
			if (result.startsWith("wrote") || result.startsWith("edited")) {
				changes.push({ action: result, file: typeof input.path === "string" ? input.path : undefined });
			}
		}
	}

	// Command Code reorganizeIfNeeded after the loop.
	const moved = await reorganizeIfNeeded(paths);
	for (const item of moved) changes.push({ action: `reorganized ${item.category} → ${item.moved} learnings` });

	return { changes };
}

export function resolveTasteModel(
	ctx: ExtensionContext,
	config: TasteConfig,
	override?: { provider: string; model: string },
) {
	if (override) {
		const model = ctx.modelRegistry.find(override.provider, override.model);
		return model && ctx.modelRegistry.hasConfiguredAuth(model) ? model : undefined;
	}
	if (config.observer.modelMode === "inherit") {
		return ctx.model && ctx.modelRegistry.hasConfiguredAuth(ctx.model) ? ctx.model : undefined;
	}
	for (const reference of config.observer.models) {
		const model = ctx.modelRegistry.find(reference.provider, reference.model);
		if (model && ctx.modelRegistry.hasConfiguredAuth(model)) return model;
	}
	return undefined;
}

export async function collectObserverUsage(): Promise<ObserverUsage | undefined> {
	return undefined;
}
