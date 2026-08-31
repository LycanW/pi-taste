import { createHash } from "node:crypto";
import { constants as fsConstants, existsSync } from "node:fs";
import { access, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ImportedTaste, Preference, StorePaths, TasteConfig, TasteScope } from "./types.ts";

const STORE_VERSION = 3 as const;
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
			maxOutputTokens: 6_000,
			timeoutMs: 90_000,
			maxInputChars: 30_000,
		},
		injection: {
			maxChars: 16_000,
		},
	};
}

export function globalStorePaths(): StorePaths {
	const dir = globalTasteDir();
	return {
		dir,
		taste: join(dir, "taste.md"),
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
	if (!(await exists(join(paths.dir, "taste.md")))) {
		await atomicWrite(join(paths.dir, "taste.md"), "");
	}
}

export async function ensureProjectStore(paths: StorePaths): Promise<void> {
	await mkdir(paths.dir, { recursive: true, mode: 0o700 });
	if (!(await exists(paths.taste))) {
		await atomicWrite(paths.taste, "");
	}
	if (paths.scope === "project") {
		const ignorePath = join(paths.dir, ".gitignore");
		if (!(await exists(ignorePath))) {
			await atomicWrite(
				ignorePath,
				"# Pi Taste may contain private preference state.\n*\n!.gitignore\n",
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
			maxOutputTokens: boundedNumber(observer.maxOutputTokens, 256, 16_000, defaults.observer.maxOutputTokens),
			timeoutMs: boundedNumber(observer.timeoutMs, 5_000, 180_000, defaults.observer.timeoutMs),
			maxInputChars: boundedNumber(observer.maxInputChars, 4_000, 100_000, defaults.observer.maxInputChars),
		},
		injection: {
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
// taste.md — Command Code compatible single-source file
// ---------------------------------------------------------------------------

const CONFIDENCE = /^- .*\. Confidence: (\d*\.?\d+)$/;

export function countLearnings(content: string): number {
	return content.split(/\r?\n/).filter((line) => line.trim().startsWith("-") && line.includes("Confidence:")).length;
}

export function parseLearnings(content: string, scope: TasteScope): Preference[] {
	const result: Preference[] = [];
	for (const line of content.split(/\r?\n/)) {
		const match = line.match(/^\s*-\s+((?:.+?\.)+)\s+Confidence:\s*(\d*\.?\d+)\s*$/);
		if (!match) continue;
		const statement = match[1].trim();
		const confidence = match[2] ? Number.parseFloat(match[2]) : undefined;
		if (statement.length < 4) continue;
		result.push({
			id: preferenceId(statement, scope),
			statement,
			scope,
			confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence ?? 0.5)) : 0.5,
		});
	}
	return result;
}

export function preferenceId(statement: string, scope: TasteScope): string {
	const digest = createHash("sha256").update(`${scope}\0${statement.toLocaleLowerCase()}`).digest("hex").slice(0, 12);
	return `${scope === "global" ? "g" : "p"}_${digest}`;
}

export function renderTasteMarkdown(preferences: Preference[], scope: TasteScope): string {
	return preferences
		.map((preference) => `- ${preference.statement} Confidence: ${preference.confidence.toFixed(1)}`)
		.join("\n") + (preferences.length > 0 ? "\n" : "");
}

/** Tree representation like Command Code's getTasteStructure(). */
export async function getTasteStructure(paths: StorePaths): Promise<string> {
	if (!(await exists(paths.dir))) return "(empty - no taste files yet)";
	const tree = await buildTree(paths.dir);
	return tree.length > 0 ? tree : "(empty - no taste files yet)";
}

async function buildTree(dir: string, prefix = ""): Promise<string> {
	let entries: string[] = [];
	try {
		entries = [...(await readdir(dir))].sort();
	} catch {
		return "";
	}
	let out = "";
	for (let index = 0; index < entries.length; index++) {
		const name = entries[index];
		const isLast = index === entries.length - 1;
		const connector = isLast ? "└── " : "├── ";
		const full = join(dir, name);
		let isDir = false;
		try {
			isDir = (await stat(full)).isDirectory();
		} catch {}
		if (isDir) {
			out += `${prefix}${connector}${name}/\n`;
			out += await buildTree(full, prefix + (isLast ? "    " : "│   "));
		} else if (name === "taste.md") {
			let content = "";
			try {
				content = await readFile(full, "utf8");
			} catch {}
			out += `${prefix}${connector}${name} (${countLearnings(content)} learnings)\n`;
		} else {
			out += `${prefix}${connector}${name}\n`;
		}
	}
	return out;
}

export async function loadPreferences(paths: StorePaths): Promise<Preference[]> {
	try {
		const content = await readFile(paths.taste, "utf8");
		return parseLearnings(content, paths.scope);
	} catch {
		return [];
	}
}

export async function loadIncludeGlobalTaste(paths: StorePaths): Promise<boolean> {
	// v3: no per-project frontmatter switch; Global injection is controlled by config in index.ts.
	// Kept for API compatibility with commands; always true.
	return true;
}

export async function savePreferencesUnlocked(paths: StorePaths, preferences: Preference[]): Promise<void> {
	await ensureProjectStore(paths);
	await atomicWrite(paths.taste, renderTasteMarkdown(preferences, paths.scope));
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
// Taste file tools (Command Code 1:1)
// ---------------------------------------------------------------------------

/**
 * Resolve a model-supplied path inside the taste directory. Root file is
 * "taste.md"; category is "{category}/taste.md". No other paths allowed.
 */
export function resolveTastePath(paths: StorePaths, relative: string): { absolute: string; segments: string[] } | null {
	const trimmed = relative.trim();
	if (!trimmed || trimmed.startsWith("/") || /^[A-Za-z]:\\?/.test(trimmed)) return null;
	const segments: string[] = [];
	for (const part of trimmed.replace(/^[/\\]+/, "").split(/[/\\]+/)) {
		if (part === "" || part === ".") continue;
		if (part === "..") return null;
		segments.push(part);
	}
	if (segments.length === 0) return null;
	return { absolute: join(paths.dir, ...segments), segments };
}

function isSafeCategorySegment(value: string): boolean {
	if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u.test(value) || value.endsWith(".")) return false;
	return !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(value);
}

function categorySlug(name: string): string {
	let slug = name
		.normalize("NFKC")
		.toLocaleLowerCase()
		.replace(/[^\p{L}\p{N}._-]+/gu, "-")
		.replace(/^[._-]+|[._-]+$/g, "")
		.slice(0, 64)
		.replace(/[._-]+$/g, "");
	if (!isSafeCategorySegment(slug)) {
		slug = `category-${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
	}
	return slug;
}

export function isValidTasteFilePath(segments: string[]): boolean {
	return segments.length === 1 && segments[0] === "taste.md"
		? true
		: segments.length === 2 && isSafeCategorySegment(segments[0]) && segments[1] === "taste.md";
}

/** Command Code reorganizeIfNeeded: category with >5 learnings becomes its own folder. */
export async function reorganizeIfNeeded(paths: StorePaths): Promise<Array<{ category: string; moved: number }>> {
	const root = paths.taste;
	if (!(await exists(root))) return [];
	const content = await readFile(root, "utf8");
	const categories = parseCategories(content).filter((category) => category.learningCount > 5);
	const moved: Array<{ category: string; moved: number }> = [];
	if (categories.length === 0) return [];
	let updated = content;
	for (const category of categories) {
		const slug = categorySlug(category.name);
		await mkdir(join(paths.dir, slug), { recursive: true, mode: 0o700 });
		await atomicWrite(join(paths.dir, slug, "taste.md"), `# ${category.name}\n${category.learnings.join("\n")}\n`);
		const replacement = `# ${category.name}\nSee [${slug}/taste.md](${slug}/taste.md)\n`;
		updated = updated.replace(category.fullSection, replacement);
		moved.push({ category: category.name, moved: category.learningCount });
	}
	await atomicWrite(paths.taste, updated);
	return moved;
}

function parseCategories(content: string): Array<{ name: string; learningCount: number; learnings: string[]; fullSection: string }> {
	const result: Array<{ name: string; learningCount: number; learnings: string[]; fullSection: string }> = [];
	// Only explicit level-one headings define categories. Unheaded root bullets
	// are valid Taste entries and must never be interpreted as a directory name.
	const headings = [...content.matchAll(/^# ([^\r\n]+)[^\S\r\n]*(?:\r?\n|$)/gm)];
	for (let index = 0; index < headings.length; index++) {
		const match = headings[index];
		const start = match.index ?? 0;
		const end = headings[index + 1]?.index ?? content.length;
		const fullSection = content.slice(start, end);
		const body = fullSection.slice(match[0].length);
		const name = match[1].trim();
		if (!name || body.includes("See [")) continue;
		const learnings = body
			.split(/\r?\n/)
			.filter((line) => line.trim().startsWith("- ") && line.includes("Confidence:"));
		if (learnings.length > 0) {
			result.push({ name, learningCount: learnings.length, learnings, fullSection });
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Command Code read-only compatibility (v3: no import; direct read for injection)
// ---------------------------------------------------------------------------

export async function loadCommandCodeTaste(projectRoot?: string): Promise<ImportedTaste[]> {
	const sources: Array<{ base: string; scope: TasteScope }> = [
		{ base: join(homedir(), ".commandcode", "taste"), scope: "global" },
	];
	if (projectRoot) sources.push({ base: join(projectRoot, ".commandcode", "taste"), scope: "project" });
	const imported: ImportedTaste[] = [];
	const seen = new Set<string>();
	for (const source of sources) {
		for (const path of await commandCodePackageFiles(source.base)) {
			try {
				const content = await readFile(path, "utf8");
				for (const item of parseLearnings(content, source.scope)) {
					const key = `${source.scope}:${item.statement.toLocaleLowerCase()}`;
					if (!seen.has(key)) {
						seen.add(key);
						imported.push({ scope: source.scope, statement: item.statement, sourcePath: path });
					}
				}
			} catch {}
		}
	}
	return imported;
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
	} catch {}
	return files;
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

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
