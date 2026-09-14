import { createHash } from "node:crypto";
import {
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const presetDirectory = fileURLToPath(new URL("../presets/agents", import.meta.url));

const settingsVersion = 1;
const suiteSettings = {
	disableDefaultAgents: true,
	backgroundByDefault: false,
	rememberAgents: false,
	outputTranscript: false,
	workflowsEnabled: false,
	schedulingEnabled: false,
	maxSubagentDepth: 2,
};

type Settings = Record<string, unknown>;

export type AgentPresetInstallResult = {
	installed: string[];
	updated: string[];
	skipped: string[];
};

function loadSettings(path: string): Settings {
	if (!existsSync(path)) return {};

	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Settings at ${path} must contain a JSON object.`);
	}
	return parsed as Settings;
}

/** Updates installed presets and migrates settings once; normal reloads preserve user edits. */
export function updateAgentPresets(installMissing = false): AgentPresetInstallResult {
	const agentDirectory = getAgentDir();
	const agentsDirectory = join(agentDirectory, "agents");
	const statePath = join(agentDirectory, ".pi-suite-presets.json");
	const revisions = loadSettings(statePath);
	let stateChanged = false;
	const presets = readdirSync(presetDirectory)
		.filter((name) => name.endsWith(".md"))
		.sort();

	if (presets.length === 0) throw new Error("Pi Suite does not contain any agent presets.");

	const hasInstalledPresets = presets.some(
		(name) => existsSync(join(agentsDirectory, name)) || typeof revisions[name] === "string",
	);
	const migrateSettings =
		installMissing || (hasInstalledPresets && Number(revisions.settingsVersion ?? 0) < settingsVersion);
	const settingsPath = join(agentDirectory, "subagents.json");
	// Validate before changing presets. A failed read must not mark migration complete.
	const settings = migrateSettings ? loadSettings(settingsPath) : undefined;

	const installed: string[] = [];
	const updated: string[] = [];
	const skipped: string[] = [];
	for (const name of presets) {
		const destination = join(agentsDirectory, name);
		if (!existsSync(destination) && !installMissing) continue;
		const source = join(presetDirectory, name);
		const content = readFileSync(source);
		const revision = createHash("sha256").update(content).digest("hex");
		if (!existsSync(destination)) {
			mkdirSync(agentsDirectory, { recursive: true });
			copyFileSync(source, destination, constants.COPYFILE_EXCL);
			installed.push(name);
		} else if (revisions[name] === revision || readFileSync(destination).equals(content)) {
			skipped.push(name);
		} else {
			const backupRoot = join(agentDirectory, "pi-suite-agent-backups");
			mkdirSync(backupRoot, { recursive: true });
			const backupDirectory = mkdtempSync(join(backupRoot, "update-"));
			copyFileSync(destination, join(backupDirectory, name), constants.COPYFILE_EXCL);
			// Replace atomically only after the old content has been backed up.
			const replacement = join(backupDirectory, `${name}.new`);
			writeFileSync(replacement, content);
			renameSync(replacement, destination);
			updated.push(name);
		}
		if (revisions[name] !== revision) {
			revisions[name] = revision;
			stateChanged = true;
		}
	}

	if (migrateSettings) {
		writeFileSync(settingsPath, JSON.stringify({ ...settings, ...suiteSettings }, null, 2), "utf8");
		revisions.settingsVersion = settingsVersion;
		stateChanged = true;
	}

	if (stateChanged) writeFileSync(statePath, JSON.stringify(revisions, null, 2), "utf8");
	return { installed, updated, skipped };
}

/** Installs missing presets, updates old revisions, and applies Suite settings. */
export function installAgentPresets(): AgentPresetInstallResult {
	return updateAgentPresets(true);
}
