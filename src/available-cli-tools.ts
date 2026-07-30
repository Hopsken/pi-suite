import {
	createLocalBashOperations,
	type ExtensionAPI,
	type ExtensionContext,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const COMMON_CLI_TOOLS = [
	{ name: "tmux", commands: ["tmux"] },
	{ name: "ffmpeg", commands: ["ffmpeg"] },
	{ name: "jq", commands: ["jq"] },
	{ name: "docker", commands: ["docker"] },
	{ name: "fzf", commands: ["fzf"] },
	{ name: "unzip", commands: ["unzip"] },
	{ name: "lsof", commands: ["lsof"] },
	{ name: "zstd", commands: ["zstd"] },
	{ name: "websocat", commands: ["websocat"] },
	{ name: "ripgrep", commands: ["rg"] },
	{ name: "ast-grep", commands: ["ast-grep"] },
	{ name: "bun", commands: ["bun"] },
	{ name: "pnpm", commands: ["pnpm"] },
	{ name: "yarn", commands: ["yarn"] },
	{ name: "agent-browser", commands: ["agent-browser"] },
	{ name: "mise", commands: ["mise"] },
	{ name: "asdf", commands: ["asdf"] },
	{ name: "Nix CLI", commands: ["nix"] },
	{ name: "GitHub CLI", commands: ["gh"] },
	{ name: "GitLab CLI", commands: ["glab"] },
] as const;

const OUTPUT_PREFIX = "__PI_SUITE_CLI__:";

function formatAvailableCliTools(commands: ReadonlySet<string>): string[] {
	const available: string[] = [];
	for (const tool of COMMON_CLI_TOOLS) {
		const command = tool.commands.find((candidate) => commands.has(candidate));
		if (!command) continue;
		available.push(tool.name === command ? `\`${command}\`` : `${tool.name} (\`${command}\`)`);
	}
	return available;
}

async function detectAvailableCliTools(ctx: ExtensionContext): Promise<string[] | undefined> {
	const cwd = ctx.cwd ?? process.cwd();
	try {
		const settings = SettingsManager.create(cwd, undefined, {
			projectTrusted: ctx.isProjectTrusted?.() ?? false,
		});
		const operations = createLocalBashOperations({ shellPath: settings.getShellPath() });
		const candidates = COMMON_CLI_TOOLS.flatMap((tool) => tool.commands);
		const detector = [
			`for candidate in ${candidates.join(" ")}; do`,
			'\tcandidate_path=$(command -v "$candidate" 2>/dev/null) || continue',
			'\tif [ -f "$candidate_path" ] && [ -x "$candidate_path" ]; then',
			`\t\tprintf '${OUTPUT_PREFIX}%s\\n' "$candidate"`,
			"\tfi",
			"done",
		].join("\n");
		const shellCommandPrefix = settings.getShellCommandPrefix();
		const command = shellCommandPrefix ? `${shellCommandPrefix}\n${detector}` : detector;
		let output = "";
		const result = await operations.exec(command, cwd, {
			onData: (data) => {
				output += data.toString("utf8");
			},
			timeout: 2,
		});
		if (result.exitCode !== 0) return undefined;
		const detectedCommands = output
			.split(/\r?\n/)
			.filter((line) => line.startsWith(OUTPUT_PREFIX))
			.map((line) => line.slice(OUTPUT_PREFIX.length));
		return formatAvailableCliTools(new Set(detectedCommands));
	} catch {
		return undefined;
	}
}

function availableCliToolsPrompt(availableTools: readonly string[]): string | undefined {
	if (availableTools.length === 0) return undefined;
	return [
		"## Available CLI tools",
		`The following commonly used CLI tools were detected on PATH: ${availableTools.join(", ")}.`,
		"Use them directly when appropriate; availability does not imply that a tool is configured or that its services are running.",
	].join("\n");
}

export function registerAvailableCliToolsPrompt(pi: ExtensionAPI): void {
	let prompt: string | undefined;
	pi.on("session_start", async (_event, ctx) => {
		const availableTools = await detectAvailableCliTools(ctx);
		if (availableTools) prompt = availableCliToolsPrompt(availableTools);
	});
	pi.on("before_agent_start", (event) => {
		if (!prompt) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
	});
}
