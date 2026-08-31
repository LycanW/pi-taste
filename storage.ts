import { createHash } from "node:crypto";
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
	Preference,
	StorePaths,
	TasteConfig,
	TasteEvent,
	TasteScope,
} from "./types.ts";

const STORE_VERSION = 2 as const;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 50;
const LOCK_ATTEMPTS = 100;

export const AUDIT_MAX_BYTES = 10 * 1024 * 1024;
export const AUDIT_MAX_LINES = 10_000;
export const AUDIT_MAX_SEGMENTS = 20;
export const AUDIT_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

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
			maxPreferences: 80,
			maxChars: 16_000,
		},
	};
}

export function emptyPreferenceFile(): { version: 2; updatedAt: string; preferences: Preference[] } {
	return { version: STORE_VERSION, updatedAt: new Date(0).toISOString(), preferences: [] };
}

export function globalStorePaths(): StorePaths {
	const dir = globalTasteDir();
	return {
		dir,
		taste: join(dir, "taste.md"),
		auditDir: join(dir, "audit"),
		audit: join(dir, "audit", "current.jsonl"),
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
		taste: join(dir, "taste.md"),
		auditDir: join(dir, "audit"),
		audit: join(dir, "audit", "current.jsonl"),
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
	if (!(await exists(paths.taste))) {
		await atomicWrite(paths.taste, renderTasteMarkdown([], "global"));
	}
	await mkdir(paths.auditDir, { recursive: true, mode: 0o700 });
	if (!(await exists(paths.audit))) {
		await writeFile(paths.audit, "", { encoding: "utf8", mode: 0o600, flag: "a" });
	}
}

export async function ensureProjectStore(paths: StorePaths): Promise<void> {
	await mkdir(paths.dir, { recursive: true, mode: 0o700 });
	if (!(await exists(paths.taste))) {
		await atomicWrite(paths.taste, renderTasteMarkdown([], paths.scope));
	}
	await mkdir(paths.auditDir, { recursive: true, mode: 0o700 });
	if (!(await exists(paths.audit))) {
		await writeFile(paths.audit, "", { encoding: "utf8", mode: 0o600, flag: "a" });
	}
	if (paths.scope === "project") {
		const ignorePath = join(paths.dir, ".gitignore");
		if (!(await exists(ignorePath))) {
			await atomicWrite(
				ignorePath,
				"# Pi Taste may contain private preference evidence and audit logs.\n*\n!.gitignore\n",
			);
		}
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

// ---------------------------------------------------------------------------
// taste.md — the single authoritative preference file (v2)
// ---------------------------------------------------------------------------

export interface TasteFileState {
	version: number;
	includeGlobalTaste: boolean;
	preferences: Preference[];
	raw: string;
}

export function renderTasteMarkdown(preferences: Preference[], scope: TasteScope, includeGlobalTaste = true): string {
	const lines = [
		"---",
		"generated: true",
		`includeGlobalTaste: ${includeGlobalTaste}`,
		"---",
		"",
		"# Pi Taste",
		"",
		"<!-- Single-source preference file. Edit through /taste commands or approve pending entries. -->",
		"",
	];
	if (preferences.length === 0) {
		lines.push("_No preferences yet._", "");
		return lines.join("\n");
	}
	for (const preference of preferences) {
		const confidence = `${Math.round(100 * preference.confidence)}%`;
		switch (preference.status) {
			case "approved":
				lines.push(`- ${preference.statement} Confidence: ${confidence}`);
				break;
			case "pending":
				lines.push(`- ${preference.statement} Confidence: ${confidence} [pending]`);
				break;
			case "rejected":
				lines.push(`- ${preference.statement} Confidence: ${confidence} [rejected]`);
				break;
			case "superseded":
				lines.push(`- ${preference.statement} Confidence: ${confidence} [superseded]`);
				break;
		}
	}
	lines.push("");
	return lines.join("\n");
}

const PREFERENCE_LINE = /^\s*-\s+(.+?)(?:\s+Confidence:\s*(\d*\.?\d+%?))?(?:\s+\[(approved|pending|rejected|superseded)\])?\s*$/i;

interface ParsedLine {
	statement: string;
	confidence?: number;
	status?: string;
}

export function parseTasteMarkdown(content: string, scope: TasteScope): TasteFileState {
	let version = 2;
	let includeGlobalTaste = true;
	const preferences: Preference[] = [];
	const seenStatements = new Set<string>();
	const lines = content.split(/\r?\n/);
	let inFrontmatter = false;
	let fmLines: string[] = [];
	for (const line of lines) {
		if (line === "---" && !inFrontmatter) {
			inFrontmatter = true;
			fmLines = [];
			continue;
		}
		if (line === "---" && inFrontmatter) {
			inFrontmatter = false;
			const fm = fmLines.join("\n");
			const include = fm.match(/includeGlobalTaste:\s*(true|false)/i);
			if (include) includeGlobalTaste = include[1] === "true";
			const ver = fm.match(/version:\s*(\d+)/i);
			if (ver) version = Number(ver[1]);
			continue;
		}
		if (inFrontmatter) {
			fmLines.push(line);
			continue;
		}
		const match = line.match(PREFERENCE_LINE);
		if (!match) continue;
		const statement = match[1].trim();
		const confidence = match[2]
			? (() => {
					const raw = match[2].trim();
					if (raw.endsWith("%")) return Number.parseFloat(raw.slice(0, -1)) / 100;
					return Number.parseFloat(raw);
				})()
			: undefined;
		const status = (match[3] ?? "approved").toLowerCase();
		const key = normalizePreferenceKey(statement);
		if (statement.length < 4 || !key || seenStatements.has(key)) continue;
		seenStatements.add(key);
		preferences.push({
			id: preferenceId(statement, scope),
			statement,
			scope,
			status: (["approved", "pending", "rejected", "superseded"] as const).includes(
				status as Preference["status"],
			)
				? (status as Preference["status"])
				: "approved",
			confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence ?? 0.5)) : 0.5,
		});
	}
	return { version, includeGlobalTaste, preferences, raw: content };
}

export function preferenceId(statement: string, scope: TasteScope): string {
	const digest = createHash("sha256").update(`${scope}\0${normalizePreferenceKey(statement)}`).digest("hex").slice(0, 12);
	return `${scope === "global" ? "g" : "p"}_${digest}`;
}

async function loadTasteState(paths: StorePaths): Promise<TasteFileState> {
	if (!(await exists(paths.taste))) return { version: 2, includeGlobalTaste: true, preferences: [], raw: "" };
	const raw = await readFile(paths.taste, "utf8");
	return parseTasteMarkdown(raw, paths.scope);
}

export async function loadPreferences(paths: StorePaths): Promise<Preference[]> {
	return (await loadTasteState(paths)).preferences;
}

export async function loadIncludeGlobalTaste(paths: StorePaths): Promise<boolean> {
	return (await loadTasteState(paths)).includeGlobalTaste;
}

/** Set the project's includeGlobalTaste frontmatter flag in taste.md. */
export async function saveProjectIncludeGlobal(paths: StorePaths, enabled: boolean): Promise<void> {
	await ensureProjectStore(paths);
	const state = await loadTasteState(paths);
	const content = renderTasteMarkdown(state.preferences, paths.scope, enabled);
	await atomicWrite(paths.taste, content);
}

export async function savePreferencesUnlocked(paths: StorePaths, preferences: Preference[]): Promise<void> {
	await ensureProjectStore(paths);
	const state = await loadTasteState(paths);
	const content = renderTasteMarkdown(preferences, paths.scope, state.includeGlobalTaste);
	await atomicWrite(paths.taste, content);
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

export async function mutatePreferences<T>(
	paths: StorePaths,
	mutator: (preferences: Preference[]) => T | Promise<T>,
): Promise<T> {
	const release = await acquireLock(paths);
	try {
		const preferences = await loadPreferences(paths);
		const result = await mutator(preferences);
		await savePreferencesUnlocked(paths, preferences);
		return result;
	} finally {
		await release();
	}
}

export async function mutatePreferencesMultiple<T>(
	stores: StorePaths[],
	mutator: (preferences: Map<TasteScope, Preference[]>) => T | Promise<T>,
): Promise<T> {
	const writeOrder = Array.from(new Map(stores.map((paths) => [paths.dir, paths])).values());
	const lockOrder = [...writeOrder].sort((a, b) => a.lock.localeCompare(b.lock));
	const releases: Array<() => Promise<void>> = [];
	try {
		for (const paths of lockOrder) releases.push(await acquireLock(paths));
		const files = new Map<TasteScope, Preference[]>();
		for (const paths of writeOrder) files.set(paths.scope, await loadPreferences(paths));
		const result = await mutator(files);
		for (const paths of writeOrder) await savePreferencesUnlocked(paths, files.get(paths.scope)!);
		return result;
	} finally {
		for (const release of releases.reverse()) await release();
	}
}

// ---------------------------------------------------------------------------
// Bounded audit log (v2)
// ---------------------------------------------------------------------------

async function auditSegments(paths: StorePaths): Promise<string[]> {
	try {
		const entries = await readdir(paths.auditDir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && /^segment-.*\.jsonl$/.test(entry.name))
			.map((entry) => join(paths.auditDir, entry.name))
			.sort();
	} catch {
		return [];
	}
}

async function enforceAuditBounds(paths: StorePaths): Promise<void> {
	const segments = await auditSegments(paths);
	if (segments.length > AUDIT_MAX_SEGMENTS) {
		for (const path of segments.slice(0, segments.length - AUDIT_MAX_SEGMENTS)) {
			await unlink(path).catch(() => undefined);
		}
	}
	const kept = await auditSegments(paths);
	let total = 0;
	for (const path of kept) {
		try {
			total += (await stat(path)).size;
		} catch {}
	}
	if (total > AUDIT_MAX_TOTAL_BYTES) {
		// Prefer evicting oldest segments while keeping the most recent.
		for (const path of kept.slice(0, kept.length - 1)) {
			await unlink(path).catch(() => undefined);
			total = 0;
			for (const remaining of await auditSegments(paths)) {
				try {
					total += (await stat(remaining)).size;
				} catch {}
			}
			if (total <= AUDIT_MAX_TOTAL_BYTES) break;
		}
	}
}

export async function appendEvent(paths: StorePaths, event: TasteEvent): Promise<void> {
	await mkdir(paths.auditDir, { recursive: true, mode: 0o700 });
	const line = `${JSON.stringify(event)}\n`;
	const currentSize = await stat(paths.audit).then((info) => info.size).catch(() => 0);
	if (currentSize > AUDIT_MAX_BYTES) {
		// Rotate: rename current.jsonl to segment-<timestamp>.jsonl and start fresh.
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		await rename(paths.audit, join(paths.auditDir, `segment-${stamp}.jsonl`)).catch(() => undefined);
		await writeFile(paths.audit, "", { encoding: "utf8", mode: 0o600, flag: "a" });
		await enforceAuditBounds(paths);
	}
	await appendFile(paths.audit, line, { encoding: "utf8", mode: 0o600, flag: "a" });
}

/** Count lines; used by tests and status UI. */
export async function countAuditLines(paths: StorePaths): Promise<number> {
	try {
		let count = 0;
		const stream = createReadStream(paths.audit, { encoding: "utf8" });
		const lines = createInterface({ input: stream, crlfDelay: Infinity });
		for await (const line of lines) if (line.trim()) count += 1;
		return count;
	} catch {
		return 0;
	}
}

export async function findRetryableObserverEvent(
	paths: StorePaths,
	projectRoot: string,
	eventId?: string,
): Promise<{ event?: TasteEvent; reason?: string }> {
	await mkdir(paths.auditDir, { recursive: true, mode: 0o700 });
	const segmentPaths = [paths.audit, ...(await auditSegments(paths))];
	const failedRoots = new Map<string, TasteEvent>();
	const retryRoots = new Map<string, string>();
	const completedRetries = new Set<string>();
	for (const path of segmentPaths) {
		if (!(await exists(path))) continue;
		const stream = createReadStream(path, { encoding: "utf8" });
		const lines = createInterface({ input: stream, crlfDelay: Infinity });
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
				typeof event.interaction?.userText === "string" &&
				event.interaction.userText.trim()
			) {
				failedRoots.set(event.id, event);
			}
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

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

export function normalizePreferenceKey(value: string): string {
	return value
		.normalize("NFKC")
		.toLocaleLowerCase()
		.replace(/\bconfidence\s*:\s*(?:0(?:\.\d+)?|1(?:\.0+)?)\b/gi, "")
		.replace(/\s+\[(?:approved|pending|rejected|superseded)\]\s*$/i, "")
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

// ---------------------------------------------------------------------------
// Command Code read-only compatibility (unchanged behavior, v2 types)
// ---------------------------------------------------------------------------

function parseCommandCodeMarkdown(content: string, scope: TasteScope, sourcePath: string): ImportedTaste[] {
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
		return parseCommandCodeMarkdown(await readFile(path, "utf8"), scope, path);
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
				if (!key.endsWith(":") && !seen.has(key)) {
					seen.add(key);
					imported.push(item);
				}
			}
		}
	}
	return imported;
}
