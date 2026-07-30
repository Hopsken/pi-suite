import { randomUUID } from "node:crypto";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { compact, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { installAgentPresets } from "./agent-presets.ts";
import { registerAvailableCliToolsPrompt } from "./available-cli-tools.ts";
import { type ModelChoice, ModelSelector } from "./model-selector.ts";
import { registerSessionHistoryTools } from "./session-history-tools.ts";
import {
	type CompactionModelSelection,
	includePreviousFileOperations,
	loadCompactionModelSelection,
	loadSessionReadModelSelection,
	type SessionReadModelSelection,
	saveCompactionModelSelection,
	saveSessionReadModelSelection,
} from "./state.ts";
import { registerToolsSelector } from "./tools-selector.ts";

export const ORACLE_FINDER_TOOL_NAME = "oracle_finder";
export const ORACLE_LIBRARIAN_TOOL_NAME = "oracle_librarian";

const ORACLE_ACTIVE_AGENT_TAG = '<active_agent name="Oracle"/>';
const SUBAGENT_RPC_TIMEOUT_MS = 5_000;

type SubagentEvent = {
	id: string;
	result?: string;
	error?: string;
	status?: string;
	toolUses?: number;
	durationMs?: number;
	tokens?: { input: number; output: number; total: number };
};

type SubagentRpcReply = { success: true; data?: { id?: unknown } } | { success: false; error?: unknown };

function asSubagentEvent(value: unknown): SubagentEvent | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const event = value as Record<string, unknown>;
	if (typeof event.id !== "string") return undefined;
	return event as SubagentEvent;
}

function errorMessage(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

function runOracleSubagentResearch(
	pi: ExtensionAPI,
	params: { prompt: string; description: string },
	signal: AbortSignal | undefined,
	type: "Explore" | "Librarian",
): Promise<{
	content: [{ type: "text"; text: string }];
	details: Omit<SubagentEvent, "result" | "error">;
}> {
	return new Promise((resolve, reject) => {
		const requestId = randomUUID();
		const replyChannel = `subagents:rpc:spawn:reply:${requestId}`;
		const pendingTerminalEvents = new Map<string, { event: SubagentEvent; failed: boolean }>();
		let agentId: string | undefined;
		let aborted = signal?.aborted ?? false;
		let settled = false;
		let replyTimer: ReturnType<typeof setTimeout>;

		let unsubscribeReply = () => {};
		const unsubscribeCompleted = pi.events.on("subagents:completed", (value) => {
			handleTerminalEvent(value, false);
		});
		const unsubscribeFailed = pi.events.on("subagents:failed", (value) => {
			handleTerminalEvent(value, true);
		});

		const cleanup = () => {
			clearTimeout(replyTimer);
			unsubscribeReply();
			unsubscribeCompleted();
			unsubscribeFailed();
			signal?.removeEventListener("abort", onAbort);
		};

		const finish = (event: SubagentEvent, failed: boolean) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (failed) {
				reject(new Error(event.error || `Research subagent stopped with status ${event.status ?? "unknown"}.`));
				return;
			}
			resolve({
				content: [{ type: "text", text: event.result?.trim() || "Research subagent returned no output." }],
				details: {
					id: event.id,
					status: event.status,
					toolUses: event.toolUses,
					durationMs: event.durationMs,
					tokens: event.tokens,
				},
			});
		};

		function handleTerminalEvent(value: unknown, failed: boolean): void {
			const event = asSubagentEvent(value);
			if (!event) return;
			if (!agentId) {
				pendingTerminalEvents.set(event.id, { event, failed });
				return;
			}
			if (event.id === agentId) finish(event, failed);
		}

		const stopAgent = (id: string) => {
			pi.events.emit("subagents:rpc:stop", { requestId: randomUUID(), agentId: id });
		};

		function onAbort(): void {
			aborted = true;
			if (!agentId) return;
			stopAgent(agentId);
			if (!settled) {
				settled = true;
				cleanup();
				reject(signal?.reason ?? new Error("Oracle research was cancelled."));
			}
		}

		unsubscribeReply = pi.events.on(replyChannel, (value) => {
			const reply = value as SubagentRpcReply;
			if (!reply || reply.success !== true) {
				if (!settled) {
					settled = true;
					cleanup();
					reject(
						new Error(`Could not start the research subagent: ${errorMessage(reply?.error ?? "unknown error")}`),
					);
				}
				return;
			}

			const id = reply.data?.id;
			if (typeof id !== "string") {
				if (!settled) {
					settled = true;
					cleanup();
					reject(new Error("Could not start the research subagent: the RPC response contained no agent ID."));
				}
				return;
			}

			agentId = id;
			clearTimeout(replyTimer);
			unsubscribeReply();
			if (aborted) {
				stopAgent(id);
				if (!settled) {
					settled = true;
					cleanup();
					reject(signal?.reason ?? new Error("Oracle research was cancelled."));
				}
				return;
			}

			const terminal = pendingTerminalEvents.get(id);
			if (terminal) finish(terminal.event, terminal.failed);
		});

		replyTimer = setTimeout(() => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(
				aborted
					? (signal?.reason ?? new Error("Oracle research was cancelled."))
					: new Error("Could not start the research subagent: pi-subagents did not answer the spawn request."),
			);
		}, SUBAGENT_RPC_TIMEOUT_MS);

		signal?.addEventListener("abort", onAbort, { once: true });
		pi.events.emit("subagents:rpc:spawn", {
			requestId,
			type,
			prompt: params.prompt,
			options: {
				description: params.description,
				isBackground: false,
				inheritContext: false,
			},
		});
	});
}

function runOracleFinder(
	pi: ExtensionAPI,
	params: { prompt: string; description: string },
	signal: AbortSignal | undefined,
) {
	return runOracleSubagentResearch(pi, params, signal, "Explore");
}

function runOracleLibrarian(
	pi: ExtensionAPI,
	params: { prompt: string; description: string },
	signal: AbortSignal | undefined,
) {
	return runOracleSubagentResearch(pi, params, signal, "Librarian");
}

function registerOracleFinderTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: ORACLE_FINDER_TOOL_NAME,
		label: "Oracle Finder",
		description:
			"Delegate one focused, read-only local codebase discovery question to the Explore subagent and wait for its distilled findings. Intended for Oracle when multi-step workspace research would otherwise consume its advisory context. Do not delegate external repository research, implementation, final judgment, or another Oracle review.",
		parameters: Type.Object({
			prompt: Type.String({
				description:
					"A self-contained engineering discovery request with concrete success criteria, likely directories or artifacts, and the evidence to return.",
			}),
			description: Type.String({
				description: "A short 3-5 word description of the research task.",
			}),
		}),
		execute: async (_toolCallId, params, signal) => runOracleFinder(pi, params, signal),
	});
}

function registerOracleLibrarianTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: ORACLE_LIBRARIAN_TOOL_NAME,
		label: "Oracle Librarian",
		description:
			"Delegate one focused, read-only external source-code research question to the Librarian subagent and wait for its evidence-backed answer. Intended for Oracle when authoritative dependency or remote-repository research would otherwise consume its advisory context. Do not delegate local workspace discovery, implementation, or final judgment.",
		parameters: Type.Object({
			prompt: Type.String({
				description:
					"A self-contained external codebase research request naming the repository or project when known, the relevant ref or version, the exact question, and the evidence or immutable source links to return.",
			}),
			description: Type.String({
				description: "A short 3-5 word description of the external research task.",
			}),
		}),
		execute: async (_toolCallId, params, signal) => runOracleLibrarian(pi, params, signal),
	});
}

function modelLabel(model: { provider: string; id: string; name: string }): string {
	return `${model.provider}/${model.id} — ${model.name}`;
}

function warn(ctx: ExtensionContext, message: string): void {
	const text = `${message} Using the active session model.`;
	if (ctx.hasUI) {
		ctx.ui.notify(text, "warning");
	} else {
		console.warn(`[pi-suite] ${text}`);
	}
}

function warnUnavailable(ctx: ExtensionContext, message: string): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, "warning");
	} else {
		console.warn(`[pi-suite] ${message}`);
	}
}

/** Registers Pi Suite's integrated workflows. */
export default function piSuite(pi: ExtensionAPI): void {
	let selection: CompactionModelSelection | undefined;
	let sessionReadSelection: SessionReadModelSelection | undefined;
	let sessionReadSelectionError: string | undefined;
	let completedCustomCompaction:
		| {
				summary: string;
				message: string;
		  }
		| undefined;

	try {
		selection = loadCompactionModelSelection();
	} catch {
		selection = undefined;
	}
	try {
		sessionReadSelection = loadSessionReadModelSelection();
	} catch (error) {
		sessionReadSelection = undefined;
		sessionReadSelectionError = error instanceof Error ? error.message : String(error);
	}

	registerSessionHistoryTools(pi, () => {
		if (sessionReadSelectionError)
			throw new Error(`Could not load the session reader model setting: ${sessionReadSelectionError}`);
		return sessionReadSelection;
	});

	const reloadSelections = (ctx: ExtensionContext): void => {
		try {
			selection = loadCompactionModelSelection();
		} catch (error) {
			selection = undefined;
			const reason = error instanceof Error ? error.message : String(error);
			warn(ctx, `Could not load the compaction model setting: ${reason}`);
		}
		try {
			sessionReadSelection = loadSessionReadModelSelection();
			sessionReadSelectionError = undefined;
		} catch (error) {
			sessionReadSelection = undefined;
			sessionReadSelectionError = error instanceof Error ? error.message : String(error);
			warnUnavailable(
				ctx,
				`Could not load the session reader model setting: ${sessionReadSelectionError}. session_read is unavailable until the setting is fixed or reset.`,
			);
		}
	};

	pi.on("session_start", (_event, ctx) => {
		completedCustomCompaction = undefined;
		if (ctx.getSystemPrompt().startsWith(ORACLE_ACTIVE_AGENT_TAG)) {
			registerOracleFinderTool(pi);
			registerOracleLibrarianTool(pi);
		}
		reloadSelections(ctx);
		if (ctx.mode !== "tui") return;

		if (selection) {
			ctx.ui.notify(
				`Compaction model: ${selection.provider}/${selection.modelId} (${selection.thinkingLevel} thinking).`,
				"info",
			);
		} else {
			const activeModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "not selected";
			ctx.ui.notify(`Compaction model: ${activeModel} (active session model).`, "info");
		}

		if (sessionReadSelectionError) {
			// reloadSelections already reported the invalid setting and fail-closed behavior.
		} else if (sessionReadSelection) {
			ctx.ui.notify(
				`Session reader model: ${sessionReadSelection.provider}/${sessionReadSelection.modelId} (${sessionReadSelection.thinkingLevel} thinking).`,
				"info",
			);
		} else {
			const activeModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "not selected";
			ctx.ui.notify(`Session reader model: ${activeModel} (active session model).`, "info");
		}
	});

	pi.registerCommand("compaction-model", {
		description: "Select the model and thinking level used for session compaction",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("The compaction model picker requires interactive mode.", "warning");
				return;
			}

			const models = [...ctx.modelRegistry.getAvailable()].sort((left, right) => {
				const leftSelected = left.provider === selection?.provider && left.id === selection.modelId;
				const rightSelected = right.provider === selection?.provider && right.id === selection.modelId;
				if (leftSelected !== rightSelected) return leftSelected ? -1 : 1;
				return modelLabel(left).localeCompare(modelLabel(right));
			});

			const choice = await ctx.ui.custom<ModelChoice>(
				(tui, theme, _keybindings, done) =>
					new ModelSelector(tui, theme, models, done, {
						title: "Select Compaction Model",
						activeDescription: "Follow the conversation model in each session",
					}),
			);
			if (!choice) return;

			if (choice.type === "active") {
				try {
					saveCompactionModelSelection(undefined);
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Could not save the compaction model setting: ${reason}`, "error");
					return;
				}
				selection = undefined;
				ctx.ui.notify("Compaction will use the active session model.", "info");
				return;
			}

			const model = choice.model;

			const supportedLevels = getSupportedThinkingLevels(model);
			const chosenLevel = await ctx.ui.select("Compaction thinking level", supportedLevels);
			const thinkingLevel = supportedLevels.find((level) => level === chosenLevel);
			if (!thinkingLevel) return;

			const nextSelection: CompactionModelSelection = {
				provider: model.provider,
				modelId: model.id,
				thinkingLevel,
			};
			try {
				saveCompactionModelSelection(nextSelection);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not save the compaction model setting: ${reason}`, "error");
				return;
			}
			selection = nextSelection;
			ctx.ui.notify(`Compaction will use ${model.provider}/${model.id} with ${thinkingLevel} thinking.`, "info");
		},
	});

	pi.registerCommand("session-read-model", {
		description: "Select the model and thinking level used to read historical sessions",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("The session reader model picker requires interactive mode.", "warning");
				return;
			}

			const models = [...ctx.modelRegistry.getAvailable()].sort((left, right) => {
				const leftSelected =
					left.provider === sessionReadSelection?.provider && left.id === sessionReadSelection.modelId;
				const rightSelected =
					right.provider === sessionReadSelection?.provider && right.id === sessionReadSelection.modelId;
				if (leftSelected !== rightSelected) return leftSelected ? -1 : 1;
				return modelLabel(left).localeCompare(modelLabel(right));
			});

			const choice = await ctx.ui.custom<ModelChoice>(
				(tui, theme, _keybindings, done) =>
					new ModelSelector(tui, theme, models, done, {
						title: "Select Session Reader Model",
						activeDescription: "Use each invoking session's active model",
					}),
			);
			if (!choice) return;

			if (choice.type === "active") {
				try {
					saveSessionReadModelSelection(undefined);
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Could not save the session reader model setting: ${reason}`, "error");
					return;
				}
				sessionReadSelection = undefined;
				sessionReadSelectionError = undefined;
				ctx.ui.notify("Historical session reading will use the active session model.", "info");
				return;
			}

			const model = choice.model;
			const supportedLevels = getSupportedThinkingLevels(model);
			const chosenLevel = await ctx.ui.select("Session reader thinking level", supportedLevels);
			const thinkingLevel = supportedLevels.find((level) => level === chosenLevel);
			if (!thinkingLevel) return;

			const nextSelection: SessionReadModelSelection = {
				provider: model.provider,
				modelId: model.id,
				thinkingLevel,
			};
			try {
				saveSessionReadModelSelection(nextSelection);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not save the session reader model setting: ${reason}`, "error");
				return;
			}
			sessionReadSelection = nextSelection;
			sessionReadSelectionError = undefined;
			ctx.ui.notify(
				`Historical session reading will use ${model.provider}/${model.id} with ${thinkingLevel} thinking.`,
				"info",
			);
		},
	});

	pi.registerCommand("setup-agents", {
		description: "Install Pi Suite's preset subagents globally",
		handler: async (_args, ctx) => {
			try {
				const result = installAgentPresets();
				const installed =
					result.installed.length > 0
						? `Installed ${result.installed.length} preset${result.installed.length === 1 ? "" : "s"}.`
						: "All presets were already installed.";
				const skipped =
					result.skipped.length > 0
						? ` Left ${result.skipped.length} existing ${result.skipped.length === 1 ? "definition" : "definitions"} unchanged.`
						: "";
				ctx.ui.notify(
					`${installed}${skipped} Upstream default agents are disabled globally. Run /reload to use the presets.`,
					"info",
				);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not install Pi Suite agent presets: ${reason}`, "error");
			}
		},
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const currentSelection = selection;
		if (!currentSelection) return;

		const model = ctx.modelRegistry.find(currentSelection.provider, currentSelection.modelId);
		if (!model) {
			warn(ctx, `Compaction model ${currentSelection.provider}/${currentSelection.modelId} was not found.`);
			return;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			warn(
				ctx,
				`Authentication failed for ${currentSelection.provider}/${currentSelection.modelId}: ${auth.error}.`,
			);
			return;
		}

		try {
			const preparation = includePreviousFileOperations(event.preparation, event.branchEntries);
			const thinkingLevel = clampThinkingLevel(model, currentSelection.thinkingLevel);
			const result = await compact(
				preparation,
				model,
				auth.apiKey,
				auth.headers,
				event.customInstructions,
				event.signal,
				thinkingLevel,
				undefined,
				auth.env,
			);

			completedCustomCompaction = {
				summary: result.summary,
				message: `Compacted session with ${model.provider}/${model.id} (${thinkingLevel} thinking).`,
			};
			return { compaction: result };
		} catch (error) {
			if (!event.signal.aborted) {
				const reason = error instanceof Error ? error.message : String(error);
				warn(ctx, `Compaction with ${currentSelection.provider}/${currentSelection.modelId} failed: ${reason}.`);
			}
			return;
		}
	});

	pi.on("session_compact", (event, ctx) => {
		const completed = completedCustomCompaction;
		completedCustomCompaction = undefined;
		if (!completed || !event.fromExtension || event.compactionEntry.summary !== completed.summary) return;
		if (ctx.mode !== "tui") return;

		// Pi emits session_compact before compaction_end. The TUI handles
		// compaction_end by rebuilding the chat, which would erase a notification
		// shown synchronously here.
		setTimeout(() => ctx.ui.notify(completed.message, "info"), 0);
	});

	registerAvailableCliToolsPrompt(pi);

	// Register last so session-scoped tools, such as Oracle's research tools,
	// exist before a saved active-tool selection is restored.
	registerToolsSelector(pi);
}

export { SESSION_READ_TOOL_NAME, SESSION_SEARCH_TOOL_NAME } from "./session-history-tools.ts";
export {
	type CompactionModelSelection,
	includePreviousFileOperations,
	loadCompactionModelSelection,
	loadSessionReadModelSelection,
	PI_SUITE_SETTINGS_KEY,
	type SessionReadModelSelection,
	saveCompactionModelSelection,
	saveSessionReadModelSelection,
} from "./state.ts";
