import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface TasteFooterState {
	learningEnabled: boolean;
	injectionEnabled: boolean;
	queuedJobs: number;
	hasError: boolean;
	model?: { provider: string; id: string; reasoning: boolean };
	thinkingLevel?: string;
}

function formatTokens(count: number): string {
	if (count < 1_000) return count.toString();
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function formatCwd(cwd: string): string {
	const home = homedir();
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const inside =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	return inside ? (relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`) : cwd;
}

function sanitizeStatus(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

export function installTasteFooter(
	ctx: ExtensionContext,
	getState: () => TasteFooterState,
	onRenderReady: (requestRender: () => void) => void,
): void {
	if (ctx.mode !== "tui") return;
	ctx.ui.setFooter((tui, theme, footerData) => {
		onRenderReady(() => tui.requestRender());
		const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
		return {
			dispose: unsubscribe,
			invalidate() {},
			render(width: number): string[] {
				const state = getState();
				let input = 0;
				let output = 0;
				let cacheRead = 0;
				let cacheWrite = 0;
				let cost = 0;
				let latestCacheHitRate: number | undefined;
				for (const entry of ctx.sessionManager.getEntries() as any[]) {
					const usage =
						entry?.type === "message" && (entry.message?.role === "assistant" || entry.message?.role === "toolResult")
							? entry.message.usage
							: entry?.type === "branch_summary" || entry?.type === "compaction"
								? entry.usage
								: undefined;
					if (!usage) continue;
					input += usage.input || 0;
					output += usage.output || 0;
					cacheRead += usage.cacheRead || 0;
					cacheWrite += usage.cacheWrite || 0;
					cost += usage.cost?.total || 0;
					if (entry?.type === "message" && entry.message?.role === "assistant") {
						const promptTokens = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
						latestCacheHitRate = promptTokens > 0 ? ((usage.cacheRead || 0) / promptTokens) * 100 : undefined;
					}
				}

				const usage = ctx.getContextUsage();
				const contextWindow = usage?.contextWindow ?? 0;
				const contextValue = usage?.percent ?? 0;
				const contextDisplay =
					usage?.percent === null || usage?.percent === undefined
						? `?/${formatTokens(contextWindow)}`
						: `${contextValue.toFixed(1)}%/${formatTokens(contextWindow)}`;
				const contextText =
					contextValue > 90
						? theme.fg("error", contextDisplay)
						: contextValue > 70
							? theme.fg("warning", contextDisplay)
							: contextDisplay;

				const stats: string[] = [];
				if (input) stats.push(`↑${formatTokens(input)}`);
				if (output) stats.push(`↓${formatTokens(output)}`);
				if (cacheRead) stats.push(`R${formatTokens(cacheRead)}`);
				if (cacheWrite) stats.push(`W${formatTokens(cacheWrite)}`);
				if ((cacheRead || cacheWrite) && latestCacheHitRate !== undefined) {
					stats.push(`CH${latestCacheHitRate.toFixed(1)}%`);
				}
				if (cost) stats.push(`$${cost.toFixed(3)}`);
				stats.push(contextText);

				let tasteLabel = state.learningEnabled ? "Taste:on" : "Taste:off";
				if (!state.injectionEnabled) tasteLabel += "/inject-off";
				if (state.queuedJobs > 0) tasteLabel += `·${state.queuedJobs}`;
				if (state.learningEnabled && state.hasError) tasteLabel += "!";
				stats.push(
					state.hasError
						? theme.fg("error", tasteLabel)
						: state.learningEnabled
							? theme.fg("success", tasteLabel)
							: theme.fg("dim", tasteLabel),
				);

				let left = stats.join(" ");
				if (visibleWidth(left) > width) left = truncateToWidth(left, width, "...");
				const model = state.model;
				let right = model?.id ?? "no-model";
				if (model?.reasoning) right += ` • ${state.thinkingLevel ?? "off"}`;
				if (model && footerData.getAvailableProviderCount() > 1) {
					const withProvider = `(${model.provider}) ${right}`;
					if (visibleWidth(left) + 2 + visibleWidth(withProvider) <= width) right = withProvider;
				}
				const availableRight = width - visibleWidth(left) - 2;
				let statsLine = left;
				if (availableRight > 0) {
					right = truncateToWidth(right, availableRight, "");
					statsLine = left + " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right))) + right;
				}

				let cwd = formatCwd(ctx.sessionManager.getCwd());
				const branch = footerData.getGitBranch();
				if (branch) cwd += ` (${branch})`;
				const name = ctx.sessionManager.getSessionName();
				if (name) cwd += ` • ${name}`;
				const lines = [
					truncateToWidth(theme.fg("dim", cwd), width, theme.fg("dim", "...")),
					theme.fg("dim", statsLine),
				];

				const otherStatuses = Array.from(footerData.getExtensionStatuses().entries())
					.filter(([key]) => key !== "taste")
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([, text]) => sanitizeStatus(text));
				if (otherStatuses.length > 0) {
					lines.push(truncateToWidth(otherStatuses.join(" "), width, theme.fg("dim", "...")));
				}
				return lines;
			},
		};
	});
}
