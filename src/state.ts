import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";

/** Namespace used for Pi Suite preferences in Pi's global settings.json. */
export const PI_SUITE_SETTINGS_KEY = "piSuite";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface ModelSelection {
	provider: string;
	modelId: string;
	thinkingLevel: ModelThinkingLevel;
}

export type CompactionModelSelection = ModelSelection;
export type SessionReadModelSelection = ModelSelection;

type CompactionPreparation = SessionBeforeCompactEvent["preparation"];
type SessionEntry = SessionBeforeCompactEvent["branchEntries"][number];
type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSelection(value: unknown): value is ModelSelection {
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

function parseSettings(content: string, settingsPath: string): UnknownRecord {
	const settings: unknown = JSON.parse(content);
	if (!isRecord(settings)) throw new Error(`Pi settings at ${settingsPath} must contain a JSON object.`);
	return settings;
}

function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

function acquireSettingsLock(settingsPath: string): () => void {
	let lastError: unknown;
	for (let attempt = 0; attempt < 10; attempt++) {
		try {
			return lockfile.lockSync(settingsPath, { realpath: false });
		} catch (error) {
			const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
			if (code !== "ELOCKED" || attempt === 9) throw error;
			lastError = error;
			const waitUntil = Date.now() + 20;
			while (Date.now() < waitUntil) {
				// Pi's settings writes are synchronous and short; briefly wait for its shared lock.
			}
		}
	}
	throw lastError;
}

function loadModelSelection(
	key: "compactionModel" | "sessionReadModel",
	settingsPath: string,
): ModelSelection | undefined {
	if (!existsSync(settingsPath)) return undefined;

	const release = acquireSettingsLock(settingsPath);
	try {
		const settings = parseSettings(readFileSync(settingsPath, "utf8"), settingsPath);
		const suiteSettings = settings[PI_SUITE_SETTINGS_KEY];
		if (suiteSettings === undefined) return undefined;
		if (!isRecord(suiteSettings)) throw new Error(`${PI_SUITE_SETTINGS_KEY} in ${settingsPath} must be an object.`);

		const selection = suiteSettings[key];
		if (selection === undefined || selection === null) return undefined;
		if (!isSelection(selection)) {
			throw new Error(`${PI_SUITE_SETTINGS_KEY}.${key} in ${settingsPath} is invalid.`);
		}
		return selection;
	} finally {
		release();
	}
}

function saveModelSelection(
	key: "compactionModel" | "sessionReadModel",
	selection: ModelSelection | undefined,
	settingsPath: string,
): void {
	mkdirSync(dirname(settingsPath), { recursive: true });

	const release = acquireSettingsLock(settingsPath);
	try {
		const settings = existsSync(settingsPath) ? parseSettings(readFileSync(settingsPath, "utf8"), settingsPath) : {};
		const existingSuiteSettings = settings[PI_SUITE_SETTINGS_KEY];
		if (existingSuiteSettings !== undefined && !isRecord(existingSuiteSettings)) {
			throw new Error(`${PI_SUITE_SETTINGS_KEY} in ${settingsPath} must be an object.`);
		}

		settings[PI_SUITE_SETTINGS_KEY] = {
			...(existingSuiteSettings ?? {}),
			[key]: selection ?? null,
		};
		writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
	} finally {
		release();
	}
}

export function loadCompactionModelSelection(settingsPath = getSettingsPath()): CompactionModelSelection | undefined {
	return loadModelSelection("compactionModel", settingsPath);
}

export function saveCompactionModelSelection(
	selection: CompactionModelSelection | undefined,
	settingsPath = getSettingsPath(),
): void {
	saveModelSelection("compactionModel", selection, settingsPath);
}

export function loadSessionReadModelSelection(settingsPath = getSettingsPath()): SessionReadModelSelection | undefined {
	return loadModelSelection("sessionReadModel", settingsPath);
}

export function saveSessionReadModelSelection(
	selection: SessionReadModelSelection | undefined,
	settingsPath = getSettingsPath(),
): void {
	saveModelSelection("sessionReadModel", selection, settingsPath);
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
