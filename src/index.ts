import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { compact, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installAgentPresets, updateAgentPresets } from "./agent-presets.ts";
import { registerAvailableCliToolsPrompt } from "./available-cli-tools.ts";
import { type ModelChoice, ModelSelector } from "./model-selector.ts";
import { registerSessionHistoryTools } from "./session-history-tools.ts";
import { generateSessionTitle } from "./session-title.ts";
import {
	type CompactionModelSelection,
	includePreviousFileOperations,
	loadCompactionModelSelection,
	loadSessionReadModelSelection,
	loadSessionTitleModelSelection,
	type SessionReadModelSelection,
	type SessionTitleModelSelection,
	saveCompactionModelSelection,
	saveSessionReadModelSelection,
	saveSessionTitleModelSelection,
} from "./state.ts";
import { registerToolDisplay } from "./tool-display.ts";
import { registerToolsSelector } from "./tools-selector.ts";

function errorMessage(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
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
	registerToolDisplay(pi);
	// The package loads Suite before Subagents, which reads presets during activation.
	let presetUpdateNotice: string | undefined;
	let presetUpdateFailed = false;
	try {
		const { updated } = updateAgentPresets();
		if (updated.length > 0)
			presetUpdateNotice = `Updated Suite presets: ${updated.join(", ")}. Previous files are in pi-suite-agent-backups in your Pi agent directory.`;
	} catch (error) {
		presetUpdateFailed = true;
		presetUpdateNotice = `Could not update Suite agent presets: ${errorMessage(error)}`;
	}
	let selection: CompactionModelSelection | undefined;
	let sessionReadSelection: SessionReadModelSelection | undefined;
	let sessionTitleSelection: SessionTitleModelSelection | undefined;
	let attemptedSessionTitle = false;
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
	try {
		sessionTitleSelection = loadSessionTitleModelSelection();
	} catch {
		sessionTitleSelection = undefined;
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
		try {
			sessionTitleSelection = loadSessionTitleModelSelection();
		} catch (error) {
			sessionTitleSelection = undefined;
			const reason = error instanceof Error ? error.message : String(error);
			warn(ctx, `Could not load the session title model setting: ${reason}`);
		}
	};

	pi.on("session_start", (_event, ctx) => {
		if (presetUpdateNotice) {
			if (presetUpdateFailed) warnUnavailable(ctx, presetUpdateNotice);
			else if (ctx.hasUI) ctx.ui.notify(presetUpdateNotice, "info");
			presetUpdateNotice = undefined;
		}
		completedCustomCompaction = undefined;
		attemptedSessionTitle = ctx.sessionManager
			.getBranch()
			.some((entry) => entry.type === "message" && entry.message.role === "assistant");
		reloadSelections(ctx);
		if (ctx.mode !== "tui") return;

		if (selection) {
			ctx.ui.notify(`Compaction model: ${selection.modelId} (${selection.thinkingLevel} thinking).`, "info");
		} else {
			const activeModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "not selected";
			ctx.ui.notify(`Compaction model: ${activeModel} (active session model).`, "info");
		}

		if (sessionReadSelectionError) {
			// reloadSelections already reported the invalid setting and fail-closed behavior.
		} else if (sessionReadSelection) {
			ctx.ui.notify(
				`Session reader model: ${sessionReadSelection.modelId} (${sessionReadSelection.thinkingLevel} thinking).`,
				"info",
			);
		} else {
			const activeModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "not selected";
			ctx.ui.notify(`Session reader model: ${activeModel} (active session model).`, "info");
		}

		if (sessionTitleSelection) {
			ctx.ui.notify(
				`Session title model: ${sessionTitleSelection.modelId} (${sessionTitleSelection.thinkingLevel} thinking).`,
				"info",
			);
		} else {
			const activeModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "not selected";
			ctx.ui.notify(`Session title model: ${activeModel} (active session model).`, "info");
		}
	});

	const configureCompactionModel = async (ctx: ExtensionContext): Promise<boolean> => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/suite requires interactive mode.", "warning");
			return true;
		}

		const models = [...ctx.modelRegistry.getAvailable()].sort((left, right) => {
			const leftSelected = left.id === selection?.modelId;
			const rightSelected = right.id === selection?.modelId;
			if (leftSelected !== rightSelected) return leftSelected ? -1 : 1;
			return modelLabel(left).localeCompare(modelLabel(right));
		});

		const choice = await ctx.ui.custom<ModelChoice>(
			(tui, theme, _keybindings, done) =>
				new ModelSelector(tui, theme, models, done, {
					title: "Select Compaction Model",
					activeDescription: "Follow the conversation model in each session",
					currentModelId: selection?.modelId,
				}),
		);
		if (!choice) return false;

		if (choice.type === "active") {
			try {
				saveCompactionModelSelection(undefined);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not save the compaction model setting: ${reason}`, "error");
				return true;
			}
			selection = undefined;
			ctx.ui.notify("Compaction will use the active session model.", "info");
			return true;
		}

		const model = choice.model;

		const supportedLevels = getSupportedThinkingLevels(model);
		const chosenLevel = await ctx.ui.select("Compaction thinking level", supportedLevels);
		const thinkingLevel = supportedLevels.find((level) => level === chosenLevel);
		if (!thinkingLevel) return false;

		const nextSelection: CompactionModelSelection = {
			modelId: model.id,
			thinkingLevel,
		};
		try {
			saveCompactionModelSelection(nextSelection);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Could not save the compaction model setting: ${reason}`, "error");
			return true;
		}
		selection = nextSelection;
		ctx.ui.notify(`Compaction will use ${model.provider}/${model.id} with ${thinkingLevel} thinking.`, "info");
		return true;
	};

	const configureSessionReadModel = async (ctx: ExtensionContext): Promise<boolean> => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/suite requires interactive mode.", "warning");
			return true;
		}

		const models = [...ctx.modelRegistry.getAvailable()].sort((left, right) => {
			const leftSelected = left.id === sessionReadSelection?.modelId;
			const rightSelected = right.id === sessionReadSelection?.modelId;
			if (leftSelected !== rightSelected) return leftSelected ? -1 : 1;
			return modelLabel(left).localeCompare(modelLabel(right));
		});

		const choice = await ctx.ui.custom<ModelChoice>(
			(tui, theme, _keybindings, done) =>
				new ModelSelector(tui, theme, models, done, {
					title: "Select Session Reader Model",
					activeDescription: "Use each invoking session's active model",
					currentModelId: sessionReadSelection?.modelId,
				}),
		);
		if (!choice) return false;

		if (choice.type === "active") {
			try {
				saveSessionReadModelSelection(undefined);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not save the session reader model setting: ${reason}`, "error");
				return true;
			}
			sessionReadSelection = undefined;
			sessionReadSelectionError = undefined;
			ctx.ui.notify("Historical session reading will use the active session model.", "info");
			return true;
		}

		const model = choice.model;
		const supportedLevels = getSupportedThinkingLevels(model);
		const chosenLevel = await ctx.ui.select("Session reader thinking level", supportedLevels);
		const thinkingLevel = supportedLevels.find((level) => level === chosenLevel);
		if (!thinkingLevel) return false;

		const nextSelection: SessionReadModelSelection = {
			modelId: model.id,
			thinkingLevel,
		};
		try {
			saveSessionReadModelSelection(nextSelection);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Could not save the session reader model setting: ${reason}`, "error");
			return true;
		}
		sessionReadSelection = nextSelection;
		sessionReadSelectionError = undefined;
		ctx.ui.notify(
			`Historical session reading will use ${model.provider}/${model.id} with ${thinkingLevel} thinking.`,
			"info",
		);
		return true;
	};

	const configureSessionTitleModel = async (ctx: ExtensionContext): Promise<boolean> => {
		const models = [...ctx.modelRegistry.getAvailable()].sort((left, right) => {
			const leftSelected = left.id === sessionTitleSelection?.modelId;
			const rightSelected = right.id === sessionTitleSelection?.modelId;
			if (leftSelected !== rightSelected) return leftSelected ? -1 : 1;
			return modelLabel(left).localeCompare(modelLabel(right));
		});
		const choice = await ctx.ui.custom<ModelChoice>(
			(tui, theme, _keybindings, done) =>
				new ModelSelector(tui, theme, models, done, {
					title: "Select Session Title Model",
					activeDescription: "Use each session's active model",
					currentModelId: sessionTitleSelection?.modelId,
				}),
		);
		if (!choice) return false;
		if (choice.type === "active") {
			try {
				saveSessionTitleModelSelection(undefined);
			} catch (error) {
				ctx.ui.notify(`Could not save the session title model setting: ${errorMessage(error)}`, "error");
				return true;
			}
			sessionTitleSelection = undefined;
			ctx.ui.notify("Session titles will use the active session model.", "info");
			return true;
		}
		const supportedLevels = getSupportedThinkingLevels(choice.model);
		const chosenLevel = await ctx.ui.select("Session title thinking level", supportedLevels);
		const thinkingLevel = supportedLevels.find((level) => level === chosenLevel);
		if (!thinkingLevel) return false;
		const nextSelection: SessionTitleModelSelection = { modelId: choice.model.id, thinkingLevel };
		try {
			saveSessionTitleModelSelection(nextSelection);
		} catch (error) {
			ctx.ui.notify(`Could not save the session title model setting: ${errorMessage(error)}`, "error");
			return true;
		}
		sessionTitleSelection = nextSelection;
		ctx.ui.notify(
			`Session titles will use ${choice.model.provider}/${choice.model.id} with ${thinkingLevel} thinking.`,
			"info",
		);
		return true;
	};

	const setupAgents = async (ctx: ExtensionContext): Promise<void> => {
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
			const updated =
				result.updated.length > 0
					? ` Updated ${result.updated.length} presets. Previous files are in pi-suite-agent-backups in your Pi agent directory.`
					: "";
			ctx.ui.notify(
				`${installed}${updated}${skipped} Suite presets use blocking calls and disable session retention. Upstream defaults, workflows, and schedules are disabled. Run /reload; installed Suite presets update automatically when bundled content changes.`,
				"info",
			);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Could not install Pi Suite agent presets: ${reason}`, "error");
		}
	};

	pi.registerCommand("suite", {
		description: "Configure Pi Suite",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/suite requires interactive mode.", "warning");
				return;
			}

			while (true) {
				const item = await ctx.ui.select("Pi Suite Configuration", [
					"Compaction model",
					"Session reader model",
					"Session title model",
					"Setup agents",
				]);
				if (!item) return;
				if (item === "Setup agents") {
					await setupAgents(ctx);
					return;
				}

				const completed =
					item === "Compaction model"
						? await configureCompactionModel(ctx)
						: item === "Session reader model"
							? await configureSessionReadModel(ctx)
							: await configureSessionTitleModel(ctx);
				if (completed) return;
			}
		},
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (attemptedSessionTitle) return;
		attemptedSessionTitle = true;
		try {
			const title = await generateSessionTitle(ctx, sessionTitleSelection, pi.getThinkingLevel());
			if (title) pi.setSessionName(title);
		} catch (error) {
			warnUnavailable(ctx, `Could not generate the session title: ${errorMessage(error)}`);
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const currentSelection = selection;
		if (!currentSelection) return;

		const model = ctx.modelRegistry.getAvailable().find((candidate) => candidate.id === currentSelection.modelId);
		if (!model) {
			warn(ctx, `Compaction model ${currentSelection.modelId} was not found.`);
			return;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			warn(ctx, `Authentication failed for ${currentSelection.modelId}: ${auth.error}.`);
			return;
		}

		try {
			const preparation = includePreviousFileOperations(event.preparation, event.branchEntries);
			const thinkingLevel = clampThinkingLevel(model, currentSelection.thinkingLevel);
			// The compatibility compaction API accepts only headers that have not been deleted.
			const headers = auth.headers
				? Object.fromEntries(
						Object.entries(auth.headers).filter((entry): entry is [string, string] => entry[1] !== null),
					)
				: undefined;
			const result = await compact(
				preparation,
				model,
				auth.apiKey,
				headers,
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
				warn(ctx, `Compaction with ${currentSelection.modelId} failed: ${reason}.`);
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
	loadSessionTitleModelSelection,
	PI_SUITE_CONFIG_FILE,
	type SessionReadModelSelection,
	type SessionTitleModelSelection,
	saveCompactionModelSelection,
	saveSessionReadModelSelection,
	saveSessionTitleModelSelection,
} from "./state.ts";
