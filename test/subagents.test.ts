import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	type Context,
	createProvider,
	fauxAssistantMessage,
	fauxToolCall,
	InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { type FauxProviderRegistration, getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { installAgentPresets } from "../src/agent-presets.ts";
import piSuite from "../src/index.ts";
import { searchHistoricalSessions } from "../src/session-history/search.ts";

function toolResults(context: Context): string[] {
	return context.messages
		.filter((message) => message.role === "toolResult")
		.map((message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"));
}

describe("Suite agents through the upstream agent loop", () => {
	let directory: string;
	let previousAgentDirectory: string | undefined;
	let faux: FauxProviderRegistration;
	let session: AgentSession | undefined;
	let releaseChild: (() => void) | undefined;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "pi-suite-subagents-"));
		previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = directory;
		installAgentPresets();
		writeFileSync(
			join(directory, "settings.json"),
			JSON.stringify({
				compaction: { enabled: false },
				retry: { enabled: false },
				// Exercise the real Suite extension inside Oracle. Web providers are tested separately.
				extensions: [resolve("src/index.ts")],
			}),
		);
		faux = registerFauxProvider({
			api: "pi-suite-subagents-test",
			provider: "openai-codex",
			models: [{ id: "gpt-5.6-terra" }, { id: "gpt-5.6-sol" }],
		});
	});

	afterEach(async () => {
		releaseChild?.();
		releaseChild = undefined;
		if (session) {
			await session.abort();
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
			session = undefined;
		}
		faux.unregister();
		if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
		rmSync(directory, { recursive: true, force: true });
	});

	async function createParent(): Promise<AgentSession> {
		const { default: subagents } = await vi.importActual<{ default: ExtensionFactory }>(
			resolve("node_modules/@tintinweb/pi-subagents/src/index.ts"),
		);
		const api = getApiProvider(faux.api)!;
		const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
		modelRuntime.registerNativeProvider(
			createProvider({
				id: "openai-codex",
				auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } },
				models: faux.models,
				api,
			}),
		);
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		const resourceLoader = new DefaultResourceLoader({
			cwd: directory,
			agentDir: directory,
			settingsManager,
			extensionFactories: [piSuite, subagents],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPromptOverride: () => "Suite parent test.",
		});
		await resourceLoader.reload();
		expect(resourceLoader.getExtensions().errors).toEqual([]);
		const created = await createAgentSession({
			cwd: directory,
			agentDir: directory,
			model: faux.getModel(),
			modelRuntime,
			thinkingLevel: "off",
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(directory),
			tools: ["Agent"],
		});
		session = created.session;
		await session.bindExtensions({});
		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("SubagentWorkflow");
		const agentTool = session.getToolDefinition("Agent");
		expect(agentTool).toBeDefined();
		expect(agentTool?.parameters).toHaveProperty("properties.subagent_type");
		expect(agentTool?.parameters).not.toHaveProperty("properties.schedule");
		return session;
	}

	test.each(["Explore", "Librarian", "Oracle"])(
		"%s blocks even when background is requested, returns once, and obeys retention",
		async (type) => {
			let parentCalls = 0;
			let oracleCalls = 0;
			const childTypes: string[] = [];
			let markChildEntered!: () => void;
			const childEntered = new Promise<void>((resolve) => {
				markChildEntered = resolve;
			});
			const childGate = new Promise<void>((resolve) => {
				releaseChild = resolve;
			});
			const answer = async (context: Context) => {
				const active = /<active_agent name="([^"]+)"\/>/.exec(context.systemPrompt ?? "")?.[1];
				if (active === "Explore" || active === "Librarian") {
					childTypes.push(active);
					expect(context.tools?.map((tool) => tool.name)).not.toContain("Agent");
					markChildEntered();
					await childGate;
					return fauxAssistantMessage(`${active} evidence for durable retry safety.`);
				}
				if (active === "Oracle") {
					oracleCalls++;
					const names = context.tools?.map((tool) => tool.name) ?? [];
					expect(names).toContain("Agent");
					expect(names).not.toContain("edit");
					expect(names).not.toContain("write");
					if (oracleCalls <= 2) {
						return fauxAssistantMessage(
							fauxToolCall("Agent", {
								subagent_type: oracleCalls === 1 ? "Explore" : "Librarian",
								prompt: "Find durable retry evidence.",
								description: "Find retry evidence",
								run_in_background: true,
							}),
							{ stopReason: "toolUse" },
						);
					}
					expect(toolResults(context)).toHaveLength(2);
					expect(toolResults(context)[0]).toContain("Explore evidence");
					expect(toolResults(context)[1]).toContain("Librarian evidence");
					return fauxAssistantMessage("Oracle conclusion: durable retry safety.");
				}
				if (context.systemPrompt?.includes("session titling assistant"))
					return fauxAssistantMessage("Oracle review");
				parentCalls++;
				if (parentCalls === 1) {
					return fauxAssistantMessage(
						fauxToolCall("Agent", {
							subagent_type: type,
							prompt: "Review durable retry safety.",
							description: "Review retry safety",
							run_in_background: true,
						}),
						{ stopReason: "toolUse" },
					);
				}
				expect(toolResults(context)).toHaveLength(1);
				expect(toolResults(context)[0]).toContain(type === "Oracle" ? "Oracle conclusion" : `${type} evidence`);
				return fauxAssistantMessage("Parent received the completed evidence.");
			};
			faux.setResponses(Array.from({ length: 15 }, () => answer));
			// Migrate a pre-tracking installation before Subagents reads its configuration.
			rmSync(join(directory, ".pi-suite-presets.json"));
			writeFileSync(
				join(directory, "subagents.json"),
				JSON.stringify({ workflowsEnabled: true, schedulingEnabled: true, maxSubagentDepth: 1 }),
			);
			writeFileSync(
				join(directory, "agents", `${type}.md`),
				"---\ndescription: Outdated preset\nrun_in_background: true\npersist_session: true\n---\nOutdated prompt.\n",
			);
			const parent = await createParent();
			const prompt = parent.prompt(`Use ${type} to review retries.`);
			await childEntered;
			expect(parentCalls).toBe(1);
			expect(parent.messages.filter((message) => message.role === "toolResult")).toHaveLength(0);
			releaseChild!();
			await prompt;
			// Upstream holds completion nudges for 200ms. Let a duplicate surface before asserting.
			await new Promise((resolve) => setTimeout(resolve, 350));
			expect(parentCalls).toBe(2);
			expect(parent.messages.map((message) => message.role)).toEqual([
				"user",
				"assistant",
				"toolResult",
				"assistant",
			]);
			expect(childTypes).toEqual(type === "Oracle" ? ["Explore", "Librarian"] : [type]);
			expect(oracleCalls).toBe(type === "Oracle" ? 3 : 0);

			const history = await searchHistoricalSessions({ query: '"durable retry"', invokingCwd: directory });
			expect(history.sessions).toHaveLength(0);
			const files = existsSync(join(directory, "sessions"))
				? readdirSync(join(directory, "sessions"), { recursive: true }).filter((file) =>
						String(file).endsWith(".jsonl"),
					)
				: [];
			expect(files).toHaveLength(0);
			const outputDirectory = join(
				tmpdir(),
				`pi-subagents-${process.getuid?.() ?? 0}`,
				directory.replace(/^\/+|\/+$/g, "").replaceAll("/", "-"),
			);
			expect(existsSync(outputDirectory)).toBe(false);
		},
		20_000,
	);
});
