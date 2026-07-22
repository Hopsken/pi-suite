import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { compact, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	COMPACTION_MODEL_ENTRY,
	type CompactionModelSelection,
	type CompactionModelState,
	includePreviousFileOperations,
	restoreCompactionModelSelection,
} from "./state.ts";

const ACTIVE_MODEL_OPTION = "Use active session model (default)";

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

	const restoreSelection = (ctx: ExtensionContext): void => {
		selection = restoreCompactionModelSelection(ctx.sessionManager.getBranch());
	};

	pi.on("session_start", (_event, ctx) => restoreSelection(ctx));
	pi.on("session_tree", (_event, ctx) => restoreSelection(ctx));

	pi.registerCommand("compaction-model", {
		description: "Select the model and thinking level used for session compaction",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("The compaction model picker requires interactive mode.", "warning");
				return;
			}

			const models = [...ctx.modelRegistry.getAvailable()].sort((left, right) => {
				const leftSelected = left.provider === selection?.provider && left.id === selection.modelId;
				const rightSelected = right.provider === selection?.provider && right.id === selection.modelId;
				if (leftSelected !== rightSelected) return leftSelected ? -1 : 1;
				return modelLabel(left).localeCompare(modelLabel(right));
			});

			if (models.length === 0) {
				ctx.ui.notify("No authenticated models are available.", "warning");
				return;
			}

			const labels = models.map(modelLabel);
			const chosenLabel = await ctx.ui.select("Compaction model", [ACTIVE_MODEL_OPTION, ...labels]);
			if (chosenLabel === undefined) return;

			if (chosenLabel === ACTIVE_MODEL_OPTION) {
				selection = undefined;
				const state: CompactionModelState = { version: 1, selection: null };
				pi.appendEntry(COMPACTION_MODEL_ENTRY, state);
				ctx.ui.notify("Compaction will use the active session model.", "info");
				return;
			}

			const model = models[labels.indexOf(chosenLabel)];
			if (!model) return;

			const supportedLevels = getSupportedThinkingLevels(model);
			const chosenLevel = await ctx.ui.select("Compaction thinking level", supportedLevels);
			const thinkingLevel = supportedLevels.find((level) => level === chosenLevel);
			if (!thinkingLevel) return;

			selection = {
				provider: model.provider,
				modelId: model.id,
				thinkingLevel,
			};
			const state: CompactionModelState = { version: 1, selection };
			pi.appendEntry(COMPACTION_MODEL_ENTRY, state);
			ctx.ui.notify(`Compaction will use ${model.provider}/${model.id} with ${thinkingLevel} thinking.`, "info");
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
			const result = await compact(
				preparation,
				model,
				auth.apiKey,
				auth.headers,
				event.customInstructions,
				event.signal,
				clampThinkingLevel(model, currentSelection.thinkingLevel),
				undefined,
				auth.env,
			);

			return { compaction: result };
		} catch (error) {
			if (!event.signal.aborted) {
				const reason = error instanceof Error ? error.message : String(error);
				warn(ctx, `Compaction with ${currentSelection.provider}/${currentSelection.modelId} failed: ${reason}.`);
			}
			return;
		}
	});
}

export {
	COMPACTION_MODEL_ENTRY,
	type CompactionModelSelection,
	type CompactionModelState,
	includePreviousFileOperations,
	restoreCompactionModelSelection,
} from "./state.ts";
