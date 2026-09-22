import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type FauxProviderRegistration, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import piSuite, { SESSION_READ_TOOL_NAME, SESSION_SEARCH_TOOL_NAME } from "../src/index.ts";
import { normalizeRepositoryRemote, repositoryMatches } from "../src/session-history/repository.ts";

type Handler = (event: any, context: any) => any;
type ToolHandler = (...args: any[]) => any;

function createExtensionApi() {
	const commands = new Map<string, { handler: Handler }>();
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, { execute: ToolHandler }>();
	const setSessionName = vi.fn();
	const appendEntry = vi.fn();
	const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 1, killed: false });
	const pi = {
		registerCommand(name: string, command: { handler: Handler }) {
			commands.set(name, command);
		},
		registerTool(tool: { name: string; execute: ToolHandler }) {
			tools.set(tool.name, tool);
		},
		getThinkingLevel: () => "off",
		on(event: string, handler: Handler) {
			const previous = handlers.get(event);
			handlers.set(event, async (eventData: any, context: any) => {
				await previous?.(eventData, context);
				return handler(eventData, context);
			});
		},
		appendEntry,
		exec,
		setSessionName,
		getActiveTools: vi.fn(() => Array.from(tools.keys())),
		getAllTools: vi.fn(() => Array.from(tools.keys(), (name) => ({ name }))),
		setActiveTools: vi.fn(),
	};

	piSuite(pi as never);
	return { commands, handlers, tools, setSessionName, appendEntry, exec };
}

describe("Pi Suite extension", () => {
	let agentDirectory: string;
	let originalAgentDirectory: string | undefined;
	let fauxProvider: FauxProviderRegistration | undefined;

	beforeEach(() => {
		agentDirectory = mkdtempSync(join(tmpdir(), "pi-suite-agent-"));
		originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDirectory;
	});

	afterEach(() => {
		fauxProvider?.unregister();
		fauxProvider = undefined;
		if (originalAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;
		rmSync(agentDirectory, { recursive: true, force: true });
	});

	test("persists a canonical repository identity once per session branch", async () => {
		const extension = createExtensionApi();
		extension.exec
			.mockResolvedValueOnce({
				stdout: "/repo/worktree\n/repo/.git\n",
				stderr: "",
				code: 0,
				killed: false,
			})
			.mockResolvedValueOnce({
				stdout:
					"remote.upstream.url git@github.com:other/project.git\nremote.origin.url https://user:secret@github.com/Hopsken/pi-suite.git\n",
				stderr: "",
				code: 0,
				killed: false,
			});
		const context = {
			cwd: "/repo/worktree",
			mode: "print",
			hasUI: false,
			getSystemPrompt: () => "You are Pi's main coding agent.",
			sessionManager: { getBranch: (): any[] => [] },
			ui: { notify: vi.fn() },
		};

		await extension.handlers.get("session_start")?.({ reason: "new" }, context);

		expect(extension.appendEntry).toHaveBeenCalledWith("pi-suite-repository", {
			worktreeRoot: "/repo/worktree",
			commonGitDir: "/repo/.git",
			remote: "github.com/hopsken/pi-suite",
		});
		const calls = extension.exec.mock.calls.length;
		extension.exec
			.mockResolvedValueOnce({
				stdout: "/repo/worktree\n/repo/.git\n",
				stderr: "",
				code: 0,
				killed: false,
			})
			.mockResolvedValueOnce({
				stdout: "remote.origin.url git@github.com:hopsken/pi-suite.git\n",
				stderr: "",
				code: 0,
				killed: false,
			});
		await extension.handlers.get("session_tree")?.({}, context);
		expect(extension.appendEntry).toHaveBeenCalledTimes(2);
		expect(extension.exec).toHaveBeenCalledTimes(calls + 2);

		context.sessionManager.getBranch = () => [
			{
				type: "custom",
				customType: "pi-suite-repository",
				data: { worktreeRoot: "/repo/worktree", commonGitDir: "/repo/.git" },
			},
		];
		await extension.handlers.get("session_tree")?.({}, context);
		expect(extension.exec).toHaveBeenCalledTimes(calls + 2);
	});

	test("canonicalizes supported repository remotes without retaining credentials or helper commands", () => {
		const cases = [
			["https://user:secret@GitHub.com/Hopsken/pi-suite.git", "github.com/hopsken/pi-suite"],
			["git@github.com:Hopsken/pi-suite.git", "github.com/hopsken/pi-suite"],
			["github.com:Hopsken/pi-suite.git", "github.com/hopsken/pi-suite"],
			["ssh://git@example.com:2222/Owner/Repo.git", "example.com:2222/owner/repo"],
			["file:///tmp/source.git", "/tmp/source"],
			["ext::ssh -i /secret/key example %S repo", undefined],
		] as const;
		for (const [input, expected] of cases) {
			const normalized = normalizeRepositoryRemote(input);
			expect(normalized).toBe(expected);
			if (normalized) expect(normalizeRepositoryRemote(normalized)).toBe(normalized);
		}
	});

	test("requires an exact host when a repo filter is host-qualified", () => {
		const repository = {
			worktreeRoot: "/repo",
			commonGitDir: "/repo/.git",
			remote: "mirror.example/github.com/hopsken/pi-suite",
		};
		expect(repositoryMatches(repository, "hopsken/pi-suite", undefined)).toBe(true);
		expect(repositoryMatches(repository, "github.com/hopsken/pi-suite", undefined)).toBe(false);
	});

	test("installs agent presets globally, preserves customization, and disables upstream defaults", async () => {
		writeFileSync(join(agentDirectory, "subagents.json"), JSON.stringify({ maxConcurrent: 8 }), "utf8");
		const { commands } = createExtensionApi();
		const notify = vi.fn();

		await commands.get("suite")?.handler("", {
			mode: "tui",
			ui: { notify, select: vi.fn().mockResolvedValue("Setup agents") },
		});

		const explorePath = join(agentDirectory, "agents", "Explore.md");
		const explorePreset = readFileSync(explorePath, "utf8");
		expect(explorePreset).toContain("read-only codebase discovery specialist");
		expect(explorePreset).toContain("model: openai-codex/gpt-5.6-terra");
		expect(explorePreset).toContain("thinking: low");
		expect(explorePreset).toContain("max_turns: 50");
		expect(explorePreset).toContain("run_in_background: false");
		expect(explorePreset).toContain("persist_session: false");
		expect(explorePreset).toContain("output_transcript: false");
		expect(explorePreset).toContain("workspace-relative file paths and line numbers or ranges");
		const librarianPath = join(agentDirectory, "agents", "Librarian.md");
		const librarianPreset = readFileSync(librarianPath, "utf8");
		expect(librarianPreset).toContain("read-only codebase-understanding specialist");
		expect(librarianPreset).toContain("model: openai-codex/gpt-5.6-sol");
		expect(librarianPreset).toContain("thinking: off");
		expect(librarianPreset).toContain("max_turns: 50");
		expect(librarianPreset).toContain("run_in_background: false");
		expect(librarianPreset).toContain("persist_session: false");
		expect(librarianPreset).toContain("output_transcript: false");
		expect(librarianPreset).toContain("extensions: [pi-web-access]");
		expect(librarianPreset).toContain("skills: true");
		expect(librarianPreset).toContain("/tmp/pi-github-repos/<owner>/<repo>");
		expect(librarianPreset).toContain("immutable GitHub permalinks");
		const oraclePath = join(agentDirectory, "agents", "Oracle.md");
		const oraclePreset = readFileSync(oraclePath, "utf8");
		expect(oraclePreset).toContain("independent expert engineering adviser");
		expect(oraclePreset).toContain("model: openai-codex/gpt-5.6-sol");
		expect(oraclePreset).toContain("thinking: high");
		expect(oraclePreset).toContain("max_turns: 120");
		expect(oraclePreset).toContain("inherit_context: false");
		expect(oraclePreset).toContain("run_in_background: false");
		expect(oraclePreset).toContain("persist_session: false");
		expect(oraclePreset).toContain("output_transcript: false");
		expect(oraclePreset).toContain("allowed_subagents: [Explore, Librarian]");
		expect(oraclePreset).toContain("extensions: [pi-suite, pi-web-access]");
		expect(oraclePreset).toContain("workspace-relative file paths and line numbers or ranges");
		expect(JSON.parse(readFileSync(join(agentDirectory, "subagents.json"), "utf8"))).toEqual({
			maxConcurrent: 8,
			disableDefaultAgents: true,
			backgroundByDefault: false,
			rememberAgents: false,
			outputTranscript: false,
			workflowsEnabled: false,
			schedulingEnabled: false,
			maxSubagentDepth: 2,
		});
		expect(notify).toHaveBeenCalledWith(
			"Installed 3 presets. Suite presets use blocking calls and disable session retention. Upstream defaults, workflows, and schedules are disabled. Run /reload; installed Suite presets update automatically when bundled content changes.",
			"info",
		);

		const customizedExplore = "---\ndescription: Custom Explore\n---\nKeep this definition.\n";
		const customizedLibrarian = "---\ndescription: Custom Librarian\n---\nKeep this definition.\n";
		const customizedOracle = "---\ndescription: Custom Oracle\n---\nKeep this definition.\n";
		writeFileSync(explorePath, customizedExplore, "utf8");
		writeFileSync(librarianPath, customizedLibrarian, "utf8");
		writeFileSync(oraclePath, customizedOracle, "utf8");
		writeFileSync(
			join(agentDirectory, "subagents.json"),
			JSON.stringify({
				maxConcurrent: 8,
				disableDefaultAgents: false,
				backgroundByDefault: true,
				rememberAgents: true,
				outputTranscript: true,
				workflowsEnabled: true,
				schedulingEnabled: true,
				maxSubagentDepth: 9,
			}),
			"utf8",
		);
		notify.mockClear();
		await commands.get("suite")?.handler("", {
			mode: "tui",
			ui: { notify, select: vi.fn().mockResolvedValue("Setup agents") },
		});

		expect(readFileSync(explorePath, "utf8")).toBe(customizedExplore);
		expect(readFileSync(librarianPath, "utf8")).toBe(customizedLibrarian);
		expect(readFileSync(oraclePath, "utf8")).toBe(customizedOracle);
		expect(JSON.parse(readFileSync(join(agentDirectory, "subagents.json"), "utf8"))).toEqual({
			maxConcurrent: 8,
			disableDefaultAgents: true,
			backgroundByDefault: false,
			rememberAgents: false,
			outputTranscript: false,
			workflowsEnabled: false,
			schedulingEnabled: false,
			maxSubagentDepth: 2,
		});
		expect(notify).toHaveBeenCalledWith(
			"All presets were already installed. Left 3 existing definitions unchanged. Suite presets use blocking calls and disable session retention. Upstream defaults, workflows, and schedules are disabled. Run /reload; installed Suite presets update automatically when bundled content changes.",
			"info",
		);
	});

	test("activation updates legacy presets with backups, but preserves edits until the next bundled revision", () => {
		createExtensionApi();
		expect(readdirSync(agentDirectory)).toEqual([]);
		const agents = join(agentDirectory, "agents");
		mkdirSync(agents);
		const oracle = join(agents, "Oracle.md");
		const custom = join(agents, "Custom.md");
		const legacy = "---\ndescription: Old Oracle\n---\nUse oracle_finder.\n";
		writeFileSync(oracle, legacy);
		writeFileSync(custom, "Unrelated agent.");
		const settings = join(agentDirectory, "subagents.json");
		writeFileSync(settings, '{"maxConcurrent":3}');

		createExtensionApi();
		const bundled = readFileSync(new URL("../presets/agents/Oracle.md", import.meta.url), "utf8");
		expect(readFileSync(oracle, "utf8")).toBe(bundled);
		expect(readdirSync(agents).sort()).toEqual(["Custom.md", "Oracle.md"]);
		expect(readFileSync(custom, "utf8")).toBe("Unrelated agent.");
		expect(JSON.parse(readFileSync(settings, "utf8"))).toMatchObject({ maxConcurrent: 3, schedulingEnabled: false });
		const backups = join(agentDirectory, "pi-suite-agent-backups");
		const firstBackup = readdirSync(backups)[0]!;
		expect(readdirSync(backups)).toHaveLength(1);
		expect(readFileSync(join(backups, firstBackup, "Oracle.md"), "utf8")).toBe(legacy);

		const customized = bundled.replace("persist_session: false", "persist_session: true");
		writeFileSync(oracle, customized);
		createExtensionApi();
		expect(readFileSync(oracle, "utf8")).toBe(customized);
		expect(readdirSync(backups)).toEqual([firstBackup]);

		// Simulate an installed revision from an earlier package release.
		writeFileSync(join(agentDirectory, ".pi-suite-presets.json"), '{"Oracle.md":"older-bundled-revision"}');
		createExtensionApi();
		expect(readFileSync(oracle, "utf8")).toBe(bundled);
		const secondBackup = readdirSync(backups).find((name) => name !== firstBackup)!;
		expect(readFileSync(join(backups, secondBackup, "Oracle.md"), "utf8")).toBe(customized);
		expect(readFileSync(join(backups, firstBackup, "Oracle.md"), "utf8")).toBe(legacy);
		createExtensionApi();
		expect(readdirSync(backups)).toHaveLength(2);
		rmSync(oracle);
		createExtensionApi();
		expect(existsSync(oracle)).toBe(false);
	});

	test("settings migrate independently of preset changes and preserve later user choices", () => {
		mkdirSync(join(agentDirectory, "agents"));
		const oracle = join(agentDirectory, "agents", "Oracle.md");
		writeFileSync(oracle, readFileSync(new URL("../presets/agents/Oracle.md", import.meta.url)));
		createExtensionApi();
		const statePath = join(agentDirectory, ".pi-suite-presets.json");
		const revisions = JSON.parse(readFileSync(statePath, "utf8"));
		delete revisions.settingsVersion;
		writeFileSync(statePath, JSON.stringify(revisions));
		const settingsPath = join(agentDirectory, "subagents.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({
				maxConcurrent: 7,
				custom: { enabled: true },
				disableDefaultAgents: false,
				backgroundByDefault: true,
				rememberAgents: true,
				outputTranscript: true,
				workflowsEnabled: true,
				schedulingEnabled: true,
				maxSubagentDepth: 1,
			}),
		);
		createExtensionApi();
		const migrated = JSON.parse(readFileSync(settingsPath, "utf8"));
		expect(migrated).toEqual({
			maxConcurrent: 7,
			custom: { enabled: true },
			disableDefaultAgents: true,
			backgroundByDefault: false,
			rememberAgents: false,
			outputTranscript: false,
			workflowsEnabled: false,
			schedulingEnabled: false,
			maxSubagentDepth: 2,
		});
		const edited = JSON.stringify({ ...migrated, rememberAgents: true, maxSubagentDepth: 4 });
		writeFileSync(settingsPath, edited);
		createExtensionApi();
		expect(readFileSync(settingsPath, "utf8")).toBe(edited);
		const migratedState = JSON.parse(readFileSync(statePath, "utf8"));
		writeFileSync(statePath, JSON.stringify({ ...migratedState, "Oracle.md": "older-revision" }));
		createExtensionApi();
		expect(readFileSync(settingsPath, "utf8")).toBe(edited);
	});

	test("invalid settings are not overwritten or marked migrated and retry after repair", () => {
		mkdirSync(join(agentDirectory, "agents"));
		writeFileSync(join(agentDirectory, "agents", "Oracle.md"), "Old Oracle.");
		const settingsPath = join(agentDirectory, "subagents.json");
		writeFileSync(settingsPath, "{invalid");
		createExtensionApi();
		expect(readFileSync(settingsPath, "utf8")).toBe("{invalid");
		expect(existsSync(join(agentDirectory, ".pi-suite-presets.json"))).toBe(false);
		writeFileSync(settingsPath, '{"maxConcurrent":5}');
		createExtensionApi();
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({
			maxConcurrent: 5,
			schedulingEnabled: false,
		});
		expect(JSON.parse(readFileSync(join(agentDirectory, ".pi-suite-presets.json"), "utf8"))).toHaveProperty(
			"settingsVersion",
			1,
		);
	});

	test("a failed backup leaves the preset untouched and reports the update failure", async () => {
		mkdirSync(join(agentDirectory, "agents"));
		const oracle = join(agentDirectory, "agents", "Oracle.md");
		writeFileSync(oracle, "Old Oracle with custom instructions.");
		writeFileSync(join(agentDirectory, "pi-suite-agent-backups"), "Blocks backup directory creation.");
		const extension = createExtensionApi();
		expect(readFileSync(oracle, "utf8")).toBe("Old Oracle with custom instructions.");
		expect(existsSync(join(agentDirectory, ".pi-suite-presets.json"))).toBe(false);
		const notify = vi.fn();
		await extension.handlers.get("session_start")?.(
			{},
			{
				mode: "print",
				hasUI: true,
				sessionManager: { getBranch: () => [] },
				ui: { notify },
			},
		);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Could not update Suite agent presets:"), "warning");
	});

	test("registers session tools in both main and Oracle sessions", async () => {
		const mainSession = createExtensionApi();
		const oracleSession = createExtensionApi();
		await oracleSession.handlers.get("session_start")?.(
			{ reason: "startup" },
			{
				mode: "print",
				hasUI: false,
				getSystemPrompt: () => '<active_agent name="Oracle"/>\n\nYou are Oracle.',
				sessionManager: { getBranch: () => [] },
				ui: { notify: vi.fn() },
			},
		);
		expect([...mainSession.tools.keys()]).toEqual([SESSION_SEARCH_TOOL_NAME, SESSION_READ_TOOL_NAME]);
		expect([...oracleSession.tools.keys()]).toEqual([SESSION_SEARCH_TOOL_NAME, SESSION_READ_TOOL_NAME]);

		const searchResult = await mainSession.tools
			.get(SESSION_SEARCH_TOOL_NAME)
			?.execute("session-search-call", { query: "" }, undefined, undefined, {
				cwd: "/project/current",
				sessionManager: { getSessionId: () => "current-session", getSessionFile: () => undefined },
			});
		expect(searchResult?.content[0].text).toContain("all working directories");
		expect(searchResult?.content[0].text).toContain("No historical sessions matched");
	});

	test("configures Pushover through Suite and returns to the menu after cancellation", async () => {
		const { commands } = createExtensionApi();
		const select = vi
			.fn()
			.mockResolvedValueOnce("Pushover notifications")
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce("Pushover notifications")
			.mockResolvedValueOnce("off");
		await commands.get("suite")?.handler("", {
			mode: "tui",
			ui: { select, notify: vi.fn() },
		});
		expect(select).toHaveBeenNthCalledWith(2, "Pushover notifications (off)", ["on", "off"]);
		expect(select).toHaveBeenNthCalledWith(3, "Pi Suite Configuration", expect.any(Array));
		expect(JSON.parse(readFileSync(join(agentDirectory, "pi-suite.json"), "utf8"))).toEqual({
			pushover: false,
		});
	});

	test("persists the historical session reader model and thinking level", async () => {
		fauxProvider = registerFauxProvider({
			api: "pi-suite-reader-picker-test",
			provider: "reader-provider",
			models: [{ id: "reader-model", name: "Reader Model", reasoning: true }],
		});
		const model = fauxProvider.getModel();
		const { commands } = createExtensionApi();
		const notify = vi.fn();
		await commands.get("suite")?.handler("", {
			mode: "tui",
			ui: {
				custom: vi.fn().mockResolvedValue({ type: "model", model }),
				select: vi.fn().mockResolvedValueOnce("Session reader model").mockResolvedValueOnce("low"),
				notify,
			},
			modelRegistry: { getAvailable: () => [model] },
		});

		expect(JSON.parse(readFileSync(join(agentDirectory, "pi-suite.json"), "utf8"))).toEqual({
			sessionReadModel: "reader-model:low",
		});
		expect(notify).toHaveBeenCalledWith(
			"Historical session reading will use reader-provider/reader-model with low thinking.",
			"info",
		);
	});

	test("persists the session title model and thinking level", async () => {
		fauxProvider = registerFauxProvider({
			api: "pi-suite-title-picker-test",
			provider: "title-provider",
			models: [{ id: "title-model", name: "Title Model", reasoning: true }],
		});
		const model = fauxProvider.getModel();
		const { commands } = createExtensionApi();
		const notify = vi.fn();
		await commands.get("suite")?.handler("", {
			mode: "tui",
			ui: {
				custom: vi.fn().mockResolvedValue({ type: "model", model }),
				select: vi.fn().mockResolvedValueOnce("Session title model").mockResolvedValueOnce("minimal"),
				notify,
			},
			modelRegistry: { getAvailable: () => [model] },
		});

		expect(JSON.parse(readFileSync(join(agentDirectory, "pi-suite.json"), "utf8"))).toEqual({
			sessionTitleModel: "title-model:minimal",
		});
		expect(notify).toHaveBeenCalledWith(
			"Session titles will use title-provider/title-model with minimal thinking.",
			"info",
		);
	});

	test("returns to the Suite menu when the compaction model picker is cancelled", async () => {
		const { commands } = createExtensionApi();
		const select = vi.fn().mockResolvedValueOnce("Compaction model").mockResolvedValueOnce(undefined);

		await commands.get("suite")?.handler("", {
			mode: "tui",
			ui: {
				custom: vi.fn().mockResolvedValue(undefined),
				select,
				notify: vi.fn(),
			},
			modelRegistry: { getAvailable: () => [] },
		});

		expect(select).toHaveBeenNthCalledWith(1, "Pi Suite Configuration", [
			"Compaction model",
			"Session reader model",
			"Session title model",
			"Pushover notifications",
			"Setup agents",
		]);
		expect(select).toHaveBeenNthCalledWith(2, "Pi Suite Configuration", [
			"Compaction model",
			"Session reader model",
			"Session title model",
			"Pushover notifications",
			"Setup agents",
		]);
	});

	test("generates a title only after the first agent end", async () => {
		fauxProvider = registerFauxProvider({
			api: "pi-suite-title-test",
			provider: "title-provider",
			models: [{ id: "title-model", name: "Title Model", reasoning: true }],
		});
		const model = fauxProvider.getModel();
		const prompts: string[] = [];
		fauxProvider.setResponses([
			(context) => {
				prompts.push(String(context.messages[0]?.content));
				return fauxAssistantMessage('"Initial authentication plan"');
			},
		]);
		const branch: any[] = [
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "Design authentication" }] },
			},
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "Use passkeys" }] },
			},
		];
		const extension = createExtensionApi();
		const context = {
			mode: "tui",
			hasUI: true,
			model,
			modelRegistry: {
				getAvailable: () => [model],
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "faux-key" }),
			},
			sessionManager: { getBranch: () => branch },
			ui: { notify: vi.fn() },
		};

		await extension.handlers.get("agent_end")?.({ messages: [] }, context);
		expect(extension.setSessionName).toHaveBeenLastCalledWith("Initial authentication plan");

		branch.push(
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "Now plan the deployment rollout" }] },
			},
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "Use staged deployment" }] },
			},
		);
		await extension.handlers.get("agent_end")?.({ messages: [] }, context);

		expect(extension.setSessionName).toHaveBeenCalledTimes(1);
		expect(extension.setSessionName).toHaveBeenLastCalledWith("Initial authentication plan");
		expect(prompts).toHaveLength(1);
	});

	test("keeps session reading fail-closed when its persisted model setting is invalid", async () => {
		writeFileSync(
			join(agentDirectory, "pi-suite.json"),
			JSON.stringify({ sessionReadModel: "reader-model:unsupported" }),
			"utf8",
		);
		const { tools } = createExtensionApi();
		const result = tools
			.get(SESSION_READ_TOOL_NAME)
			?.execute(
				"session-read-call",
				{ session_id: "historical", question: "What happened?" },
				undefined,
				undefined,
				{},
			);

		await expect(result).rejects.toThrow("sessionReadModel");
	});

	test("persists a selected model across sessions and uses it for real native compaction", async () => {
		fauxProvider = registerFauxProvider({
			api: "pi-suite-compaction-test",
			provider: "test-provider",
			models: [{ id: "summary-model", name: "Summary Model", reasoning: true }],
		});
		const model = fauxProvider.getModel();
		let request:
			| {
					modelId: string;
					reasoning: unknown;
					headers: unknown;
					prompt: string;
			  }
			| undefined;
		fauxProvider.setResponses([
			(context, options, _state, requestedModel) => {
				const firstMessage = context.messages[0];
				const summarizationOptions = options as { reasoning?: unknown; headers?: unknown } | undefined;
				request = {
					modelId: requestedModel.id,
					reasoning: summarizationOptions?.reasoning,
					headers: summarizationOptions?.headers,
					prompt:
						firstMessage?.role === "user" && typeof firstMessage.content !== "string"
							? firstMessage.content[0]?.type === "text"
								? firstMessage.content[0].text
								: ""
							: "",
				};
				return fauxAssistantMessage("Summary generated by the selected model");
			},
		]);

		const settingsPath = join(agentDirectory, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }), "utf8");
		const firstSession = createExtensionApi();
		const notify = vi.fn();
		const context = {
			mode: "tui",
			hasUI: true,
			getSystemPrompt: () => "You are Pi's main coding agent.",
			ui: {
				custom: vi.fn().mockResolvedValue({ type: "model", model }),
				select: vi.fn().mockResolvedValueOnce("Compaction model").mockResolvedValueOnce("high"),
				notify,
			},
			modelRegistry: {
				getAvailable: () => [model],
				find: (provider: string, modelId: string) =>
					provider === model.provider && modelId === model.id ? model : undefined,
				getApiKeyAndHeaders: async () => ({
					ok: true,
					apiKey: "faux-key",
					headers: { "x-keep": "present", "x-empty": "", "x-deleted": null },
				}),
			},
			sessionManager: { getBranch: () => [] },
		};

		await firstSession.commands.get("suite")?.handler("", context);

		expect(JSON.parse(readFileSync(join(agentDirectory, "pi-suite.json"), "utf8"))).toEqual({
			compactionModel: "summary-model:high",
		});
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ theme: "dark" });

		const nextSession = createExtensionApi();
		for (const reason of ["startup", "reload", "resume"]) {
			notify.mockClear();
			await nextSession.handlers.get("session_start")?.({ reason }, context);
			expect(notify).toHaveBeenCalledWith("Compaction model: summary-model (high thinking).", "info");
		}

		const signal = new AbortController().signal;
		const event = {
			preparation: {
				firstKeptEntryId: "kept-entry",
				messagesToSummarize: [
					{
						role: "user",
						content: [{ type: "text", text: "Keep this important decision." }],
						timestamp: Date.now(),
					},
				],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 100,
				fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
				settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 100 },
			},
			branchEntries: [],
			customInstructions: "Focus on decisions",
			signal,
		};

		const result = await nextSession.handlers.get("session_before_compact")?.(event, context);

		expect(result.compaction.summary).toContain("Summary generated by the selected model");
		expect(result.compaction.firstKeptEntryId).toBe("kept-entry");
		expect(request).toMatchObject({ modelId: "summary-model", reasoning: "high" });
		expect(request?.headers).toEqual({ "x-keep": "present", "x-empty": "" });
		expect(request?.prompt).toContain("Focus on decisions");
		expect(fauxProvider.state.callCount).toBe(1);

		notify.mockClear();
		await nextSession.handlers.get("session_compact")?.(
			{
				fromExtension: true,
				compactionEntry: result.compaction,
				reason: "manual",
				willRetry: false,
			},
			context,
		);
		// Pi rebuilds the chat immediately after session_compact, so the extension
		// must wait until the next event-loop turn before showing the notification.
		expect(notify).not.toHaveBeenCalled();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(notify).toHaveBeenCalledWith(
			"Compacted session with test-provider/summary-model (high thinking).",
			"info",
		);
	});
});
