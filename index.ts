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
import { installTasteFooter } from "./footer.ts";
import { readTasteImport } from "./importer.ts";
import { resolveTasteModel, runLearner } from "./learner.ts";
import {
	clipText,
	ensureGlobalStore,
	findProjectRoot,
	globalStorePaths,
	loadCommandCodeTaste,
	loadConfig,
	loadPreferences,
	mutatePreferences,
	normalizePreferenceKey,
	projectStorePaths,
	redactSensitive,
	saveConfig,
} from "./storage.ts";
import type {
	InteractionContext,
	ObserverModelRef,
	Preference,
	StorePaths,
	TasteConfig,
	TasteScope,
} from "./types.ts";

const MAX_EVENT_USER_TEXT = 8_000;
const MAX_EVENT_ASSISTANT_TEXT = 12_000;

interface PendingFeedbackJob {
	ctx: ExtensionContext;
	interaction: InteractionContext;
	previousMessages: any[];
	newMessages: any[];
}

// Current run assembly state (module-level so helper functions can read it).
let currentRunMessages: any[] = [];
let liveAssistantMessage: any | undefined;

function eventId(): string {
	return `e_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function feedbackFingerprint(interaction: InteractionContext, session: string | undefined): string {
	return createHash("sha256")
		.update(`${session ?? ""}\0${interaction.userText}\0${interaction.assistantText}`)
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

function summarizeAssistantMessages(messages: any[]): string {
	const texts: string[] = [];
	for (const message of messages) {
		const text = contentText(message);
		if (text) texts.push(text);
	}
	const joined = texts.join("\n\n");
	return joined ? clipText(redactSensitive(joined), MAX_EVENT_ASSISTANT_TEXT) : "";
}

function visibleAssistantText(ctx: ExtensionContext): string {
	const messages: any[] = [];
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry: any = branch[index];
		if (!entry || entry.type !== "message" || !entry.message) continue;
		if (entry.message.role === "user") break;
		messages.unshift(entry.message);
	}
	return summarizeAssistantMessages(messages);
}

function currentRunAssistantText(ctx: ExtensionContext): string {
	const texts = summarizeAssistantMessages([
		...currentRunMessages,
		...(liveAssistantMessage ? [liveAssistantMessage] : []),
	]);
	return texts || visibleAssistantText(ctx);
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
	const [global, project] = await Promise.all([
		loadPreferences(globalPaths),
		projectPaths ? loadPreferences(projectPaths) : Promise.resolve([]),
	]);
	return { projectRoot, globalPaths, projectPaths, global, project };
}

function buildTasteSection(
	project: Preference[],
	global: Preference[],
	imported: Awaited<ReturnType<typeof loadCommandCodeTaste>>,
	config: TasteConfig,
	includeGlobalTaste: boolean,
): { section: string; count: number } {
	// Command Code getTasteContent(): global + project taste.md concatenated,
	// then rendered inside a <taste> block for the main model.
	const projectLines = project.map((item) => item.statement);
	const globalLines = includeGlobalTaste ? global.map((item) => item.statement) : [];
	const importedProject = imported.filter((item) => item.scope === "project").map((item) => item.statement);
	const importedGlobal = includeGlobalTaste ? imported.filter((item) => item.scope === "global").map((item) => item.statement) : [];
	const allLines = [...projectLines, ...globalLines, ...importedProject, ...importedGlobal];
	const seen = new Set<string>();
	const statements: string[] = [];
	for (const statement of allLines) {
		const key = normalizePreferenceKey(statement);
		if (!key || seen.has(key)) continue;
		const addition = `- ${statement}\n`;
		if (statements.length + addition.length > config.injection.maxChars) break;
		seen.add(key);
		statements.push(statement);
	}
	const tasteContent = statements.join("\n");
	if (!tasteContent) return { section: "", count: 0 };
	const section = `<taste>\nBelow is the complete content of the taste file.\nThis shows you what preferences are available and which categories might have additional details in separate files.\nIf you see references like "See [category/taste.md]", you MUST read that file using read_file to get the full preferences.\n\n--- Content of the taste file ---\n\n${tasteContent}\n\n--- End of the taste file ---\n</taste>`;
	return { section, count: statements.length };
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
	const stores = await preferenceStores(cwd);
	if (!config.learningEnabled) {
		return {
			systemPrompt: eventSystemPrompt,
			snapshot: { digest: "off", bytes: 0, count: 0 },
		};
	}
	const imported = await loadCommandCodeTaste(stores.projectRoot);
	const built = buildTasteSection(stores.project, stores.global, imported, config, true);
	return {
		systemPrompt: built.section ? `${eventSystemPrompt}\n\n${built.section}\n` : eventSystemPrompt,
		snapshot: snapshotForSection(built.section, built.count),
	};
}

function activityChanges(changes: Array<{ action: string; statement?: string; scope?: TasteScope }>): TasteActivityChange[] {
	return changes.map((change) => ({
		action: change.action,
		...(change.statement ? { statement: change.statement } : {}),
		...(change.scope ? { scope: change.scope } : {}),
	}));
}

function safeAppendTasteActivity(pi: ExtensionAPI, data: TasteActivityData): void {
	try {
		appendTasteActivity(pi, data);
	} catch {
		// A display-only transcript entry must never make preference persistence fail.
	}
}

function statusCounts(preferences: Preference[]): string {
	return `${preferences.length} learnings`;
}

function sessionId(ctx: ExtensionContext): string | undefined {
	return ctx.sessionManager.getSessionId?.() || ctx.sessionManager.getSessionFile?.();
}

function commandContext(ctx: ExtensionContext, id = eventId()): { eventId: string; at: string; sessionId?: string } {
	return { eventId: id, at: new Date().toISOString(), ...(sessionId(ctx) ? { sessionId: sessionId(ctx) } : {}) };
}

function findHistorySplit(messages: any[], searchIndex: number): { previous: any[]; new: any[] } {
	// Command Code: window of last LEARNER_CONTEXT_WINDOW learnable messages,
	// split at the first message after the last learned index.
	const tail = messages.slice(Math.max(0, messages.length - 20));
	return { previous: tail.slice(0, Math.max(0, tail.length - 1)), new: tail.slice(-1) };
}

function commandHelp(): string {
	return [
		"/taste status",
		"/taste list",
		"/taste paths",
		"/taste remember [-g|--global|--project] <preference>",
		"/taste import <markdown-file> [-g|--global|--project] [--yes]",
		"/taste move <id> [global|project]",
		"/taste forget <id>",
		"/taste retry [event-id]",
		"/taste on | off",
		"/taste model [status|inherit|select|set|only|add|remove|list] [provider/model|search]",
	].join("\n");
}

export default async function tasteExtension(pi: ExtensionAPI) {
	installTasteActivityRenderer(pi);
	await ensureGlobalStore();
	let config = await loadConfig();
	let queue: Promise<void> = Promise.resolve();
	let queuedJobs = 0;
	let lastLearnerError: string | undefined;
	let lastEnqueuedFingerprint: string | undefined;
	let lastInjectionSnapshot: InjectionSnapshot = { digest: "empty", bytes: 0, count: 0 };
	let requestFooterRender: () => void = () => {};
	let currentModel: { provider: string; id: string; reasoning: boolean } | undefined;
	let currentThinkingLevel: string | undefined;
	let pendingFeedback: PendingFeedbackJob[] = [];
	const refreshFooter = () => requestFooterRender();
	const noSession = process.argv.includes("--no-session");
	const isSubagentChild = process.env.PI_SUBAGENT_CHILD === "1";
	const allowNoSession =
		process.env.PI_TASTE_ALLOW_NO_SESSION === "1" || process.env.PI_TASTE_ALLOW_NO_SESSION === "true";
	const learningAllowedInProcess = !isSubagentChild && (!noSession || allowNoSession);

	const processFeedback = async (job: PendingFeedbackJob): Promise<void> => {
		const { ctx, interaction } = job;
		config = await loadConfig();
		if (!config.learningEnabled || !learningAllowedInProcess) return;
		const stores = await preferenceStores(ctx.cwd);
		try {
			const paths = stores.projectPaths ?? stores.globalPaths;
			const result = await runLearner(
				ctx,
				config,
				paths,
				interaction,
				job.previousMessages,
				job.newMessages,
				stores.global,
				true,
			);
			lastLearnerError = undefined;
			refreshFooter();
			const changes = activityChanges(result.changes.map((change) => ({
				action: change.action,
				...(change.statement ? { statement: change.statement } : {}),
			})));
			safeAppendTasteActivity(pi, {
				version: 1,
				eventId: eventId(),
				timestamp: new Date().toISOString(),
				kind: "observer",
				outcome: result.changes.length > 0 ? "changed" : "unchanged",
				title: result.changes.length > 0 ? "Taste updated" : "Checked — no persistent change",
				changes,
				files: tasteActivityFiles(stores.globalPaths, stores.projectPaths, changes, Boolean(stores.projectPaths)),
			});
		} catch (error) {
			lastLearnerError = error instanceof Error ? error.message : String(error);
			refreshFooter();
			safeAppendTasteActivity(pi, {
				version: 1,
				eventId: eventId(),
				timestamp: new Date().toISOString(),
				kind: "error",
				outcome: "failed",
				title: "Taste Learner failed",
				changes: [],
				files: tasteActivityFiles(stores.globalPaths, stores.projectPaths, []),
				detail: clipText(redactSensitive(lastLearnerError), 600),
			});
		}
	};

	const enqueueFeedback = (job: PendingFeedbackJob) => {
		queuedJobs += 1;
		refreshFooter();
		queue = queue
			.then(() => processFeedback(job))
			.catch((error) => {
				lastLearnerError = error instanceof Error ? error.message : String(error);
				refreshFooter();
			})
			.finally(() => {
				queuedJobs -= 1;
				refreshFooter();
			});
	};

	const flushPendingFeedback = () => {
		const jobs = pendingFeedback;
		pendingFeedback = [];
		for (const job of jobs) enqueueFeedback(job);
		refreshFooter();
	};

	pi.on("session_start", async (_event, ctx) => {
		config = await loadConfig();
		lastEnqueuedFingerprint = undefined;
		currentModel = ctx.model
			? { provider: ctx.model.provider, id: ctx.model.id, reasoning: ctx.model.reasoning }
			: undefined;
		currentThinkingLevel = ctx.thinkingLevel;
		installTasteFooter(
			ctx,
			() => ({
				learningEnabled: config.learningEnabled,
				queuedJobs: queuedJobs + pendingFeedback.length,
				hasError: Boolean(lastLearnerError),
				model: currentModel,
				thinkingLevel: currentThinkingLevel,
			}),
			(requestRender) => {
				requestFooterRender = requestRender;
			},
		);
		refreshFooter();
	});

	pi.on("input", (event, ctx) => {
		if (
			event.source === "extension" ||
			!config.learningEnabled ||
			!learningAllowedInProcess ||
			!event.text.trim()
		) {
			return;
		}
		const assistantText = event.streamingBehavior
			? currentRunAssistantText(ctx)
			: visibleAssistantText(ctx);
		const interaction: InteractionContext = {
			userText: event.text,
			assistantText,
		};
		const fingerprint = feedbackFingerprint(interaction, sessionId(ctx));
		if (fingerprint === lastEnqueuedFingerprint) return;
		lastEnqueuedFingerprint = fingerprint;
		pendingFeedback.push({ ctx, interaction, previousMessages: [], newMessages: [] });
		refreshFooter();
	});

	pi.on("agent_start", () => {
		currentRunMessages = [];
		liveAssistantMessage = undefined;
	});

	pi.on("message_update", (event) => {
		if ((event.message as any)?.role === "assistant") liveAssistantMessage = event.message;
	});

	pi.on("message_end", (event) => {
		const message = event.message as any;
		if (message?.role === "assistant" || message?.role === "toolResult") {
			currentRunMessages.push(message);
		}
		if (message?.role === "assistant") liveAssistantMessage = undefined;
	});

	pi.on("model_select", (event) => {
		currentModel = { provider: event.model.provider, id: event.model.id, reasoning: event.model.reasoning };
		refreshFooter();
	});

	pi.on("thinking_level_select", (event) => {
		currentThinkingLevel = event.level;
		refreshFooter();
	});

	pi.on("agent_settled", () => {
		flushPendingFeedback();
	});

	pi.on("session_shutdown", async () => {
		flushPendingFeedback();
		await queue;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		config = await loadConfig();
		const injection = await injectedSystemPrompt(event.systemPrompt, ctx.cwd, config);
		lastInjectionSnapshot = injection.snapshot;
		refreshFooter();
		return { systemPrompt: injection.systemPrompt };
	});

	pi.registerCommand("taste", {
		description: "Inspect and manage continuously learned coding Taste",
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
					const imported = await loadCommandCodeTaste(stores.projectRoot);
					if (config.learningEnabled) {
						const built = buildTasteSection(stores.project, stores.global, imported, config, true);
						lastInjectionSnapshot = snapshotForSection(built.section, built.count);
					} else lastInjectionSnapshot = { digest: "off", bytes: 0, count: 0 };
					const activeModel = resolveTasteModel(ctx, config);
					ctx.ui.notify(
						[
							`Taste: ${config.learningEnabled ? "on (automatic learning + injection)" : "off (automatic learning + injection disabled)"}${learningAllowedInProcess ? "" : " (learning unavailable for --no-session/subagent)"}`,
							`Taste model mode: ${config.observer.modelMode}`,
							`Learner: ${activeModel ? `${activeModel.provider}/${activeModel.id}` : "unavailable"}`,
							`Injection snapshot: ${lastInjectionSnapshot.digest} (${lastInjectionSnapshot.count} entries, ${lastInjectionSnapshot.bytes} bytes)`,
							`Queue: ${queuedJobs + pendingFeedback.length}`,
							`Global: ${statusCounts(stores.global)}`,
							`Project: ${stores.projectRoot ? statusCounts(stores.project) : "unavailable"}`,
							`Command Code read-only imports: ${imported.length}`,
							...(lastLearnerError ? [`Last Learner error: ${lastLearnerError}`] : []),
						].join("\n"),
						lastLearnerError ? "warning" : "info",
					);
					return;
				}

				if (subcommand === "paths") {
					const stores = await preferenceStores(ctx.cwd);
					const lines = [
						`Default manual scope: ${stores.projectPaths ? "project (use -g for global)" : "global (project unavailable)"}`,
						"",
						`Global taste.md: ${stores.globalPaths.taste}`,
					];
					if (stores.projectPaths) {
						lines.push("", `Project root: ${stores.projectRoot}`, `Project taste.md: ${stores.projectPaths.taste}`);
					} else lines.push("", "Project Taste: unavailable for the current working directory");
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}

				if (subcommand === "list") {
					const stores = await preferenceStores(ctx.cwd);
					const items = [
						...stores.project.map((preference) => ({ preference, label: "P" })),
						...stores.global.map((preference) => ({ preference, label: "G" })),
					];
					if (items.length === 0) {
						ctx.ui.notify("No Pi Taste learnings.", "info");
						return;
					}
					const visible = items.slice(0, 40).map(
						({ preference, label }) => `[${label}] ${preference.id} c=${preference.confidence.toFixed(2)} — ${preference.statement}`,
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
					if (!paths) throw new Error("Project Taste is unavailable for the current working directory.");
					const clean = statement.trim().replace(/^[-*]\s+/, "").replace(/\s+/g, " ").trim();
					await mutatePreferences(paths, (preferences) => {
						const key = normalizePreferenceKey(clean);
						const existing = preferences.find((item) => normalizePreferenceKey(item.statement) === key);
						if (existing) {
							existing.statement = clean;
							return;
						}
						preferences.push({
							id: `${scope === "global" ? "g" : "p"}_${createHash("sha256").update(`${scope}\0${key}`).digest("hex").slice(0, 12)}`,
							statement: clean,
							scope,
							confidence: 1,
						});
					});
					ctx.ui.notify(`Preference recorded in ${scope} Taste.`, "info");
					return;
				}

				if (subcommand === "import") {
					const explicitScope = requestedScope(rest);
					const forced = /(?:^|\s)--yes(?=\s|$)/.test(rest);
					const sourceInput = stripControlFlags(rest, true);
					if (!sourceInput) throw new Error("Usage: /taste import <markdown-file> [-g|--global|--project] [--yes]");
					const stores = await preferenceStores(ctx.cwd);
					const scope = explicitScope ?? (stores.projectPaths ? "project" : "global");
					const paths = scope === "project" ? stores.projectPaths : stores.globalPaths;
					if (!paths) throw new Error("Project Taste is unavailable for the current working directory.");
					const preview = await readTasteImport(sourceInput, ctx.cwd);
					if (!forced) {
						if (ctx.mode !== "tui") throw new Error("Use --yes to confirm Taste import outside TUI mode.");
						const confirmed = await ctx.ui.confirm(
							`Import ${preview.statements.length} preferences into ${scope} Taste?`,
							[`Source: ${preview.sourcePath}`, "", ...preview.statements.slice(0, 12).map((s) => `- ${s}`)].join("\n"),
						);
						if (!confirmed) return;
					}
					for (const statement of preview.statements) {
						await mutatePreferences(paths, (preferences) => {
							const clean = statement.trim().replace(/^[-*]\s+/, "").replace(/\s+/g, " ").trim();
							const key = normalizePreferenceKey(clean);
							if (!preferences.some((item) => normalizePreferenceKey(item.statement) === key)) {
								preferences.push({
									id: `${scope === "global" ? "g" : "p"}_${createHash("sha256").update(`${scope}\0${key}`).digest("hex").slice(0, 12)}`,
									statement: clean,
									scope,
									confidence: 1,
								});
							}
						});
					}
					ctx.ui.notify(`Imported ${preview.statements.length} preferences into ${scope} Taste.`, "info");
					return;
				}

				if (subcommand === "move") {
					const id = restParts.find((token) => token !== "global" && token !== "project");
					if (!id) throw new Error("Usage: /taste move <id> [global|project]");
					let targetScope = restParts.find((token): token is TasteScope => token === "global" || token === "project");
					if (!targetScope) throw new Error("Usage: /taste move <id> global|project");
					const stores = await preferenceStores(ctx.cwd);
					const source = [...stores.global.map((p) => ({ p, paths: stores.globalPaths })), ...stores.project.map((p) => ({ p, paths: stores.projectPaths! }))]
						.find(({ p }) => p.id === id || p.id.startsWith(id));
					if (!source) throw new Error(`No preference matches ${id}`);
					const targetPaths = targetScope === "project" ? stores.projectPaths : stores.globalPaths;
					if (!targetPaths) throw new Error("Project Taste is unavailable for the current working directory.");
					await mutatePreferences(source.paths, (preferences) => {
						const index = preferences.findIndex((item) => item.id === source.p.id);
						if (index >= 0) preferences.splice(index, 1);
					});
					await mutatePreferences(targetPaths, (preferences) => {
						preferences.push({ ...source.p, scope: targetScope });
					});
					ctx.ui.notify(`Preference moved to ${targetScope} Taste.`, "info");
					return;
				}

				if (subcommand === "forget") {
					if (!rest) throw new Error("Usage: /taste forget <id>");
					const stores = await preferenceStores(ctx.cwd);
					const found = [...stores.global.map((p) => ({ p, paths: stores.globalPaths })), ...stores.project.map((p) => ({ p, paths: stores.projectPaths! }))]
						.find(({ p }) => p.id === rest || p.id.startsWith(rest));
					if (!found) throw new Error(`No preference matches ${rest}`);
					await mutatePreferences(found.paths, (preferences) => {
						const index = preferences.findIndex((item) => item.id === found.p.id);
						if (index >= 0) preferences.splice(index, 1);
					});
					ctx.ui.notify("Preference removed.", "info");
					return;
				}

				if (subcommand === "retry") {
					ctx.ui.notify("Manual retry is not needed in v3: the Learner runs after every settled turn and writes directly.", "info");
					return;
				}

				if (subcommand === "on" || subcommand === "off") {
					config = await loadConfig();
					config.learningEnabled = subcommand === "on";
					await saveConfig(config);
					lastLearnerError = undefined;
					if (config.learningEnabled) {
						const stores = await preferenceStores(ctx.cwd);
						const imported = await loadCommandCodeTaste(stores.projectRoot);
						const built = buildTasteSection(stores.project, stores.global, imported, config, true);
						lastInjectionSnapshot = snapshotForSection(built.section, built.count);
					} else lastInjectionSnapshot = { digest: "off", bytes: 0, count: 0 };
					refreshFooter();
					ctx.ui.notify(
						config.learningEnabled
							? "Taste on. Automatic learning and Taste injection are enabled."
							: "Taste off. Automatic learning and all Taste injection are disabled; stored state is preserved.",
						"info",
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
						if (selectedMode === "follow") modelArgs = ["inherit"];
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
						const models = ctx.modelRegistry.getAvailable()
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
							throw new Error("Usage: /taste model [status|inherit|select|set|only|add|remove|list] [provider/model|search]");
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
					lastLearnerError = undefined;
					refreshFooter();
					ctx.ui.notify(
						`Taste model: ${config.observer.modelMode === "inherit" ? "follows current main model" : config.observer.models.map(modelReferenceText).join(" → ")}.`,
						"info",
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
