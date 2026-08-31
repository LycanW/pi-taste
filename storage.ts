import { constants as fsConstants, createReadStream, existsSync } from "node:fs";
import {
	access,
	appendFile,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
	ImportedTaste,
	PreferenceFile,
	ProjectTasteConfig,
	StorePaths,
	TasteConfig,
	TasteEvent,
	TasteScope,
} from "./types.ts";

const STORE_VERSION = 1 as const;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 50;
const LOCK_ATTEMPTS = 100;

export function globalTasteDir(): string {
	const override = process.env.PI_TASTE_DIR?.trim();
	return override ? resolve(override) : join(getAgentDir(), "taste");
}

export function defaultConfig(): TasteConfig {
	return {
		version: STORE_VERSION,
		learningEnabled: true,
		observer: {
			modelMode: "inherit",
			models: [],
			reasoning: "low",
			maxOutputTokens: 2_000,
			timeoutMs: 45_000,
			maxInputChars: 24_000,
		},
		injection: {
			includeCommandCode: true,
			maxPreferences: 80,
			maxChars: 16_000,
		},
	};
}

export function defaultProjectConfig(): ProjectTasteConfig {
	return { version: STORE_VERSION, includeGlobalTaste: true };
}

export function emptyPreferenceFile(): PreferenceFile {
	return { version: STORE_VERSION, updatedAt: new Date(0).toISOString(), preferences: [] };
}

export function globalStorePaths(): StorePaths {
	const dir = globalTasteDir();
	return {
		dir,
		preferences: join(dir, "preferences.json"),
		taste: join(dir, "taste.md"),
		events: join(dir, "events.jsonl"),
		lock: join(dir, ".lock"),
		scope: "global",
	};
}

export function findProjectRoot(cwd: string): string {
	const workspaceRoot = resolve(cwd);
	let current = workspaceRoot;
	while (true) {
		if (existsSync(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return workspaceRoot;
		current = parent;
	}
}

export function projectStorePaths(projectRoot: string | undefined): StorePaths | undefined {
	if (!projectRoot) return undefined;
	const dir = join(projectRoot, ".pi", "taste");
	return {
		dir,
		preferences: join(dir, "preferences.json"),
		taste: join(dir, "taste.md"),
		events: join(dir, "events.jsonl"),
		lock: join(dir, ".lock"),
		scope: "project",
		projectRoot,
	};
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function atomicWrite(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, path);
}

export async function ensureGlobalStore(): Promise<void> {
	const paths = globalStorePaths();
	await mkdir(paths.dir, { recursive: true, mode: 0o700 });
	if (!(await exists(join(paths.dir, "config.json")))) {
		await atomicWrite(join(paths.dir, "config.json"), `${JSON.stringify(defaultConfig(), null, 2)}\n`);
	}
	if (!(await exists(paths.preferences))) {
		await atomicWrite(paths.preferences, `${JSON.stringify(emptyPreferenceFile(), null, 2)}\n`);
	}
	if (!(await exists(paths.taste))) {
		await atomicWrite(paths.taste, renderTasteMarkdown(emptyPreferenceFile(), "global"));
	}
	if (!(await exists(paths.events))) {
		await writeFile(paths.events, "", { encoding: "utf8", mode: 0o600, flag: "a" });
	}
}

export function projectConfigPath(paths: StorePaths): string {
	return join(paths.dir, "config.json");
}

export async function ensureProjectStore(paths: StorePaths): Promise<void> {
	if (paths.scope !== "project") throw new Error("Project store paths are required.");
	await mkdir(paths.dir, { recursive: true, mode: 0o700 });
	if (!(await exists(projectConfigPath(paths)))) {
		await atomicWrite(projectConfigPath(paths), `${JSON.stringify(defaultProjectConfig(), null, 2)}\n`);
	}
	if (!(await exists(paths.preferences))) {
		await atomicWrite(paths.preferences, `${JSON.stringify(emptyPreferenceFile(), null, 2)}\n`);
	}
	if (!(await exists(paths.taste))) {
		await atomicWrite(paths.taste, renderTasteMarkdown(emptyPreferenceFile(), "project"));
	}
	if (!(await exists(paths.events))) {
		await writeFile(paths.events, "", { encoding: "utf8", mode: 0o600, flag: "a" });
	}
	const ignorePath = join(paths.dir, ".gitignore");
	if (!(await exists(ignorePath))) {
		await atomicWrite(
			ignorePath,
			"# Pi Taste may contain private preference evidence and audit logs.\n*\n!.gitignore\n",
		);
	}
}

function mergeConfig(value: unknown): TasteConfig {
	const defaults = defaultConfig();
	if (!value || typeof value !== "object") return defaults;
	const input = value as Partial<TasteConfig>;
	const observer = input.observer && typeof input.observer === "object" ? input.observer : defaults.observer;
	const injection = input.injection && typeof input.injection === "object" ? input.injection : defaults.injection;
	const models = Array.isArray(observer.models)
		? observer.models.filter(
				(model): model is { provider: string; model: string } =>
					Boolean(
						model &&
							typeof model === "object" &&
							typeof model.provider === "string" &&
							typeof model.model === "string",
					),
			)
		: defaults.observer.models;

	return {
		version: STORE_VERSION,
		learningEnabled: typeof input.learningEnabled === "boolean" ? input.learningEnabled : defaults.learningEnabled,
		observer: {
			modelMode: observer.modelMode === "custom" ? "custom" : "inherit",
			models,
			reasoning:
				observer.reasoning === "minimal" || observer.reasoning === "low" || observer.reasoning === "medium"
					? observer.reasoning
					: defaults.observer.reasoning,
			maxOutputTokens: boundedNumber(observer.maxOutputTokens, 256, 8_192, defaults.observer.maxOutputTokens),
			timeoutMs: boundedNumber(observer.timeoutMs, 5_000, 180_000, defaults.observer.timeoutMs),
			maxInputChars: boundedNumber(observer.maxInputChars, 4_000, 100_000, defaults.observer.maxInputChars),
		},
		injection: {
			includeCommandCode:
				typeof injection.includeCommandCode === "boolean"
					? injection.includeCommandCode
					: defaults.injection.includeCommandCode,
			maxPreferences: boundedNumber(injection.maxPreferences, 1, 500, defaults.injection.maxPreferences),
			maxChars: boundedNumber(injection.maxChars, 1_000, 100_000, defaults.injection.maxChars),
		},
	};
}

function boundedNumber(value: unknown, min: number, max: number, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.round(Math.min(max, Math.max(min, value)))
		: fallback;
}

export async function loadConfig(): Promise<TasteConfig> {
	await ensureGlobalStore();
	const path = join(globalTasteDir(), "config.json");
	try {
		return mergeConfig(JSON.parse(await readFile(path, "utf8")) as unknown);
	} catch (error) {
		throw new Error(`Could not read Taste config at ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function saveConfig(config: TasteConfig): Promise<void> {
	await atomicWrite(join(globalTasteDir(), "config.json"), `${JSON.stringify(mergeConfig(config), null, 2)}\n`);
}

function mergeProjectConfig(value: unknown): ProjectTasteConfig {
	const input = value && typeof value === "object" ? (value as Partial<ProjectTasteConfig>) : {};
	return {
		version: STORE_VERSION,
		includeGlobalTaste: typeof input.includeGlobalTaste === "boolean" ? input.includeGlobalTaste : false,
	};
}

export async function loadProjectConfig(paths: StorePaths): Promise<ProjectTasteConfig> {
	await ensureProjectStore(paths);
	const path = projectConfigPath(paths);
	try {
		return mergeProjectConfig(JSON.parse(await readFile(path, "utf8")) as unknown);
	} catch (error) {
		throw new Error(`Could not read project Taste config at ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function saveProjectConfig(paths: StorePaths, config: ProjectTasteConfig): Promise<void> {
	await ensureProjectStore(paths);
	await atomicWrite(projectConfigPath(paths), `${JSON.stringify(mergeProjectConfig(config), null, 2)}\n`);
}

export async function loadPreferenceFile(paths: StorePaths): Promise<PreferenceFile> {
	if (!(await exists(paths.preferences))) return emptyPreferenceFile();
	try {
		const value = JSON.parse(await readFile(paths.preferences, "utf8")) as PreferenceFile;
		if (value.version !== STORE_VERSION || !Array.isArray(value.preferences)) {
			throw new Error("unsupported or malformed preferences file");
		}
		return value;
	} catch (error) {
		throw new Error(
			`Could not read Taste preferences at ${paths.preferences}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export function renderTasteMarkdown(file: PreferenceFile, scope: TasteScope): string {
	const approved = file.preferences
		.filter((preference) => preference.status === "approved")
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	const lines = [
		"# Pi Taste",
		"",
		`<!-- Generated from preferences.json. Scope: ${scope}. Review or edit through /taste commands. -->`,
		"",
	];
	if (approved.length === 0) {
		lines.push("_No approved preferences._", "");
		return lines.join("\n");
	}
	for (const preference of approved) {
		lines.push(`- ${preference.statement}`);
		lines.push(
			`  <!-- id: ${preference.id}; confidence: ${preference.confidence.toFixed(2)}; evidence: ${preference.supportCount} -->`,
		);
	}
	lines.push("");
	return lines.join("\n");
}

async function savePreferenceFileUnlocked(paths: StorePaths, file: PreferenceFile): Promise<void> {
	file.updatedAt = new Date().toISOString();
	await mkdir(paths.dir, { recursive: true, mode: 0o700 });
	await atomicWrite(paths.preferences, `${JSON.stringify(file, null, 2)}\n`);
	await atomicWrite(paths.taste, renderTasteMarkdown(file, paths.scope));
}

async function acquireLock(paths: StorePaths): Promise<() => Promise<void>> {
	await mkdir(paths.dir, { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
		try {
			const handle = await open(paths.lock, "wx", 0o600);
			await handle.writeFile(`${process.pid} ${Date.now()}\n`, "utf8");
			await handle.close();
			return async () => {
				try {
					await unlink(paths.lock);
				} catch {
					// Another process may have cleared a stale lock.
				}
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				const info = await stat(paths.lock);
				if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
					await unlink(paths.lock);
					continue;
				}
			} catch {
				continue;
			}
			await new Promise((resolveWait) => setTimeout(resolveWait, LOCK_WAIT_MS));
		}
	}
	throw new Error(`Timed out waiting for Taste store lock: ${paths.lock}`);
}

export async function mutatePreferenceFile<T>(
	paths: StorePaths,
	mutator: (file: PreferenceFile) => T | Promise<T>,
): Promise<T> {
	const release = await acquireLock(paths);
	try {
		const file = await loadPreferenceFile(paths);
		const result = await mutator(file);
		await savePreferenceFileUnlocked(paths, file);
		return result;
	} finally {
		await release();
	}
}

export async function mutatePreferenceFiles<T>(
	stores: StorePaths[],
	mutator: (files: Map<TasteScope, PreferenceFile>) => T | Promise<T>,
): Promise<T> {
	const writeOrder = Array.from(new Map(stores.map((paths) => [paths.dir, paths])).values());
	const lockOrder = [...writeOrder].sort((a, b) => a.lock.localeCompare(b.lock));
	const releases: Array<() => Promise<void>> = [];
	try {
		for (const paths of lockOrder) releases.push(await acquireLock(paths));
		const files = new Map<TasteScope, PreferenceFile>();
		for (const paths of writeOrder) files.set(paths.scope, await loadPreferenceFile(paths));
		const result = await mutator(files);
		for (const paths of writeOrder) await savePreferenceFileUnlocked(paths, files.get(paths.scope)!);
		return result;
	} finally {
		for (const release of releases.reverse()) await release();
	}
}

export async function regenerateTaste(paths: StorePaths): Promise<void> {
	await mutatePreferenceFile(paths, () => undefined);
}

export async function appendEvent(paths: StorePaths, event: TasteEvent): Promise<void> {
	await mkdir(paths.dir, { recursive: true, mode: 0o700 });
	await appendFile(paths.events, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
}

export async function findRetryableObserverEvent(
	paths: StorePaths,
	projectRoot: string,
	eventId?: string,
): Promise<{ event?: TasteEvent; reason?: string }> {
	await mkdir(paths.dir, { recursive: true, mode: 0o700 });
	if (!(await exists(paths.events))) {
		return { reason: "No retryable failed Observer event was found in the current project" };
	}
	const failedRoots = new Map<string, TasteEvent>();
	const retryRoots = new Map<string, string>();
	const completedRetries = new Set<string>();
	const lines = createInterface({
		input: createReadStream(paths.events, { encoding: "utf8" }),
		crlfDelay: Infinity,
	});
	for await (const line of lines) {
		if (!line.trim()) continue;
		let event: TasteEvent;
		try {
			event = JSON.parse(line) as TasteEvent;
		} catch {
			continue;
		}
		if (event.type !== "observer" || event.projectRoot !== projectRoot) continue;
		const retryOf = typeof event.details?.retryOf === "string" ? event.details.retryOf : undefined;
		if (retryOf) {
			retryRoots.set(event.id, retryOf);
			if (event.observer?.status === "completed" || event.observer?.status === "skipped") {
				completedRetries.add(retryOf);
			}
			continue;
		}
		if (
			event.observer?.status === "failed" &&
			typeof event.interaction?.currentUserFeedback === "string" &&
			event.interaction.currentUserFeedback.trim()
		) {
			failedRoots.set(event.id, event);
		}
	}

	if (eventId) {
		const rootId = retryRoots.get(eventId) ?? eventId;
		const event = failedRoots.get(rootId);
		if (!event) return { reason: `Failed Observer event ${eventId} was not found in the current project` };
		if (completedRetries.has(rootId)) return { reason: `Observer event ${rootId} was already retried successfully` };
		return { event };
	}

	const candidates = [...failedRoots.values()].filter((event) => !completedRetries.has(event.id));
	const event = candidates.at(-1);
	return event ? { event } : { reason: "No retryable failed Observer event was found in the current project" };
}

export function normalizePreferenceKey(value: string): string {
	return value
		.normalize("NFKC")
		.toLocaleLowerCase()
		.replace(/\bconfidence\s*:\s*(?:0(?:\.\d+)?|1(?:\.0+)?)\b/gi, "")
		.replace(/[\p{P}\p{S}\s]+/gu, " ")
		.trim();
}

export function clipText(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	const head = Math.max(0, Math.floor(maxChars * 0.35));
	const tail = Math.max(0, maxChars - head - 40);
	return `${value.slice(0, head)}\n[… ${value.length - head - tail} chars omitted …]\n${value.slice(-tail)}`;
}

export function redactSensitive(value: string): string {
	return value
		.replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g, "[REDACTED_TOKEN]")
		.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/gi, "Bearer [REDACTED_TOKEN]")
		.replace(
			/((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*["']?)[^\s"']{8,}/gi,
			"$1[REDACTED]",
		);
}

function parseTasteMarkdown(content: string, scope: TasteScope, sourcePath: string): ImportedTaste[] {
	const result: ImportedTaste[] = [];
	for (const line of content.split(/\r?\n/)) {
		const match = line.match(/^\s*-\s+(.+?)\s*$/);
		if (!match) continue;
		const statement = match[1]
			.replace(/\s+Confidence:\s*(?:0(?:\.\d+)?|1(?:\.0+)?)\s*\.?\s*$/i, "")
			.trim();
		if (statement.length >= 4) result.push({ scope, statement, sourcePath });
	}
	return result;
}

async function readTasteFile(path: string, scope: TasteScope): Promise<ImportedTaste[]> {
	try {
		return parseTasteMarkdown(await readFile(path, "utf8"), scope, path);
	} catch {
		return [];
	}
}

async function commandCodePackageFiles(base: string): Promise<string[]> {
	const files: string[] = [];
	const main = join(base, "taste.md");
	if (await exists(main)) files.push(main);
	try {
		const entries = await readdir(base, { withFileTypes: true });
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (!/^[A-Za-z0-9_.-]{1,64}$/.test(entry.name) || entry.name.startsWith("--")) continue;
			const candidate = join(base, entry.name, "taste.md");
			if (await exists(candidate)) files.push(candidate);
		}
	} catch {
		// Command Code Taste is an optional read-only source.
	}
	return files;
}

export async function loadCommandCodeTaste(projectRoot?: string): Promise<ImportedTaste[]> {
	const sources: Array<{ base: string; scope: TasteScope }> = [
		{ base: join(homedir(), ".commandcode", "taste"), scope: "global" },
	];
	if (projectRoot) sources.push({ base: join(projectRoot, ".commandcode", "taste"), scope: "project" });

	const imported: ImportedTaste[] = [];
	const seen = new Set<string>();
	for (const source of sources) {
		for (const path of await commandCodePackageFiles(source.base)) {
			for (const item of await readTasteFile(path, source.scope)) {
				const key = `${item.scope}:${normalizePreferenceKey(item.statement)}`;
				if (!key.endsWith(":" ) && !seen.has(key)) {
					seen.add(key);
					imported.push(item);
				}
			}
		}
	}
	return imported;
}
