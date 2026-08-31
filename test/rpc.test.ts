import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import test from "node:test";

test("non-Git workspaces default to Global injection and learning and can disable it", { timeout: 30_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-taste-rpc-"));
	const workspace = join(root, "workspace");
	const globalStore = join(root, "global");
	await mkdir(workspace);
	const piBin = resolve("node_modules/.bin/pi");
	const child = spawn(
		piBin,
		["--mode", "rpc", "--no-session", "--offline", "-ne", "-e", resolve("index.ts")],
		{
			cwd: workspace,
			env: { ...process.env, PI_TASTE_DIR: globalStore },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	const lines = createInterface({ input: child.stdout });
	const pending = new Map<string, { resolve: (notes: string[]) => void; notes: string[] }>();
	let stderr = "";
	child.stderr.on("data", (chunk) => { stderr += String(chunk); });
	lines.on("line", (line) => {
		const event = JSON.parse(line) as Record<string, any>;
		if (event.type === "extension_ui_request" && event.method === "notify") {
			for (const request of pending.values()) request.notes.push(String(event.message));
		}
		if (event.type === "response" && typeof event.id === "string") {
			const request = pending.get(event.id);
			if (request && event.success) {
				pending.delete(event.id);
				request.resolve(request.notes);
			}
		}
	});
	let sequence = 0;
	const command = (message: string): Promise<string[]> => {
		const id = `command-${++sequence}`;
		return new Promise((resolveCommand) => {
			pending.set(id, { resolve: resolveCommand, notes: [] });
			child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
		});
	};
	try {
		await command("/taste remember -g Keep global responses concise.");
		await command("/taste remember Keep this workspace project-only.");
		const [defaultStatus] = await command("/taste status");
		assert.match(defaultStatus, /Taste: on \(automatic learning \+ injection\)/);
		assert.match(defaultStatus, /Global Taste in this project: on \(injection \+ automatic learning\)/);
		assert.match(defaultStatus, /Injection snapshot: \S+ \(2 entries,/);
		await command("/taste global off");
		const [disabledStatus] = await command("/taste status");
		assert.match(disabledStatus, /Global Taste in this project: off \(project-only injection \+ learning\)/);
		assert.match(disabledStatus, /Injection snapshot: \S+ \(1 entries,/);
		await command("/taste off");
		const [offStatus] = await command("/taste status");
		assert.match(offStatus, /Taste: off \(automatic learning \+ injection disabled\)/);
		assert.match(offStatus, /Global Taste in this project: off \(inactive while Taste is off\)/);
		assert.match(offStatus, /Injection snapshot: off \(0 entries, 0 bytes\)/);
		await command("/taste on");
		const [restoredStatus] = await command("/taste status");
		assert.match(restoredStatus, /Taste: on \(automatic learning \+ injection\)/);
		assert.match(restoredStatus, /Injection snapshot: \S+ \(1 entries,/);
		const projectRoot = join(workspace, ".pi", "taste");
		const projectTaste = await readFile(join(projectRoot, "taste.md"), "utf8");
		assert.match(projectTaste, /Keep this workspace project-only\./);
		assert.match(projectTaste, /includeGlobalTaste: false/);
	} finally {
		child.stdin.end();
		const exitCode = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
		lines.close();
		await rm(root, { recursive: true, force: true });
		assert.equal(exitCode, 0, stderr);
	}
});
