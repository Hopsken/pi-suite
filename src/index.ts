import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { compact, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installAgentPresets } from "./agent-presets.ts";
import { type CompactionModelChoice, CompactionModelSelector } from "./model-selector.ts";
import {
	type CompactionModelSelection,
	includePreviousFileOperations,
	loadCompactionModelSelection,
	saveCompactionModelSelection,
} from "./state.ts";

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

/** Registers Pi Suite's integrated workflows. */
export default function piSuite(pi: ExtensionAPI): void {
	let selection: CompactionModelSelection | undefined;
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

	const reloadSelection = (ctx: ExtensionContext): void => {
		try {
			selection = loadCompactionModelSelection();
		} catch (error) {
			selection = undefined;
			const reason = error instanceof Error ? error.message : String(error);
			warn(ctx, `Could not load the compaction model setting: ${reason}`);
		}
	};

	pi.on("session_start", (_event, ctx) => {
		completedCustomCompaction = undefined;
		reloadSelection(ctx);
		if (ctx.mode !== "tui") return;

		if (selection) {
			ctx.ui.notify(
				`Compaction model: ${selection.provider}/${selection.modelId} (${selection.thinkingLevel} thinking).`,
				"info",
			);
			return;
		}

		const activeModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "not selected";
		ctx.ui.notify(`Compaction model: ${activeModel} (active session model).`, "info");
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

			const choice = await ctx.ui.custom<CompactionModelChoice>(
				(tui, theme, _keybindings, done) => new CompactionModelSelector(tui, theme, models, done),
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
}

export {
	type CompactionModelSelection,
	includePreviousFileOperations,
	loadCompactionModelSelection,
	PI_SUITE_SETTINGS_KEY,
	saveCompactionModelSelection,
} from "./state.ts";
