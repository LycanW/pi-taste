import { createHash, randomUUID } from "node:crypto";
import {
	ModelSelectorComponent,
	type ExtensionAPI,
	type ExtensionContext,
	type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import {
	appendTasteActivity,
	installTasteActivityRenderer,
	tasteActivityFiles,
	type TasteActivityChange,
	type TasteActivityData,
} from "./activity.ts";
import {
	applyCurationPlan,
	createCurationPlan,
	discardCurationPlan,
	formatCurationPlan,
	loadCurationPlan,
	parseCuratorModelOverride,
} from "./curator.ts";
import { installTasteFooter } from "./footer.ts";
import { readTasteImport } from "./importer.ts";
import { observeFeedback, resolveTasteModel } from "./observer.ts";
import {
	forgetPreference,
	isLowSignalFeedback,
	movePreference,
	reduceObserverResult,
	rememberPreference,
	rememberPreferences,
	setPreferenceReview,
} from "./reducer.ts";
import {
	appendEvent,
	clipText,
	ensureGlobalStore,
	findProjectRoot,
	globalStorePaths,
	loadCommandCodeTaste,
	loadConfig,
	loadPreferenceFile,
	normalizePreferenceKey,
	projectStorePaths,
	redactSensitive,
	regenerateTaste,
	saveConfig,
} from "./storage.ts";
import type {
	AgentOutcome,
	ObserverModelRef,
	ObserverResult,
	Preference,
	ReductionChange,
	StorePaths,
	TasteConfig,
	TasteEvent,
	TasteScope,
} from "./types.ts";

const MAX_OUTCOME_TEXT = 12_000;
const MAX_EVENT_FEEDBACK = 8_000;
const MAX_TOOL_ITEMS = 80;

function eventId(): string {
	return `e_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function feedbackFingerprint(prompt: string, previous: AgentOutcome | undefined, session: string | undefined): string {
	return createHash("sha256")
		.update(`${session ?? ""}\0${previous?.at ?? ""}\0${prompt}`)
		.digest("hex");
}

function parseModelReference(value: string): ObserverModelRef {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) {
		throw new Error(`Model must be provider/model, got: ${value}`);
	}
	return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

function modelReferenceText(reference: ObserverModelRef): string {
	return `${reference.provider}/${reference.model}`;
}

async function pickTasteModel(
	ctx: ExtensionContext,
	config: TasteConfig,
	initialSearchInput?: string,
): Promise<ObserverModelRef | undefined> {
	if (ctx.mode !== "tui") throw new Error("The interactive Taste model picker is available only in TUI mode.");
	// Pi exposes ModelSelectorComponent publicly, while its constructor currently
	// receives the ModelRuntime held by the extension-facing ModelRegistry facade.
	const runtime = (ctx.modelRegistry as unknown as { runtime?: ModelRuntime }).runtime;
	if (!runtime) throw new Error("Pi's model selector runtime is unavailable. Reload or update Pi.");
	const current = resolveTasteModel(ctx, config);
	return ctx.ui.custom<ObserverModelRef | undefined>((tui, _theme, _keybindings, done) =>
		new ModelSelectorComponent(
			tui,
			current,
			runtime,
			ctx.scopedModels,
			(model) => done({ provider: model.provider, model: model.id }),
			() => done(undefined),
			initialSearchInput,
		),
	);
}

function contentText(message: any): string {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n");
}

function toolPath(args: Record<string, unknown> | undefined): string | undefined {
	if (!args) return undefined;
	const value = args.path ?? args.file_path;
	return typeof value === "string" ? value.slice(0, 1_000) : undefined;
}

function summarizeAgentMessages(messages: any[]): AgentOutcome | undefined {
	const texts: string[] = [];
	const tools: AgentOutcome["toolSummary"] = [];
	const changed = new Set<string>();
	const errors = new Map<string, boolean>();
	for (const message of messages) {
		if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
			errors.set(message.toolCallId, Boolean(message.isError));
		}
	}
	for (const message of messages) {
		const text = contentText(message);
		if (text) texts.push(text);
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part?.type !== "toolCall" || typeof part.name !== "string") continue;
			const path = toolPath(part.arguments);
			tools.push({
				name: part.name.slice(0, 100),
				...(path ? { path } : {}),
				...(errors.has(part.id) ? { isError: errors.get(part.id) } : {}),
			});
			if ((part.name === "edit" || part.name === "write") && path) changed.add(path);
		}
	}
	if (texts.length === 0 && tools.length === 0) return undefined;
	return {
		at: new Date().toISOString(),
		assistantText: clipText(redactSensitive(texts.join("\n\n")), MAX_OUTCOME_TEXT),
		toolSummary: tools.slice(0, MAX_TOOL_ITEMS),
		changedFiles: Array.from(changed).slice(0, MAX_TOOL_ITEMS),
	};
}

function outcomeFromBranch(ctx: ExtensionContext): AgentOutcome | undefined {
	const messages: any[] = [];
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry: any = branch[index];
		if (entry?.type !== "message" || !entry.message) continue;
		if (entry.message.role === "user") break;
		messages.unshift(entry.message);
	}
	return summarizeAgentMessages(messages);
}

async function preferenceStores(cwd: string): Promise<{
	projectRoot?: string;
	globalPaths: StorePaths;
	projectPaths?: StorePaths;
	global: Preference[];
	project: Preference[];
}> {
	const projectRoot = findProjectRoot(cwd);
	const globalPaths = globalStorePaths();
	const projectPaths = projectStorePaths(projectRoot);
	const [globalFile, projectFile] = await Promise.all([
		loadPreferenceFile(globalPaths),
		projectPaths ? loadPreferenceFile(projectPaths) : Promise.resolve(undefined),
	]);
	return {
		projectRoot,
		globalPaths,
		projectPaths,
		global: globalFile.preferences,
		project: projectFile?.preferences ?? [],
	};
}

function buildTasteSection(
	project: Preference[],
	global: Preference[],
	imported: Awaited<ReturnType<typeof loadCommandCodeTaste>>,
	config: TasteConfig,
): { section: string; count: number } {
	const approvedStatements = (preferences: Preference[]) =>
		preferences
			.filter((item) => item.status === "approved")
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
			.map((item) => item.statement);
	const groups: Array<{ heading: string; statements: string[] }> = [
		{
			heading: "Project (Pi, approved)",
			statements: approvedStatements(project),
		},
		{
			heading: "Project (Command Code, read-only)",
			statements: imported.filter((item) => item.scope === "project").map((item) => item.statement),
		},
		{
			heading: "Global (Pi, approved)",
			statements: approvedStatements(global),
		},
		{
			heading: "Global (Command Code, read-only)",
			statements: imported.filter((item) => item.scope === "global").map((item) => item.statement),
		},
	];
	const seen = new Set<string>();
	const selectedGroups: Array<{ heading: string; statements: string[] }> = [];
	let count = 0;
	let chars = 0;
	for (const group of groups) {
		const statements: string[] = [];
		for (const statement of group.statements) {
			const key = normalizePreferenceKey(statement);
			if (!key || seen.has(key) || count >= config.injection.maxPreferences) continue;
			const addition = `- ${statement}\n`;
			if (chars + addition.length > config.injection.maxChars) continue;
			seen.add(key);
			statements.push(statement);
			count += 1;
			chars += addition.length;
		}
		if (statements.length > 0) selectedGroups.push({ heading: group.heading, statements });
	}
	if (selectedGroups.length === 0) return { section: "", count: 0 };
	const body = selectedGroups
		.map((group) => `### ${group.heading}\n${group.statements.map((statement) => `- ${statement}`).join("\n")}`)
		.join("\n\n");
	return {
		section: `## Learned Taste\n\nThe entries below are persistent user requirements when relevant, not generic suggestions. Apply all relevant entries. The current user's explicit instruction always overrides historical Taste. Project entries take priority over global entries. Do not infer approval from entries that are absent; pending preferences are intentionally excluded.\n\n${body}`,
		count,
	};
}

interface InjectionSnapshot {
	digest: string;
	bytes: number;
	count: number;
}

function snapshotForSection(section: string, count: number): InjectionSnapshot {
	return {
		digest: section ? createHash("sha256").update(section).digest("hex").slice(0, 12) : "empty",
		bytes: Buffer.byteLength(section, "utf8"),
		count,
	};
}

async function injectedSystemPrompt(
	eventSystemPrompt: string,
	cwd: string,
	config: TasteConfig,
): Promise<{ systemPrompt: string; snapshot: InjectionSnapshot }> {
	if (!config.injectionEnabled) {
		return { systemPrompt: eventSystemPrompt, snapshot: { digest: "off", bytes: 0, count: 0 } };
	}
	const stores = await preferenceStores(cwd);
	const imported = config.injection.includeCommandCode ? await loadCommandCodeTaste(stores.projectRoot) : [];
	const built = buildTasteSection(stores.project, stores.global, imported, config);
	return {
		systemPrompt: built.section ? `${eventSystemPrompt}\n\n${built.section}\n` : eventSystemPrompt,
		snapshot: snapshotForSection(built.section, built.count),
	};
}

function syntheticLowSignalResult(): ObserverResult {
	return {
		classification: { kind: "acknowledgement", reason: "Deterministic low-signal acknowledgement filter" },
		proposals: [],
	};
}

function activityChanges(changes: ReductionChange[]): TasteActivityChange[] {
	return changes.map((change) => ({
		action: change.action,
		...(change.statement ? { statement: change.statement } : {}),
		...(change.preferenceId ? { preferenceId: change.preferenceId } : {}),
		...(change.scope ? { scope: change.scope } : {}),
		...(change.status ? { status: change.status } : {}),
		...(change.reason ? { reason: change.reason } : {}),
	}));
}

function observerActivityTitle(changes: ReductionChange[]): string {
	const stored = changes.filter((change) => change.action !== "skipped");
	if (stored.length === 0) return "Checked — no persistent change";
	const approved = stored.filter((change) => change.status === "approved").length;
	const pending = stored.filter((change) => change.status === "pending").length;
	const inactive = stored.length - approved - pending;
	const parts: string[] = [];
	if (approved) parts.push(`${approved} approved`);
	if (pending) parts.push(`${pending} pending`);
	if (inactive) parts.push(`${inactive} inactive`);
	return `Updated — ${parts.join(", ")}`;
}

function safeAppendTasteActivity(pi: ExtensionAPI, data: TasteActivityData): void {
	try {
		appendTasteActivity(pi, data);
	} catch {
		// A display-only transcript entry must never make preference persistence fail.
	}
}

function statusCounts(preferences: Preference[]): string {
	const count = (status: Preference["status"]) => preferences.filter((item) => item.status === status).length;
	return `${count("approved")} approved, ${count("pending")} pending, ${count("rejected")} rejected, ${count("superseded")} superseded`;
}

function sessionId(ctx: ExtensionContext): string | undefined {
	return ctx.sessionManager.getSessionId?.() || ctx.sessionManager.getSessionFile?.();
}

function commandContext(ctx: ExtensionContext, id = eventId()): { eventId: string; at: string; sessionId?: string } {
	return { eventId: id, at: new Date().toISOString(), ...(sessionId(ctx) ? { sessionId: sessionId(ctx) } : {}) };
}

function requestedScope(input: string): TasteScope | undefined {
	const global = /(?:^|\s)(?:-g|--global)(?=\s|$)/.test(input);
	const project = /(?:^|\s)--project(?=\s|$)/.test(input);
	if (global && project) throw new Error("Choose either global (-g/--global) or project (--project), not both.");
	return global ? "global" : project ? "project" : undefined;
}

function stripControlFlags(input: string, includeYes = false): string {
	const flags = includeYes ? "(?:-g|--global|--project|--yes)" : "(?:-g|--global|--project)";
	return input.replace(new RegExp(`(?:^|\\s)${flags}(?=\\s|$)`, "g"), " ").replace(/\s+/g, " ").trim();
}

async function appendAuditEvent(globalPaths: StorePaths, projectPaths: StorePaths | undefined, event: TasteEvent): Promise<void> {
	await appendEvent(globalPaths, event);
	if (projectPaths) await appendEvent(projectPaths, event);
}

async function resolvePreference(
	cwd: string,
	idPrefix: string,
): Promise<{ preference: Preference; paths: StorePaths; globalPaths: StorePaths; projectPaths?: StorePaths }> {
	const stores = await preferenceStores(cwd);
	const matches = [
		...stores.global.map((preference) => ({ preference, paths: stores.globalPaths })),
		...stores.project.map((preference) => ({ preference, paths: stores.projectPaths! })),
	].filter((item) => item.preference.id === idPrefix || item.preference.id.startsWith(idPrefix));
	if (matches.length === 0) throw new Error(`No preference matches ${idPrefix}`);
	if (matches.length > 1) throw new Error(`Preference id prefix is ambiguous: ${idPrefix}`);
	return { ...matches[0], globalPaths: stores.globalPaths, projectPaths: stores.projectPaths };
}

function commandHelp(): string {
	return [
		"/taste status",
		"/taste list [approved|pending|rejected|superseded|all]",
		"/taste paths",
		"/taste remember [-g|--global|--project] <preference>",
		"/taste import <markdown-file> [-g|--global|--project] [--yes]",
		"/taste move <id> [global|project]",
		"/taste review [<id> approve|reject]",
		"/taste forget <id>",
		"/taste on | off",
		"/taste inject on | off",
		"/taste model [status|inherit|select|set|only|add|remove|list] [provider/model|search]",
		"/taste curate [show|apply [--yes]|discard|rebuild|--model provider/model]",
	].join("\n");
}

export default async function tasteExtension(pi: ExtensionAPI) {
	installTasteActivityRenderer(pi);
	await ensureGlobalStore();
	let config = await loadConfig();
	let previousOutcome: AgentOutcome | undefined;
	let queue: Promise<void> = Promise.resolve();
	let queuedJobs = 0;
	let lastObserverError: string | undefined;
	let lastEnqueuedFingerprint: string | undefined;
	let lastInjectionSnapshot: InjectionSnapshot = { digest: "empty", bytes: 0, count: 0 };
	let requestFooterRender: () => void = () => {};
	let currentModel: { provider: string; id: string; reasoning: boolean } | undefined;
	let currentThinkingLevel: string | undefined;
	const refreshFooter = () => requestFooterRender();
	const noSession = process.argv.includes("--no-session");
	const isSubagentChild = process.env.PI_SUBAGENT_CHILD === "1";
	const allowNoSession =
		process.env.PI_TASTE_ALLOW_NO_SESSION === "1" || process.env.PI_TASTE_ALLOW_NO_SESSION === "true";
	const learningAllowedInProcess = !isSubagentChild && (!noSession || allowNoSession);

	const processFeedback = async (
		ctx: ExtensionContext,
		feedbackInput: string,
		previous: AgentOutcome | undefined,
	): Promise<void> => {
		config = await loadConfig();
		if (!config.learningEnabled || !learningAllowedInProcess) return;
		const stores = await preferenceStores(ctx.cwd);
		const id = eventId();
		const at = new Date().toISOString();
		const feedback = clipText(redactSensitive(feedbackInput), MAX_EVENT_FEEDBACK);
		const event: TasteEvent = {
			version: 1,
			id,
			timestamp: at,
			type: "observer",
			...(sessionId(ctx) ? { sessionId: sessionId(ctx) } : {}),
			...(stores.projectRoot ? { projectRoot: stores.projectRoot } : {}),
			interaction: {
				...(previous ? { previousAgentOutcome: previous } : {}),
				currentUserFeedback: feedback,
			},
		};
		try {
			let result: ObserverResult;
			if (isLowSignalFeedback(feedback)) {
				result = syntheticLowSignalResult();
				event.observer = { status: "skipped", result, reason: "low-signal acknowledgement" };
			} else {
				const observed = await observeFeedback(ctx, config, previous, feedback, [...stores.project, ...stores.global]);
				result = observed.result;
				event.observer = { status: "completed", result, usage: observed.usage };
			}
			const reduction = await reduceObserverResult(result, { eventId: id, at, userFeedback: feedback, sessionId: sessionId(ctx) }, stores.globalPaths, stores.projectPaths);
			event.reducer = reduction;
			await appendEvent(stores.globalPaths, event);
			const projectChanged = Boolean(
				stores.projectPaths && reduction.changes.some((change) => change.scope === "project" && change.action !== "skipped"),
			);
			if (stores.projectPaths && projectChanged) await appendEvent(stores.projectPaths, event);
			lastObserverError = undefined;
			refreshFooter();
			const changes = activityChanges(reduction.changes);
			const storedChanges = reduction.changes.filter((change) => change.action !== "skipped");
			const lowSignal = event.observer?.status === "skipped";
			safeAppendTasteActivity(pi, {
				version: 1,
				eventId: id,
				timestamp: at,
				kind: "observer",
				outcome: lowSignal ? "skipped" : storedChanges.length > 0 ? "changed" : "unchanged",
				title: lowSignal ? "Skipped low-signal feedback" : observerActivityTitle(reduction.changes),
				changes,
				files: tasteActivityFiles(stores.globalPaths, stores.projectPaths, changes, projectChanged),
				classification: result.classification.kind,
				...(event.observer?.usage
					? { model: `${event.observer.usage.provider}/${event.observer.usage.model}` }
					: {}),
				detail: storedChanges.length === 0
					? lowSignal
						? "No Observer call was needed; no Taste file changed."
						: `${result.classification.reason} No Taste file changed.`
					: result.classification.reason,
			});
		} catch (error) {
			lastObserverError = error instanceof Error ? error.message : String(error);
			refreshFooter();
			event.observer = { status: "failed", reason: lastObserverError };
			try {
				await appendEvent(stores.globalPaths, event);
			} catch {
				// Preserve the original Observer error for /taste status.
			}
			safeAppendTasteActivity(pi, {
				version: 1,
				eventId: id,
				timestamp: at,
				kind: "error",
				outcome: "failed",
				title: "Observer failed",
				changes: [],
				files: tasteActivityFiles(stores.globalPaths, stores.projectPaths, []),
				detail: clipText(redactSensitive(lastObserverError), 600),
			});
		}
	};

	const enqueueFeedback = (ctx: ExtensionContext, feedback: string, previous: AgentOutcome | undefined) => {
		queuedJobs += 1;
		refreshFooter();
		queue = queue
			.then(() => processFeedback(ctx, feedback, previous))
			.catch((error) => {
				lastObserverError = error instanceof Error ? error.message : String(error);
			})
			.finally(() => {
				queuedJobs -= 1;
				refreshFooter();
			});
	};

	pi.on("session_start", async (_event, ctx) => {
		config = await loadConfig();
		previousOutcome = outcomeFromBranch(ctx);
		lastEnqueuedFingerprint = undefined;
		currentModel = ctx.model
			? { provider: ctx.model.provider, id: ctx.model.id, reasoning: ctx.model.reasoning }
			: undefined;
		currentThinkingLevel = ctx.thinkingLevel;
		installTasteFooter(
			ctx,
			() => ({
				learningEnabled: config.learningEnabled,
				injectionEnabled: config.injectionEnabled,
				queuedJobs,
				hasError: Boolean(lastObserverError),
				model: currentModel,
				thinkingLevel: currentThinkingLevel,
			}),
			(requestRender) => {
				requestFooterRender = requestRender;
			},
		);
		refreshFooter();
	});

	pi.on("model_select", (event) => {
		currentModel = { provider: event.model.provider, id: event.model.id, reasoning: event.model.reasoning };
		refreshFooter();
	});

	pi.on("thinking_level_select", (event) => {
		currentThinkingLevel = event.level;
		refreshFooter();
	});

	pi.on("agent_end", (event) => {
		if ((event as typeof event & { willRetry?: boolean }).willRetry) return;
		const outcome = summarizeAgentMessages(event.messages as any[]);
		if (outcome) previousOutcome = outcome;
	});

	pi.on("session_shutdown", async () => {
		// Do not discard the final turn's background evidence during quit, resume, or fork.
		await queue;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		config = await loadConfig();
		// Snapshot injection before enqueueing this message, so newly extracted Taste
		// can affect only future turns rather than racing into the turn that supplied it.
		const injection = await injectedSystemPrompt(event.systemPrompt, ctx.cwd, config);
		lastInjectionSnapshot = injection.snapshot;
		refreshFooter();
		if (config.learningEnabled && learningAllowedInProcess && event.prompt.trim()) {
			const fingerprint = feedbackFingerprint(event.prompt, previousOutcome, sessionId(ctx));
			if (fingerprint !== lastEnqueuedFingerprint) {
				lastEnqueuedFingerprint = fingerprint;
				enqueueFeedback(ctx, event.prompt, previousOutcome);
			}
		}
		return { systemPrompt: injection.systemPrompt };
	});

	pi.registerCommand("taste", {
		description: "Inspect, review, and manage continuously learned coding Taste",
		handler: async (args, ctx) => {
			const input = args.trim();
			const [subcommand = "status", ...restParts] = input ? input.split(/\s+/) : ["status"];
			const rest = restParts.join(" ").trim();
			try {
				if (subcommand === "help") {
					ctx.ui.notify(commandHelp(), "info");
					return;
				}
				if (subcommand === "status") {
					config = await loadConfig();
					const stores = await preferenceStores(ctx.cwd);
					const imported = config.injection.includeCommandCode
						? await loadCommandCodeTaste(stores.projectRoot)
						: [];
					if (config.injectionEnabled) {
						const built = buildTasteSection(stores.project, stores.global, imported, config);
						lastInjectionSnapshot = snapshotForSection(built.section, built.count);
					} else lastInjectionSnapshot = { digest: "off", bytes: 0, count: 0 };
					const activeModel = resolveTasteModel(ctx, config);
					const savedPlan = await loadCurationPlan();
					ctx.ui.notify(
						[
							`Taste learning: ${config.learningEnabled ? "on" : "off"}${learningAllowedInProcess ? "" : " (disabled for --no-session/subagent)"}`,
							`Taste injection: ${config.injectionEnabled ? "on" : "off"}`,
							`Taste model mode: ${config.observer.modelMode}`,
							`Observer: ${activeModel ? `${activeModel.provider}/${activeModel.id}` : "unavailable"}`,
							`Injection snapshot: ${lastInjectionSnapshot.digest} (${lastInjectionSnapshot.count} entries, ${lastInjectionSnapshot.bytes} bytes)`,
							`Queue: ${queuedJobs}`,
							`Global: ${statusCounts(stores.global)}`,
							`Project: ${stores.projectRoot ? statusCounts(stores.project) : "no Git project"}`,
							`Command Code read-only imports: ${imported.length}`,
							`Curation plan: ${savedPlan ? `${savedPlan.id}${savedPlan.appliedAt ? " (applied)" : ` (${savedPlan.operations.length} operations)`}` : "none"}`,
							...(lastObserverError ? [`Last Observer error: ${lastObserverError}`] : []),
						].join("\n"),
						lastObserverError ? "warning" : "info",
					);
					return;
				}

				if (subcommand === "model") {
					config = await loadConfig();
					let modelArgs = [...restParts];
					if (modelArgs.length === 0 && ctx.mode === "tui") {
						const main = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unavailable";
						const custom = config.observer.models[0] ? modelReferenceText(config.observer.models[0]) : "not configured";
						const follow = `Follow current main model (${main})${config.observer.modelMode === "inherit" ? " ✓" : ""}`;
						const choose = `Select a separate Taste model… (${custom})${config.observer.modelMode === "custom" ? " ✓" : ""}`;
						const selectedMode = await ctx.ui.select("Taste model mode", [follow, choose, "Cancel"]);
						if (!selectedMode || selectedMode === "Cancel") return;
						if (selectedMode === follow) modelArgs = ["inherit"];
						else {
							const selected = await pickTasteModel(ctx, config);
							if (!selected) return;
							modelArgs = ["only", modelReferenceText(selected)];
						}
					}
					let action = modelArgs[0] ?? "status";
					if (action === "status") {
						const active = resolveTasteModel(ctx, config);
						ctx.ui.notify(
							[
								`Mode: ${config.observer.modelMode}`,
								`Active: ${active ? `${active.provider}/${active.id}` : "unavailable"}`,
								`Custom order: ${config.observer.models.length ? config.observer.models.map(modelReferenceText).join(" → ") : "none"}`,
								"Use /taste model to open Pi's model picker, or /taste model inherit.",
							].join("\n"),
							"info",
						);
						return;
					}
					if (action === "list") {
						const query = modelArgs.slice(1).join(" ").toLocaleLowerCase();
						const models = ctx.modelRegistry
							.getAvailable()
							.map((model) => `${model.provider}/${model.id}`)
							.filter((label) => !query || label.toLocaleLowerCase().includes(query))
							.sort()
							.slice(0, 60);
						ctx.ui.notify(models.length ? models.join("\n") : "No available models match.", "info");
						return;
					}
					if (action === "select") {
						const selected = await pickTasteModel(ctx, config, modelArgs.slice(1).join(" ") || undefined);
						if (!selected) return;
						modelArgs = ["only", modelReferenceText(selected)];
						action = "only";
					}
					if (["set", "only", "add"].includes(action) && !modelArgs[1] && ctx.mode === "tui") {
						const selected = await pickTasteModel(ctx, config);
						if (!selected) return;
						modelArgs[1] = modelReferenceText(selected);
					}
					if (action === "remove" && !modelArgs[1] && ctx.mode === "tui") {
						if (config.observer.models.length === 0) throw new Error("No custom Taste models are configured.");
						const choices = [...config.observer.models.map(modelReferenceText), "Cancel"];
						const selected = await ctx.ui.select("Remove Taste model", choices);
						if (!selected || selected === "Cancel") return;
						modelArgs[1] = selected;
					}
					if (action === "inherit") {
						config.observer.modelMode = "inherit";
					} else {
						const shorthand = action.includes("/");
						const operation = shorthand ? "set" : action;
						const value = shorthand ? action : modelArgs[1];
						if (!["set", "only", "add", "remove"].includes(operation) || !value) {
							throw new Error(
								"Usage: /taste model [status|inherit|select|set|only|add|remove|list] [provider/model|search]",
							);
						}
						const reference = parseModelReference(value);
						const found = ctx.modelRegistry.find(reference.provider, reference.model);
						if (!found && operation !== "remove") throw new Error(`Model not found: ${value}`);
						const without = config.observer.models.filter(
							(item) => item.provider !== reference.provider || item.model !== reference.model,
						);
						if (operation === "set") config.observer.models = [reference, ...without];
						if (operation === "only") config.observer.models = [reference];
						if (operation === "add") config.observer.models = [...without, reference];
						if (operation === "remove") config.observer.models = without;
						config.observer.modelMode = config.observer.models.length > 0 ? "custom" : "inherit";
					}
					await saveConfig(config);
					lastObserverError = undefined;
					refreshFooter();
					const active = resolveTasteModel(ctx, config);
					const authWarning =
						config.observer.modelMode === "custom" && !active
							? " Configured model currently has no usable authentication."
							: "";
					const stores = await preferenceStores(ctx.cwd);
					const command = commandContext(ctx);
					await appendEvent(stores.globalPaths, {
						version: 1,
						id: command.eventId,
						timestamp: command.at,
						type: "config",
						...(command.sessionId ? { sessionId: command.sessionId } : {}),
						details: {
							action: "model",
							mode: config.observer.modelMode,
							models: config.observer.models.map(modelReferenceText),
						},
					});
					ctx.ui.notify(
						`Taste model: ${config.observer.modelMode === "inherit" ? "follows current main model" : config.observer.models.map(modelReferenceText).join(" → ")}.${authWarning}`,
						authWarning ? "warning" : "info",
					);
					return;
				}

				if (subcommand === "paths") {
					const stores = await preferenceStores(ctx.cwd);
					const lines = [
						`Default manual scope: ${stores.projectPaths ? "project (use -g for global)" : "global (no Git project)"}`,
						"",
						`Global state: ${stores.globalPaths.preferences}`,
						`Global Taste: ${stores.globalPaths.taste}`,
						`Global audit: ${stores.globalPaths.events}`,
					];
					if (stores.projectPaths) {
						lines.push(
							"",
							`Project root: ${stores.projectRoot}`,
							`Project state: ${stores.projectPaths.preferences}`,
							`Project Taste: ${stores.projectPaths.taste}`,
							`Project audit: ${stores.projectPaths.events}`,
						);
					} else lines.push("", "Project Taste: unavailable outside a Git repository");
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}

				if (subcommand === "list") {
					const filter = rest || "all";
					if (!["all", "approved", "pending", "rejected", "superseded"].includes(filter)) {
						throw new Error("List filter must be approved, pending, rejected, superseded, or all.");
					}
					const stores = await preferenceStores(ctx.cwd);
					const items = [
						...stores.project.map((preference) => ({ preference, label: "P" })),
						...stores.global.map((preference) => ({ preference, label: "G" })),
					].filter((item) => filter === "all" || item.preference.status === filter);
					if (items.length === 0) {
						ctx.ui.notify("No matching Pi Taste preferences.", "info");
						return;
					}
					const visible = items.slice(0, 40).map(
						({ preference, label }) =>
							`[${label}] ${preference.id} ${preference.status} c=${preference.confidence.toFixed(2)} — ${preference.statement}`,
					);
					if (items.length > visible.length) visible.push(`… ${items.length - visible.length} more`);
					ctx.ui.notify(visible.join("\n"), "info");
					return;
				}

				if (subcommand === "remember") {
					const explicitScope = requestedScope(rest);
					const statement = stripControlFlags(rest);
					if (!statement) throw new Error("Usage: /taste remember [-g|--global|--project] <preference>");
					const stores = await preferenceStores(ctx.cwd);
					const scope = explicitScope ?? (stores.projectPaths ? "project" : "global");
					const paths = scope === "project" ? stores.projectPaths : stores.globalPaths;
					if (!paths) throw new Error("--project requires a Git project.");
					const prior = (paths.scope === "project" ? stores.project : stores.global).find(
						(item) => item.key === normalizePreferenceKey(statement),
					);
					const command = commandContext(ctx);
					const preference = await rememberPreference(paths, statement, command);
					const event: TasteEvent = {
						version: 1,
						id: command.eventId,
						timestamp: command.at,
						type: "manual",
						...(command.sessionId ? { sessionId: command.sessionId } : {}),
						...(stores.projectRoot ? { projectRoot: stores.projectRoot } : {}),
						details: { action: "remember", preferenceId: preference.id, scope: paths.scope, statement },
					};
					await appendAuditEvent(stores.globalPaths, paths.scope === "project" ? stores.projectPaths : undefined, event);
					const changes: TasteActivityChange[] = [{
						action: !prior ? "added" : prior.status === "approved" ? "reinforced" : "approved",
						statement: preference.statement,
						preferenceId: preference.id,
						scope: preference.scope,
						status: preference.status,
					}];
					safeAppendTasteActivity(pi, {
						version: 1,
						eventId: command.eventId,
						timestamp: command.at,
						kind: "manual",
						outcome: "changed",
						title: "Preference remembered",
						changes,
						files: tasteActivityFiles(stores.globalPaths, stores.projectPaths, changes, paths.scope === "project"),
					});
					return;
				}

				if (subcommand === "import") {
					const explicitScope = requestedScope(rest);
					const forced = /(?:^|\s)--yes(?=\s|$)/.test(rest);
					const sourceInput = stripControlFlags(rest, true);
					if (!sourceInput) {
						throw new Error("Usage: /taste import <markdown-file> [-g|--global|--project] [--yes]");
					}
					const stores = await preferenceStores(ctx.cwd);
					const scope = explicitScope ?? (stores.projectPaths ? "project" : "global");
					const paths = scope === "project" ? stores.projectPaths : stores.globalPaths;
					if (!paths) throw new Error("--project requires a Git project.");
					const preview = await readTasteImport(sourceInput, ctx.cwd);
					if (!forced) {
						if (ctx.mode !== "tui") throw new Error("Use --yes to confirm Taste import outside TUI mode.");
						const visible = preview.statements.slice(0, 12).map((statement) => `- ${statement}`);
						if (preview.statements.length > visible.length) {
							visible.push(`… ${preview.statements.length - visible.length} more`);
						}
						const confirmed = await ctx.ui.confirm(
							`Import ${preview.statements.length} preferences into ${scope} Taste?`,
							[`Source: ${preview.sourcePath}`, `State: ${paths.preferences}`, "", ...visible].join("\n"),
						);
						if (!confirmed) return;
					}
					const command = commandContext(ctx);
					const remembered = await rememberPreferences(paths, preview.statements, command);
					const changes: TasteActivityChange[] = remembered.map(({ preference, action }) => ({
						action,
						statement: preference.statement,
						preferenceId: preference.id,
						scope: preference.scope,
						status: preference.status,
					}));
					const event: TasteEvent = {
						version: 1,
						id: command.eventId,
						timestamp: command.at,
						type: "import",
						...(command.sessionId ? { sessionId: command.sessionId } : {}),
						...(stores.projectRoot ? { projectRoot: stores.projectRoot } : {}),
						details: {
							action: "import",
							sourcePath: preview.sourcePath,
							scope,
							count: remembered.length,
							skippedLines: preview.skipped,
						},
					};
					await appendAuditEvent(stores.globalPaths, scope === "project" ? stores.projectPaths : undefined, event);
					safeAppendTasteActivity(pi, {
						version: 1,
						eventId: command.eventId,
						timestamp: command.at,
						kind: "import",
						outcome: "changed",
						title: `Imported ${remembered.length} preferences into ${scope} Taste`,
						changes,
						files: tasteActivityFiles(stores.globalPaths, stores.projectPaths, changes, scope === "project"),
						detail: `Source: ${preview.sourcePath}`,
					});
					return;
				}

				if (subcommand === "move") {
					const id = restParts.find((token) => token !== "global" && token !== "project");
					if (!id) throw new Error("Usage: /taste move <id> [global|project]");
					let targetScope = restParts.find((token): token is TasteScope => token === "global" || token === "project");
					if (!targetScope && ctx.mode === "tui") {
						const selected = await ctx.ui.select("Move preference to", ["Global", "Project", "Cancel"]);
						if (!selected || selected === "Cancel") return;
						targetScope = selected === "Global" ? "global" : "project";
					}
					if (!targetScope) throw new Error("Usage: /taste move <id> global|project");
					const resolved = await resolvePreference(ctx.cwd, id);
					if (resolved.paths.scope === targetScope) {
						ctx.ui.notify(`Preference ${resolved.preference.id} is already ${targetScope}.`, "info");
						return;
					}
					const targetPaths = targetScope === "project" ? resolved.projectPaths : resolved.globalPaths;
					if (!targetPaths) throw new Error("Moving to project Taste requires a Git project.");
					const command = commandContext(ctx);
					const moved = await movePreference(
						resolved.paths,
						targetPaths,
						resolved.preference.id,
						command,
					);
					const event: TasteEvent = {
						version: 1,
						id: command.eventId,
						timestamp: command.at,
						type: "move",
						...(command.sessionId ? { sessionId: command.sessionId } : {}),
						...(targetPaths.projectRoot ? { projectRoot: targetPaths.projectRoot } : {}),
						details: {
							action: "move",
							from: resolved.paths.scope,
							to: targetScope,
							sourcePreferenceId: moved.source.id,
							targetPreferenceId: moved.target.id,
						},
					};
					await appendAuditEvent(
						resolved.globalPaths,
						resolved.paths.scope === "project" || targetScope === "project" ? resolved.projectPaths : undefined,
						event,
					);
					const changes: TasteActivityChange[] = [
						{
							action: "superseded",
							statement: moved.source.statement,
							preferenceId: moved.source.id,
							scope: moved.source.scope,
							status: moved.source.status,
						},
						{
							action: moved.targetExisted ? "approved" : "added",
							statement: moved.target.statement,
							preferenceId: moved.target.id,
							scope: moved.target.scope,
							status: moved.target.status,
						},
					];
					safeAppendTasteActivity(pi, {
						version: 1,
						eventId: command.eventId,
						timestamp: command.at,
						kind: "move",
						outcome: "changed",
						title: `Preference moved — ${resolved.paths.scope} → ${targetScope}`,
						changes,
						files: tasteActivityFiles(resolved.globalPaths, resolved.projectPaths, changes, true),
					});
					return;
				}

				if (subcommand === "review") {
					let id: string | undefined;
					let action: "approve" | "reject" | undefined;
					for (const token of restParts) {
						if (token === "approve" || token === "reject") action = token;
						else if (!id) id = token;
					}
					if (!id) {
						const stores = await preferenceStores(ctx.cwd);
						const pending = [...stores.project, ...stores.global].filter((item) => item.status === "pending");
						if (pending.length === 0) {
							ctx.ui.notify("No pending Taste preferences.", "info");
							return;
						}
						if (!ctx.hasUI) {
							ctx.ui.notify(pending.map((item) => `${item.id} — ${item.statement}`).join("\n"), "info");
							return;
						}
						const labels = pending.map((item) => `${item.id} — ${clipText(item.statement, 90)}`);
						const selected = await ctx.ui.select("Review pending Taste", labels);
						if (!selected) return;
						id = pending[labels.indexOf(selected)]?.id;
						const selectedAction = await ctx.ui.select("Decision", ["Approve", "Reject", "Cancel"]);
						if (selectedAction === "Approve") action = "approve";
						if (selectedAction === "Reject") action = "reject";
						if (!action) return;
					}
					if (!action) throw new Error("Usage: /taste review <id> approve|reject");
					const resolved = await resolvePreference(ctx.cwd, id!);
					const command = commandContext(ctx);
					const preference = await setPreferenceReview(resolved.paths, resolved.preference.id, action, command);
					const event: TasteEvent = {
						version: 1,
						id: command.eventId,
						timestamp: command.at,
						type: "review",
						...(command.sessionId ? { sessionId: command.sessionId } : {}),
						details: { action, preferenceId: preference.id, statement: preference.statement },
					};
					await appendAuditEvent(
						resolved.globalPaths,
						resolved.paths.scope === "project" ? resolved.projectPaths : undefined,
						event,
					);
					const changes: TasteActivityChange[] = [{
						action: action === "approve" ? "approved" : "rejected",
						statement: preference.statement,
						preferenceId: preference.id,
						scope: preference.scope,
						status: preference.status,
					}];
					safeAppendTasteActivity(pi, {
						version: 1,
						eventId: command.eventId,
						timestamp: command.at,
						kind: "review",
						outcome: "changed",
						title: action === "approve" ? "Preference approved" : "Preference rejected",
						changes,
						files: tasteActivityFiles(
							resolved.globalPaths,
							resolved.projectPaths,
							changes,
							resolved.paths.scope === "project",
						),
					});
					return;
				}

				if (subcommand === "forget") {
					if (!rest) throw new Error("Usage: /taste forget <id>");
					const resolved = await resolvePreference(ctx.cwd, rest);
					const command = commandContext(ctx);
					const preference = await forgetPreference(resolved.paths, resolved.preference.id, command);
					const event: TasteEvent = {
						version: 1,
						id: command.eventId,
						timestamp: command.at,
						type: "forget",
						...(command.sessionId ? { sessionId: command.sessionId } : {}),
						details: { preferenceId: preference.id, statement: preference.statement },
					};
					await appendAuditEvent(
						resolved.globalPaths,
						resolved.paths.scope === "project" ? resolved.projectPaths : undefined,
						event,
					);
					const changes: TasteActivityChange[] = [{
						action: "forgotten",
						statement: preference.statement,
						preferenceId: preference.id,
						scope: preference.scope,
						status: preference.status,
					}];
					safeAppendTasteActivity(pi, {
						version: 1,
						eventId: command.eventId,
						timestamp: command.at,
						kind: "forget",
						outcome: "changed",
						title: "Preference forgotten",
						changes,
						files: tasteActivityFiles(
							resolved.globalPaths,
							resolved.projectPaths,
							changes,
							resolved.paths.scope === "project",
						),
					});
					return;
				}

				if (subcommand === "on" || subcommand === "off") {
					config = await loadConfig();
					config.learningEnabled = subcommand === "on";
					await saveConfig(config);
					lastObserverError = undefined;
					refreshFooter();
					ctx.ui.notify(`Taste learning ${subcommand}. Existing approved Taste remains injectable.`, "info");
					return;
				}

				if (subcommand === "inject") {
					if (rest !== "on" && rest !== "off") throw new Error("Usage: /taste inject on|off");
					config = await loadConfig();
					config.injectionEnabled = rest === "on";
					await saveConfig(config);
					lastInjectionSnapshot = rest === "on" ? lastInjectionSnapshot : { digest: "off", bytes: 0, count: 0 };
					refreshFooter();
					ctx.ui.notify(`Taste injection ${rest}.`, "info");
					return;
				}

				if (subcommand === "curate") {
					const action = ["show", "apply", "discard", "rebuild"].includes(restParts[0] ?? "")
						? restParts[0]
						: "plan";
					if (action === "plan" || action === "apply") await queue;
					const stores = await preferenceStores(ctx.cwd);
					if (action === "rebuild") {
						await regenerateTaste(stores.globalPaths);
						if (stores.projectPaths) await regenerateTaste(stores.projectPaths);
						ctx.ui.notify("Taste Markdown views regenerated from authoritative preferences.json. No model was called.", "info");
						return;
					}
					if (action === "show") {
						const plan = await loadCurationPlan();
						ctx.ui.notify(plan ? formatCurationPlan(plan) : "No saved curation plan.", "info");
						return;
					}
					if (action === "discard") {
						await discardCurationPlan();
						ctx.ui.notify("Saved curation plan discarded. Preferences were not changed.", "info");
						return;
					}
					if (action === "apply") {
						const plan = await loadCurationPlan();
						if (!plan) throw new Error("No saved curation plan. Run /taste curate first.");
						if ((plan.projectRoot ?? undefined) !== (stores.projectRoot ?? undefined)) {
							throw new Error("The saved curation plan belongs to a different project context.");
						}
						if (plan.operations.length === 0) {
							ctx.ui.notify("The saved curation plan has no operations to apply.", "info");
							return;
						}
						const forced = restParts.includes("--yes");
						if (!forced) {
							if (!ctx.hasUI) throw new Error("Use /taste curate apply --yes in non-interactive mode.");
							const confirmed = await ctx.ui.confirm(
								`Apply ${plan.operations.length} Taste curation operations?`,
								`${plan.summary}\n\nThis can merge, rewrite, move, or supersede preferences. Audit history is preserved.`,
							);
							if (!confirmed) return;
						}
						const applied = await applyCurationPlan(plan, stores.globalPaths, stores.projectPaths);
						const command = commandContext(ctx);
						const event: TasteEvent = {
							version: 1,
							id: command.eventId,
							timestamp: command.at,
							type: "curate",
							...(command.sessionId ? { sessionId: command.sessionId } : {}),
							...(stores.projectRoot ? { projectRoot: stores.projectRoot } : {}),
							details: { action: "apply", planId: plan.id, operations: applied.applied, affectedIds: applied.affectedIds },
						};
						await appendAuditEvent(stores.globalPaths, stores.projectPaths, event);
						const beforeById = new Map([...stores.global, ...stores.project].map((item) => [item.id, item]));
						const changedScopes = Array.from(
							new Set(
								plan.operations.flatMap((operation) => [
									...operation.sourceIds.flatMap((id) => {
										const scope = beforeById.get(id)?.scope;
										return scope ? [scope] : [];
									}),
									...(operation.targetScope ? [operation.targetScope] : []),
								]),
							),
						);
						const changes: TasteActivityChange[] = plan.operations.map((operation) => ({
							action: "curated",
							statement: operation.statement
								? `${operation.type}: ${operation.statement}`
								: `${operation.type}: ${operation.sourceIds.join(", ")}${operation.winnerId ? ` → ${operation.winnerId}` : operation.targetScope ? ` → ${operation.targetScope}` : ""}`,
							scope: operation.targetScope ?? beforeById.get(operation.sourceIds[0])?.scope,
							reason: operation.reason,
						}));
						safeAppendTasteActivity(pi, {
							version: 1,
							eventId: command.eventId,
							timestamp: command.at,
							kind: "curate",
							outcome: "changed",
							title: `Curation applied — ${applied.applied} operations, ${applied.affectedIds.length} preferences`,
							changes,
							files: tasteActivityFiles(stores.globalPaths, stores.projectPaths, changes, Boolean(stores.projectPaths), changedScopes),
							detail: plan.summary,
						});
						return;
					}

					config = await loadConfig();
					const all = [...stores.project, ...stores.global];
					if (all.length === 0) {
						ctx.ui.notify("No Pi Taste preferences to curate. Command Code imports are read-only.", "info");
						return;
					}
					const modelFlag = restParts.indexOf("--model");
					if (modelFlag >= 0 && !restParts[modelFlag + 1]) {
						throw new Error("Usage: /taste curate --model provider/model");
					}
					const override = parseCuratorModelOverride(modelFlag >= 0 ? restParts[modelFlag + 1] : undefined);
					const plan = await createCurationPlan(ctx, config, all, stores.projectRoot, override);
					ctx.ui.notify(
						`${formatCurationPlan(plan)}\n\nReview with /taste curate show; apply with /taste curate apply. No preference was changed.`,
						plan.operations.length > 0 ? "warning" : "info",
					);
					return;
				}

				throw new Error(`Unknown Taste command: ${subcommand}\n${commandHelp()}`);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
