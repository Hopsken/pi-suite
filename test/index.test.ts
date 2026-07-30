import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type FauxProviderRegistration, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import piSuite, {
	ORACLE_FINDER_TOOL_NAME,
	ORACLE_LIBRARIAN_TOOL_NAME,
	SESSION_READ_TOOL_NAME,
	SESSION_SEARCH_TOOL_NAME,
} from "../src/index.ts";

type Handler = (event: any, context: any) => any;
type ToolHandler = (...args: any[]) => any;

const ORACLE_SYSTEM_PROMPT = '<active_agent name="Oracle"/>\n\nYou are Oracle.';

function createExtensionApi() {
	const commands = new Map<string, { handler: Handler }>();
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, { execute: ToolHandler }>();
	const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
	const setSessionName = vi.fn();
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
		appendEntry: vi.fn(),
		setSessionName,
		getActiveTools: vi.fn(() => Array.from(tools.keys())),
		getAllTools: vi.fn(() => Array.from(tools.keys(), (name) => ({ name }))),
		setActiveTools: vi.fn(),
		events: {
			on(channel: string, handler: (data: unknown) => void) {
				const listeners = eventHandlers.get(channel) ?? new Set();
				listeners.add(handler);
				eventHandlers.set(channel, listeners);
				return () => listeners.delete(handler);
			},
			emit(channel: string, data: unknown) {
				for (const handler of eventHandlers.get(channel) ?? []) handler(data);
			},
		},
	};

	piSuite(pi as never);
	return { commands, handlers, tools, events: pi.events, setSessionName };
}

async function createOracleExtensionApi() {
	const extension = createExtensionApi();
	await extension.handlers.get("session_start")?.(
		{ reason: "startup" },
		{
			mode: "print",
			hasUI: false,
			getSystemPrompt: () => ORACLE_SYSTEM_PROMPT,
			sessionManager: { getBranch: () => [] },
			ui: { notify: vi.fn() },
		},
	);
	return extension;
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
		expect(explorePreset).toContain("workspace-relative file paths and line numbers or ranges");
		const librarianPath = join(agentDirectory, "agents", "Librarian.md");
		const librarianPreset = readFileSync(librarianPath, "utf8");
		expect(librarianPreset).toContain("read-only codebase-understanding specialist");
		expect(librarianPreset).toContain("model: openai-codex/gpt-5.6-sol");
		expect(librarianPreset).toContain("thinking: off");
		expect(librarianPreset).toContain("max_turns: 50");
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
		expect(oraclePreset).toContain("workspace-relative file paths and line numbers or ranges");
		expect(JSON.parse(readFileSync(join(agentDirectory, "subagents.json"), "utf8"))).toEqual({
			maxConcurrent: 8,
			disableDefaultAgents: true,
		});
		expect(notify).toHaveBeenCalledWith(
			"Installed 3 presets. Upstream default agents are disabled globally. Run /reload to use the presets.",
			"info",
		);

		const customizedExplore = "---\ndescription: Custom Explore\n---\nKeep this definition.\n";
		const customizedLibrarian = "---\ndescription: Custom Librarian\n---\nKeep this definition.\n";
		const customizedOracle = "---\ndescription: Custom Oracle\n---\nKeep this definition.\n";
		writeFileSync(explorePath, customizedExplore, "utf8");
		writeFileSync(librarianPath, customizedLibrarian, "utf8");
		writeFileSync(oraclePath, customizedOracle, "utf8");
		notify.mockClear();
		await commands.get("suite")?.handler("", {
			mode: "tui",
			ui: { notify, select: vi.fn().mockResolvedValue("Setup agents") },
		});

		expect(readFileSync(explorePath, "utf8")).toBe(customizedExplore);
		expect(readFileSync(librarianPath, "utf8")).toBe(customizedLibrarian);
		expect(readFileSync(oraclePath, "utf8")).toBe(customizedOracle);
		expect(notify).toHaveBeenCalledWith(
			"All presets were already installed. Left 3 existing definitions unchanged. Upstream default agents are disabled globally. Run /reload to use the presets.",
			"info",
		);
	});

	test("registers session tools globally and Oracle research tools only inside Oracle", async () => {
		const mainSession = createExtensionApi();
		expect(mainSession.tools.has(SESSION_SEARCH_TOOL_NAME)).toBe(true);
		expect(mainSession.tools.has(SESSION_READ_TOOL_NAME)).toBe(true);
		expect(mainSession.tools.has(ORACLE_FINDER_TOOL_NAME)).toBe(false);
		expect(mainSession.tools.has(ORACLE_LIBRARIAN_TOOL_NAME)).toBe(false);

		await mainSession.handlers.get("session_start")?.(
			{ reason: "startup" },
			{
				mode: "print",
				hasUI: false,
				getSystemPrompt: () => "You are Pi's main coding agent.",
				sessionManager: { getBranch: () => [] },
				ui: { notify: vi.fn() },
			},
		);
		expect(mainSession.tools.has(ORACLE_FINDER_TOOL_NAME)).toBe(false);
		expect(mainSession.tools.has(ORACLE_LIBRARIAN_TOOL_NAME)).toBe(false);

		const oracleSession = await createOracleExtensionApi();
		expect(oracleSession.tools.has(SESSION_SEARCH_TOOL_NAME)).toBe(true);
		expect(oracleSession.tools.has(SESSION_READ_TOOL_NAME)).toBe(true);
		expect(oracleSession.tools.has(ORACLE_FINDER_TOOL_NAME)).toBe(true);
		expect(oracleSession.tools.has(ORACLE_LIBRARIAN_TOOL_NAME)).toBe(true);

		const searchResult = await mainSession.tools
			.get(SESSION_SEARCH_TOOL_NAME)
			?.execute("session-search-call", { query: "" }, undefined, undefined, {
				cwd: "/project/current",
				sessionManager: { getSessionId: () => "current-session", getSessionFile: () => undefined },
			});
		expect(searchResult?.content[0].text).toContain("all working directories");
		expect(searchResult?.content[0].text).toContain("No historical sessions matched");
	});

	test("delegates Oracle research to a foreground Explore subagent and returns its result", async () => {
		const { events, tools } = await createOracleExtensionApi();
		let spawnRequest: any;
		events.on("subagents:rpc:spawn", (value) => {
			spawnRequest = value;
			queueMicrotask(() => {
				events.emit(`subagents:rpc:spawn:reply:${spawnRequest.requestId}`, {
					success: true,
					data: { id: "explore-1" },
				});
				events.emit("subagents:completed", {
					id: "explore-1",
					status: "completed",
					result: "The ownership path is src/router.ts:12-40.",
					toolUses: 4,
					durationMs: 120,
				});
			});
		});

		const result = await tools.get(ORACLE_FINDER_TOOL_NAME)?.execute(
			"tool-call-1",
			{
				prompt: "Find the request-routing source of truth and return file-and-line evidence.",
				description: "Trace request routing",
			},
			undefined,
			undefined,
			{},
		);

		expect(spawnRequest).toMatchObject({
			type: "Explore",
			prompt: "Find the request-routing source of truth and return file-and-line evidence.",
			options: {
				description: "Trace request routing",
				isBackground: false,
				inheritContext: false,
			},
		});
		expect(result).toEqual({
			content: [{ type: "text", text: "The ownership path is src/router.ts:12-40." }],
			details: {
				id: "explore-1",
				status: "completed",
				toolUses: 4,
				durationMs: 120,
				tokens: undefined,
			},
		});
	});

	test("delegates Oracle external research to a foreground Librarian subagent and returns its result", async () => {
		const { events, tools } = await createOracleExtensionApi();
		let spawnRequest: any;
		events.on("subagents:rpc:spawn", (value) => {
			spawnRequest = value;
			queueMicrotask(() => {
				events.emit(`subagents:rpc:spawn:reply:${spawnRequest.requestId}`, {
					success: true,
					data: { id: "librarian-1" },
				});
				events.emit("subagents:completed", {
					id: "librarian-1",
					status: "completed",
					result: "Upstream implements the flow in owner/repo at commit abc123.",
					toolUses: 7,
					durationMs: 350,
				});
			});
		});

		const result = await tools.get(ORACLE_LIBRARIAN_TOOL_NAME)?.execute(
			"tool-call-librarian-1",
			{
				prompt: "Inspect owner/repo at v2.0 and explain the request flow with immutable source links.",
				description: "Research upstream flow",
			},
			undefined,
			undefined,
			{},
		);

		expect(spawnRequest).toMatchObject({
			type: "Librarian",
			prompt: "Inspect owner/repo at v2.0 and explain the request flow with immutable source links.",
			options: {
				description: "Research upstream flow",
				isBackground: false,
				inheritContext: false,
			},
		});
		expect(result).toEqual({
			content: [{ type: "text", text: "Upstream implements the flow in owner/repo at commit abc123." }],
			details: {
				id: "librarian-1",
				status: "completed",
				toolUses: 7,
				durationMs: 350,
				tokens: undefined,
			},
		});
	});

	test("stops an in-flight Oracle research subagent when the tool call is cancelled", async () => {
		const { events, tools } = await createOracleExtensionApi();
		let stopRequest: any;
		events.on("subagents:rpc:spawn", (value: any) => {
			queueMicrotask(() => {
				events.emit(`subagents:rpc:spawn:reply:${value.requestId}`, {
					success: true,
					data: { id: "explore-cancelled" },
				});
			});
		});
		events.on("subagents:rpc:stop", (value) => {
			stopRequest = value;
		});
		const controller = new AbortController();
		const result = tools
			.get(ORACLE_FINDER_TOOL_NAME)
			?.execute(
				"tool-call-2",
				{ prompt: "Trace the flow.", description: "Trace flow" },
				controller.signal,
				undefined,
				{},
			);
		await new Promise<void>((resolve) => queueMicrotask(resolve));

		controller.abort(new Error("cancelled by parent"));

		await expect(result).rejects.toThrow("cancelled by parent");
		expect(stopRequest).toMatchObject({ agentId: "explore-cancelled" });
	});

	test("surfaces an Oracle research subagent failure", async () => {
		const { events, tools } = await createOracleExtensionApi();
		events.on("subagents:rpc:spawn", (value: any) => {
			queueMicrotask(() => {
				events.emit(`subagents:rpc:spawn:reply:${value.requestId}`, {
					success: true,
					data: { id: "explore-failed" },
				});
				events.emit("subagents:failed", {
					id: "explore-failed",
					status: "error",
					error: "model request failed",
				});
			});
		});

		const result = tools
			.get(ORACLE_FINDER_TOOL_NAME)
			?.execute("tool-call-3", { prompt: "Trace the flow.", description: "Trace flow" }, undefined, undefined, {});

		await expect(result).rejects.toThrow("model request failed");
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
			"Setup agents",
		]);
		expect(select).toHaveBeenNthCalledWith(2, "Pi Suite Configuration", [
			"Compaction model",
			"Session reader model",
			"Session title model",
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
					prompt: string;
			  }
			| undefined;
		fauxProvider.setResponses([
			(context, options, _state, requestedModel) => {
				const firstMessage = context.messages[0];
				const summarizationOptions = options as { reasoning?: unknown } | undefined;
				request = {
					modelId: requestedModel.id,
					reasoning: summarizationOptions?.reasoning,
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
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "faux-key" }),
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
