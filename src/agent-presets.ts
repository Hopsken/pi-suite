import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const presetDirectory = fileURLToPath(new URL("../presets/agents", import.meta.url));

type Settings = Record<string, unknown>;

export type AgentPresetInstallResult = {
	installed: string[];
	skipped: string[];
};

function loadSettings(path: string): Settings {
	if (!existsSync(path)) return {};

	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Subagents settings at ${path} must contain a JSON object.`);
	}
	return parsed as Settings;
}

/** Installs every bundled agent preset globally without replacing existing definitions. */
export function installAgentPresets(): AgentPresetInstallResult {
	const agentDirectory = getAgentDir();
	const agentsDirectory = join(agentDirectory, "agents");
	const settingsPath = join(agentDirectory, "subagents.json");
	const settings = loadSettings(settingsPath);
	const presets = readdirSync(presetDirectory)
		.filter((name) => name.endsWith(".md"))
		.sort();

	if (presets.length === 0) throw new Error("Pi Suite does not contain any agent presets.");

	mkdirSync(agentsDirectory, { recursive: true });
	const installed: string[] = [];
	const skipped: string[] = [];
	for (const name of presets) {
		const destination = join(agentsDirectory, name);
		if (existsSync(destination)) {
			skipped.push(name);
			continue;
		}
		copyFileSync(join(presetDirectory, name), destination, constants.COPYFILE_EXCL);
		installed.push(name);
	}

	if (settings.disableDefaultAgents !== true) {
		writeFileSync(settingsPath, JSON.stringify({ ...settings, disableDefaultAgents: true }, null, 2), "utf8");
	}

	return { installed, skipped };
}
