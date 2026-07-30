import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type FauxProviderRegistration, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createSessionToolHarness, userEntry, writeSession } from "./session-history-fixtures.ts";

describe("question-directed historical session reading", () => {
	let agentDirectory: string;
	let previousAgentDirectory: string | undefined;
	let faux: FauxProviderRegistration | undefined;

	beforeEach(() => {
		agentDirectory = mkdtempSync(join(tmpdir(), "pi-suite-reader-"));
		previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDirectory;
	});

	afterEach(() => {
		faux?.unregister();
		faux = undefined;
		if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
		rmSync(agentDirectory, { recursive: true, force: true });
	});

	function createContext(
		model: NonNullable<ReturnType<FauxProviderRegistration["getModel"]>>,
		auth:
			| { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
			| { ok: false; error: string } = {
			ok: true,
			apiKey: "reader-key",
			headers: { "x-reader": "yes" },
			env: { READER_ENV: "configured" },
		},
	) {
		return {
			cwd: "/project/reader",
			model,
			modelRegistry: {
				find: (provider: string, modelId: string) =>
					provider === model.provider && modelId === model.id ? model : undefined,
				getApiKeyAndHeaders: vi.fn().mockResolvedValue(auth),
			},
			sessionManager: {
				getSessionId: () => "current-session",
				getSessionFile: () => undefined,
			},
		} as never;
	}

	function selectReaderModel(provider: string, modelId: string, thinkingLevel: string): void {
		writeFileSync(
			join(agentDirectory, "settings.json"),
			JSON.stringify({ piSuite: { sessionReadModel: { provider, modelId, thinkingLevel } } }),
			"utf8",
		);
	}

	test("uses the selected model, complete auth, thinking, citations, and no tools", async () => {
		writeSession(agentDirectory, {
			id: "reader-session",
			cwd: "/project/reader",
			entries: [
				userEntry("entry-one", null, "The team selected the queue because retries are durable."),
				{
					type: "message",
					id: "entry-two",
					parentId: "entry-one",
					timestamp: "2026-01-01T00:00:00.000Z",
					message: {
						role: "assistant",
						provider: "reader-provider",
						model: "reader-model",
						content: [
							{ type: "text", text: "The queue configuration was inspected." },
							{
								type: "toolCall",
								id: "config-call",
								name: "read",
								arguments: { path: "queue.json", apiKey: "reader-secret-that-must-not-leak" },
							},
						],
						stopReason: "toolUse",
						timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
					},
				},
			],
		});
		faux = registerFauxProvider({
			api: "pi-suite-reader-single",
			provider: "reader-provider",
			models: [{ id: "reader-model", reasoning: true }],
		});
		const model = faux.getModel();
		selectReaderModel(model.provider, model.id, "high");
		let request: { tools: unknown; options: Record<string, unknown> | undefined; prompt: string } | undefined;
		faux.setResponses([
			(context, options) => {
				const message = context.messages[0];
				request = {
					tools: context.tools,
					options: options as Record<string, unknown> | undefined,
					prompt: message?.role === "user" && typeof message.content === "string" ? message.content : "",
				};
				return fauxAssistantMessage("Durable retries drove the queue decision. session:reader-session#entry-one");
			},
		]);

		const result = await createSessionToolHarness().read(
			{
				session_id: "reader-sess",
				question: "Why was the queue selected?",
			},
			createContext(model),
		);

		expect(result.content[0].text).toContain("Durable retries drove the queue decision");
		expect(result.content[0].text).toContain("/project/reader");
		expect(result.details).toMatchObject({
			sessionId: "reader-session",
			readerModel: "reader-provider/reader-model",
			inspectedEntries: 2,
		});
		expect(request?.tools).toBeUndefined();
		expect(request?.options).toMatchObject({
			apiKey: "reader-key",
			headers: { "x-reader": "yes" },
			env: { READER_ENV: "configured" },
			reasoning: "high",
		});
		expect(request?.prompt).toContain("The team selected the queue");
		expect(request?.prompt).toContain("reader-secret-that-must-not-leak");
	});

	test("fails closed when the explicitly selected model cannot authenticate", async () => {
		writeSession(agentDirectory, {
			id: "auth-session",
			cwd: "/project/reader",
			entries: [userEntry("auth-entry", null, "Evidence")],
		});
		faux = registerFauxProvider({
			api: "pi-suite-reader-auth",
			provider: "reader-provider",
			models: [{ id: "reader-model", reasoning: true }],
		});
		const model = faux.getModel();
		selectReaderModel(model.provider, model.id, "low");

		await expect(
			createSessionToolHarness().read(
				{
					session_id: "auth-session",
					question: "What happened?",
				},
				createContext(model, { ok: false, error: "not logged in" }),
			),
		).rejects.toThrow("not logged in");
		expect(faux.state.callCount).toBe(0);
	});

	test("hierarchically examines chronological evidence that does not fit one call", async () => {
		writeSession(agentDirectory, {
			id: "long-session",
			cwd: "/project/reader",
			entries: [
				userEntry("long-one", null, `marker-one ${"a".repeat(30_000)} marker-one-tail`),
				userEntry("long-two", "long-one", `marker-two ${"b".repeat(12_000)}`),
				userEntry("long-three", "long-two", `marker-three ${"c".repeat(12_000)}`),
			],
		});
		faux = registerFauxProvider({
			api: "pi-suite-reader-long",
			provider: "reader-provider",
			models: [{ id: "reader-model", reasoning: true, contextWindow: 8_000, maxTokens: 512 }],
		});
		const model = faux.getModel();
		const prompts: string[] = [];
		const response = (context: any) => {
			const message = context.messages[0];
			prompts.push(message?.role === "user" && typeof message.content === "string" ? message.content : "");
			return fauxAssistantMessage(
				"Relevant evidence. session:long-session#long-one session:long-session#long-two session:long-session#long-three",
			);
		};
		faux.setResponses(Array.from({ length: 16 }, () => response));

		const result = await createSessionToolHarness("low").read(
			{ session_id: "long-session", question: "What markers were recorded?" },
			createContext(model),
		);

		expect(prompts.join("\n")).toContain("marker-one");
		expect(prompts.join("\n")).toContain("marker-one-tail");
		expect(prompts.join("\n")).toContain("marker-two");
		expect(prompts.join("\n")).toContain("marker-three");
		expect(result.content[0].text).toContain("Relevant evidence");
		expect(result.details).toMatchObject({ inspectedEntries: 3 });
	});

	test("fails on length-limited output and propagates cancellation", async () => {
		writeSession(agentDirectory, {
			id: "stop-session",
			cwd: "/project/reader",
			entries: [userEntry("stop-entry", null, "Evidence")],
		});
		faux = registerFauxProvider({
			api: "pi-suite-reader-stop",
			provider: "reader-provider",
			models: [{ id: "reader-model", reasoning: true }],
		});
		const model = faux.getModel();
		faux.setResponses([
			fauxAssistantMessage("Partial answer. session:stop-session#stop-entry", { stopReason: "length" }),
		]);
		const tools = createSessionToolHarness();
		await expect(
			tools.read({ session_id: "stop-session", question: "What happened?" }, createContext(model)),
		).rejects.toThrow("length limit");

		const controller = new AbortController();
		faux.setResponses([
			() => {
				controller.abort(new Error("cancelled by test"));
				return fauxAssistantMessage("", { stopReason: "aborted" });
			},
		]);
		await expect(
			tools.read(
				{ session_id: "stop-session", question: "What happened?" },
				createContext(model),
				controller.signal,
			),
		).rejects.toThrow("cancelled by test");
	});

	test("rejects empty questions, the current session, and ambiguous prefixes before inference", async () => {
		writeSession(agentDirectory, {
			id: "ambiguous-one",
			cwd: "/project/reader",
			entries: [userEntry("one", null, "One")],
		});
		writeSession(agentDirectory, {
			id: "ambiguous-two",
			cwd: "/project/reader",
			entries: [userEntry("two", null, "Two")],
		});
		faux = registerFauxProvider({
			api: "pi-suite-reader-validation",
			provider: "reader-provider",
			models: [{ id: "reader-model" }],
		});
		const context = createContext(faux.getModel());
		const tools = createSessionToolHarness();
		await expect(tools.read({ session_id: "ambiguous", question: " " }, context)).rejects.toThrow(
			"question is required",
		);
		await expect(tools.read({ session_id: "current-session", question: "What happened?" }, context)).rejects.toThrow(
			"currently executing",
		);
		await expect(tools.read({ session_id: "ambiguous", question: "What happened?" }, context)).rejects.toThrow(
			"matching IDs: ambiguous-one, ambiguous-two",
		);
		expect(faux.state.callCount).toBe(0);
	});

	test("prefers a complete historical ID over another session with the same prefix", async () => {
		writeSession(agentDirectory, {
			id: "exact",
			cwd: "/project/reader",
			entries: [userEntry("exact-entry", null, "Exact evidence")],
		});
		writeSession(agentDirectory, {
			id: "exact-longer",
			cwd: "/project/reader",
			entries: [userEntry("longer-entry", null, "Other evidence")],
		});
		faux = registerFauxProvider({
			api: "pi-suite-reader-exact-id",
			provider: "reader-provider",
			models: [{ id: "reader-model" }],
		});
		const model = faux.getModel();
		faux.setResponses([fauxAssistantMessage("Exact answer. session:exact#exact-entry")]);

		const result = await createSessionToolHarness().read(
			{ session_id: "exact", question: "What is the evidence?" },
			createContext(model),
		);

		expect(result.details.sessionId).toBe("exact");
	});
});
