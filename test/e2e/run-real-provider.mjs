import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const modelRef = process.env.PI_TASTE_E2E_MODEL?.trim();
if (!modelRef?.includes("/")) {
	throw new Error("Set PI_TASTE_E2E_MODEL=provider/model before running the credential-gated E2E test.");
}
const slash = modelRef.indexOf("/");
const provider = modelRef.slice(0, slash);
const model = modelRef.slice(slash + 1);
const piBin = process.env.PI_BIN?.trim() || (process.platform === "win32" ? "pi.cmd" : "pi");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const root = mkdtempSync(join(tmpdir(), "pi-taste-real-e2e-"));
const marker = `TASTE_E2E_${Date.now().toString(36).toUpperCase()}`;
const projectTasteDir = join(root, ".pi", "taste");
const sessionDir = join(root, "sessions");
const globalTasteDir = join(root, "global-taste");
mkdirSync(projectTasteDir, { recursive: true });
writeFileSync(
	join(projectTasteDir, "taste.md"),
	Array.from({ length: 7 }, (_, index) => `- Existing project preference ${index + 1}. Confidence: 1.0`).join("\n") + "\n",
);

const commonArgs = [
	"--provider", provider,
	"--model", model,
	"--no-extensions",
	"-e", join(repoRoot, "index.ts"),
	"--no-skills",
	"--no-prompt-templates",
	"--no-context-files",
	"--session-dir", sessionDir,
	"-p",
];
const env = { ...process.env, PI_TASTE_DIR: globalTasteDir };
function run(prompt) {
	return execFileSync(piBin, [...commonArgs, prompt], {
		cwd: root,
		env,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		shell: process.platform === "win32",
		timeout: 300_000,
	});
}

let passed = false;
try {
	run(`Persistent project preference: Every compatibility report must begin with the exact marker ${marker}. Remember this for future turns. Reply only acknowledged.`);
	const entries = readdirSync(projectTasteDir, { withFileTypes: true });
	const categoryDirs = entries.filter((entry) => entry.isDirectory());
	for (const entry of categoryDirs) {
		assert.match(entry.name, /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u);
		assert.doesNotMatch(entry.name, /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i);
	}
	const tasteFiles = [
		join(projectTasteDir, "taste.md"),
		...categoryDirs.map((entry) => join(projectTasteDir, entry.name, "taste.md")),
	];
	const completeTaste = tasteFiles.map((path) => readFileSync(path, "utf8")).join("\n");
	assert.match(completeTaste, new RegExp(marker));
	const second = run("What exact marker does the persistent project preference require at the beginning of every compatibility report? Reply with only that marker.");
	assert.match(second, new RegExp(marker));
	passed = true;
	console.log(`PASS real-provider Taste E2E (${provider}/${model}, marker ${marker})`);
} finally {
	if (passed || process.env.PI_TASTE_E2E_KEEP !== "1") rmSync(root, { recursive: true, force: true });
	else console.error(`E2E artifacts preserved at ${root}`);
}
