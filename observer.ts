import type { UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	InteractionContext,
	LearnerResult,
	ObserverUsage,
	Preference,
	TasteConfig,
} from "./types.ts";
import { clipText } from "./storage.ts";

// v2: The Learner mirrors Command Code's taste-learning agent: the model
// receives visible conversation text and current taste structure, and decides
// semantically whether something durable was revealed. No classification
// buckets, no vocabulary gates.

export const LEARNER_SYSTEM_PROMPT = `You are Pi Taste Learner. Review the NEW user messages and the current taste file, then decide whether the user revealed a DURABLE, generalizable preference — coding style, tooling, workflow, or communication — not a one-off task detail.

Learn ONLY from the NEW user messages. The surrounding conversation is provided so you can resolve references, never to be re-learned. Do not re-record a preference that already exists in the taste file, and do not raise or lower an existing learning's confidence unless the NEW messages themselves contain fresh evidence.

Rules:
- The user's explicit statement ("always", "never", "from now on", "I prefer") is the strongest signal.
- A correction of the agent's style, choice, or approach is a tentative preference — record it with lower confidence.
- Silence, "ok", "good", "continue", and thanks are not preferences.
- A one-turn instruction ("this time", "for this task") is not durable unless it reveals a general rule.
- A factual correction ("that API returns null") is usually not taste.
- Do NOT invent preferences from your own analysis of the assistant's work. The user's words are the only evidence.
- Scope is project by default. Use global only if the user explicitly says it applies across projects/repositories. If global learning is disabled, always use project.

Return exactly one JSON object, no Markdown fences:
{
  "learnings": [
    {
      "statement": "concise reusable instruction",
      "scope": "project|global",
      "confidence": 0.9,
      "explicit": true,
      "quote": "short exact user excerpt (optional)"
    }
  ]
}

Return {"learnings": []} when nothing durable was revealed.`;

const STATEMENT_MAX = 500;
const QUOTE_MAX = 800;

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

/** Assemble the Learner input from visible conversation only. */
export function learnerInput(
	interaction: InteractionContext,
	preferences: Preference[],
	existingTaste: string,
	maxChars: number,
	allowGlobalLearning: boolean,
): string {
	const visible = preferences
		.slice(0, 200)
		.map((preference) => `- ${preference.statement}${preference.status === "pending" ? " [pending]" : ""}`)
		.join("\n");
	const payload = {
		CURRENT_USER_MESSAGE: clipText(interaction.userText, Math.floor(maxChars * 0.35)),
		SURROUNDING_CONVERSATION: clipText(interaction.assistantText, Math.floor(maxChars * 0.35)),
		...(interaction.summary ? { SESSION_SUMMARY: clipText(interaction.summary, Math.floor(maxChars * 0.2)) } : {}),
		GLOBAL_LEARNING_ENABLED: allowGlobalLearning,
		CURRENT_TASTE_FILE: visible || "(none)",
		EXISTING_TASTE_STRUCTURE: existingTaste ? clipText(existingTaste, Math.floor(maxChars * 0.1)) : "(none)",
	};
	return `DATA\n${clipText(JSON.stringify(payload, null, 2), maxChars)}\nEND_DATA`;
}

function extractJson(text: string): unknown {
	const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start < 0 || end <= start) throw new Error("Learner returned no JSON object");
	return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
}

function parseLearnerResult(value: unknown): LearnerResult {
	if (!value || typeof value !== "object") throw new Error("Learner JSON is not an object");
	const raw = value as Record<string, unknown>;
	if (!Array.isArray(raw.learnings)) throw new Error("Learner JSON learnings is not an array");
	const learnings = raw.learnings.map((item, index) => {
		if (!item || typeof item !== "object") throw new Error(`Learning ${index + 1} is not an object`);
		const proposal = item as Record<string, unknown>;
		const statement = typeof proposal.statement === "string" ? proposal.statement.trim() : "";
		const confidence =
			typeof proposal.confidence === "number" && Number.isFinite(proposal.confidence)
				? Math.min(1, Math.max(0, proposal.confidence))
				: 0.5;
		return {
			statement,
			scope: proposal.scope === "global" ? ("global" as const) : ("project" as const),
			confidence,
			explicit: proposal.explicit !== false,
			quote: typeof proposal.quote === "string" ? proposal.quote.slice(0, QUOTE_MAX) : undefined,
		};
	});
	return { learnings };
}

export async function observeFeedback(
	ctx: ExtensionContext,
	config: TasteConfig,
	interaction: InteractionContext,
	preferences: Preference[],
	existingTaste: string,
	allowGlobalLearning: boolean,
): Promise<{ result: LearnerResult; usage: ObserverUsage }> {
	const model = resolveTasteModel(ctx, config);
	if (!model) {
		const expected =
			config.observer.modelMode === "inherit"
				? "the current main model"
				: config.observer.models.map((item) => `${item.provider}/${item.model}`).join(", ") || "no custom model";
		throw new Error(`No Taste Learner model is available (${expected})`);
	}
	const message: UserMessage = {
		role: "user",
		content: [
			{
				type: "text",
				text: learnerInput(
					interaction,
					preferences,
					existingTaste,
					config.observer.maxInputChars,
					allowGlobalLearning,
				),
			},
		],
		timestamp: Date.now(),
	};
	const signal = AbortSignal.timeout(config.observer.timeoutMs);
	const response = await ctx.modelRegistry.complete(
		model,
		{ systemPrompt: LEARNER_SYSTEM_PROMPT, messages: [message] },
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
	const text = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	const result = parseLearnerResult(extractJson(text));
	return {
		result,
		usage: {
			provider: model.provider,
			model: model.id,
			inputTokens: response.usage?.input,
			outputTokens: response.usage?.output,
			cost: response.usage?.cost?.total,
		},
	};
}

export { STATEMENT_MAX, QUOTE_MAX };
