import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { normalizePreferenceKey, redactSensitive } from "./storage.ts";

const MAX_IMPORT_BYTES = 256_000;
const MAX_IMPORT_ITEMS = 100;
const MAX_STATEMENT_CHARS = 500;

export interface TasteImportPreview {
	sourcePath: string;
	statements: string[];
	skipped: number;
}

function expandPath(input: string, cwd: string): string {
	const trimmed = input.trim().replace(/^(["'])(.*)\1$/, "$2");
	if (!trimmed) throw new Error("Taste import requires a Markdown file path.");
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
	return isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
}

function cleanImportedStatement(input: string): string {
	return input
		.trim()
		.replace(/^[-*]\s+/, "")
		.replace(/\s+Confidence:\s*(?:0(?:\.\d+)?|1(?:\.0+)?)\s*\.?\s*$/i, "")
		.replace(/\s+/g, " ")
		.trim();
}

function parseMarkdown(content: string): { statements: string[]; skipped: number } {
	const lines = content.split(/\r?\n/);
	const bullets = lines.filter((line) => /^\s*[-*]\s+\S/.test(line));
	const candidates = bullets.length > 0
		? bullets
		: lines.filter((line) => {
				const trimmed = line.trim();
				return Boolean(trimmed) && !trimmed.startsWith("#") && !trimmed.startsWith("<!--") && !trimmed.startsWith(">");
			});
	const statements: string[] = [];
	const seen = new Set<string>();
	let skipped = lines.length - candidates.length;
	for (const candidate of candidates) {
		const statement = cleanImportedStatement(candidate);
		const key = normalizePreferenceKey(statement);
		if (
			statement.length < 4 ||
			statement.length > MAX_STATEMENT_CHARS ||
			!key ||
			seen.has(key) ||
			redactSensitive(statement) !== statement
		) {
			skipped += 1;
			continue;
		}
		seen.add(key);
		statements.push(statement);
		if (statements.length > MAX_IMPORT_ITEMS) {
			throw new Error(`Taste import contains more than ${MAX_IMPORT_ITEMS} valid preferences.`);
		}
	}
	if (statements.length === 0) throw new Error("No importable Taste preferences were found.");
	return { statements, skipped };
}

export async function readTasteImport(pathInput: string, cwd: string): Promise<TasteImportPreview> {
	const sourcePath = expandPath(pathInput, cwd);
	const info = await stat(sourcePath);
	if (!info.isFile()) throw new Error(`Taste import source is not a file: ${sourcePath}`);
	if (info.size > MAX_IMPORT_BYTES) {
		throw new Error(`Taste import file is too large (${info.size} bytes; maximum ${MAX_IMPORT_BYTES}).`);
	}
	const parsed = parseMarkdown(await readFile(sourcePath, "utf8"));
	return { sourcePath, ...parsed };
}
