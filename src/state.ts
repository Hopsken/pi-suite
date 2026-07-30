import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";

export const PI_SUITE_CONFIG_FILE = "pi-suite.json";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface ModelSelection {
	modelId: string;
	thinkingLevel: ModelThinkingLevel;
}

export type CompactionModelSelection = ModelSelection;
export type SessionReadModelSelection = ModelSelection;
export type SessionTitleModelSelection = ModelSelection;

type CompactionPreparation = SessionBeforeCompactEvent["preparation"];
type SessionEntry = SessionBeforeCompactEvent["branchEntries"][number];
type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSelection(value: unknown): ModelSelection | undefined {
	if (typeof value !== "string") return undefined;
	const separator = value.lastIndexOf(":");
	const modelId = value.slice(0, separator);
	const thinkingLevel = value.slice(separator + 1);
	if (!modelId || !(THINKING_LEVELS as readonly string[]).includes(thinkingLevel)) return undefined;
	return { modelId, thinkingLevel: thinkingLevel as ModelThinkingLevel };
}

function formatSelection(selection: ModelSelection): string {
	return `${selection.modelId}:${selection.thinkingLevel}`;
}

function parseConfig(content: string, configPath: string): UnknownRecord {
	const config: unknown = JSON.parse(content);
	if (!isRecord(config)) throw new Error(`Pi Suite config at ${configPath} must contain a JSON object.`);
	return config;
}

function getConfigPath(): string {
	return join(getAgentDir(), PI_SUITE_CONFIG_FILE);
}

function acquireConfigLock(configPath: string): () => void {
	let lastError: unknown;
	for (let attempt = 0; attempt < 10; attempt++) {
		try {
			return lockfile.lockSync(configPath, { realpath: false });
		} catch (error) {
			const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
			if (code !== "ELOCKED" || attempt === 9) throw error;
			lastError = error;
			const waitUntil = Date.now() + 20;
			while (Date.now() < waitUntil) {
				// Pi Suite config writes are synchronous and short; briefly wait for its shared lock.
			}
		}
	}
	throw lastError;
}

function loadModelSelection(
	key: "compactionModel" | "sessionReadModel" | "sessionTitleModel",
	configPath: string,
): ModelSelection | undefined {
	if (!existsSync(configPath)) return undefined;

	const release = acquireConfigLock(configPath);
	try {
		const config = parseConfig(readFileSync(configPath, "utf8"), configPath);
		const selection = config[key];
		if (selection === undefined || selection === null) return undefined;
		const parsed = parseSelection(selection);
		if (!parsed) throw new Error(`${key} in ${configPath} is invalid.`);
		return parsed;
	} finally {
		release();
	}
}

function saveModelSelection(
	key: "compactionModel" | "sessionReadModel" | "sessionTitleModel",
	selection: ModelSelection | undefined,
	configPath: string,
): void {
	mkdirSync(dirname(configPath), { recursive: true });

	const release = acquireConfigLock(configPath);
	try {
		const config = existsSync(configPath) ? parseConfig(readFileSync(configPath, "utf8"), configPath) : {};
		config[key] = selection ? formatSelection(selection) : null;
		writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	} finally {
		release();
	}
}

export function loadCompactionModelSelection(configPath = getConfigPath()): CompactionModelSelection | undefined {
	return loadModelSelection("compactionModel", configPath);
}

export function saveCompactionModelSelection(
	selection: CompactionModelSelection | undefined,
	configPath = getConfigPath(),
): void {
	saveModelSelection("compactionModel", selection, configPath);
}

export function loadSessionReadModelSelection(configPath = getConfigPath()): SessionReadModelSelection | undefined {
	return loadModelSelection("sessionReadModel", configPath);
}

export function saveSessionReadModelSelection(
	selection: SessionReadModelSelection | undefined,
	configPath = getConfigPath(),
): void {
	saveModelSelection("sessionReadModel", selection, configPath);
}

export function loadSessionTitleModelSelection(configPath = getConfigPath()): SessionTitleModelSelection | undefined {
	return loadModelSelection("sessionTitleModel", configPath);
}

export function saveSessionTitleModelSelection(
	selection: SessionTitleModelSelection | undefined,
	configPath = getConfigPath(),
): void {
	saveModelSelection("sessionTitleModel", selection, configPath);
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
