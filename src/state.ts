import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

/** Session entry used to persist Pi Suite's branch-local compaction model selection. */
export const COMPACTION_MODEL_ENTRY = "pi-suite.compaction-model";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface CompactionModelSelection {
	provider: string;
	modelId: string;
	thinkingLevel: ModelThinkingLevel;
}

export interface CompactionModelState {
	version: 1;
	selection: CompactionModelSelection | null;
}

type CompactionPreparation = SessionBeforeCompactEvent["preparation"];
type SessionEntry = SessionBeforeCompactEvent["branchEntries"][number];
type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSelection(value: unknown): value is CompactionModelSelection {
	if (!isRecord(value)) return false;

	return (
		typeof value.provider === "string" &&
		value.provider.length > 0 &&
		typeof value.modelId === "string" &&
		value.modelId.length > 0 &&
		typeof value.thinkingLevel === "string" &&
		(THINKING_LEVELS as readonly string[]).includes(value.thinkingLevel)
	);
}

export function restoreCompactionModelSelection(entries: SessionEntry[]): CompactionModelSelection | undefined {
	let selection: CompactionModelSelection | undefined;

	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== COMPACTION_MODEL_ENTRY || !isRecord(entry.data)) continue;
		if (entry.data.version !== 1) continue;

		if (entry.data.selection === null) {
			selection = undefined;
		} else if (isSelection(entry.data.selection)) {
			selection = entry.data.selection;
		}
	}

	return selection;
}

export function includePreviousFileOperations(
	preparation: CompactionPreparation,
	branchEntries: SessionEntry[],
): CompactionPreparation {
	const fileOps = {
		read: new Set(preparation.fileOps.read),
		written: new Set(preparation.fileOps.written),
		edited: new Set(preparation.fileOps.edited),
	};

	for (let index = branchEntries.length - 1; index >= 0; index--) {
		const entry = branchEntries[index];
		if (entry?.type !== "compaction") continue;
		if (!isRecord(entry.details)) break;

		if (Array.isArray(entry.details.readFiles)) {
			for (const path of entry.details.readFiles) {
				if (typeof path === "string") fileOps.read.add(path);
			}
		}

		if (Array.isArray(entry.details.modifiedFiles)) {
			for (const path of entry.details.modifiedFiles) {
				if (typeof path === "string") fileOps.edited.add(path);
			}
		}

		break;
	}

	return { ...preparation, fileOps };
}
