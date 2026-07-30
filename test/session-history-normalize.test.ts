import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createSessionToolHarness, searchContext, TEST_TIMESTAMP, writeSession } from "./session-history-fixtures.ts";

describe("session_search evidence projection", () => {
	let agentDirectory: string;
	let previousAgentDirectory: string | undefined;

	beforeEach(() => {
		agentDirectory = mkdtempSync(join(tmpdir(), "pi-suite-evidence-"));
		previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDirectory;
	});

	afterEach(() => {
		if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
		rmSync(agentDirectory, { recursive: true, force: true });
	});

	test("preserves structured arguments and treats only structured paths as file evidence", async () => {
		writeSession(agentDirectory, {
			id: "safe-evidence",
			cwd: "/work",
			entries: [
				{
					type: "message",
					id: "tool-call",
					parentId: null,
					timestamp: TEST_TIMESTAMP,
					message: {
						role: "assistant",
						provider: "provider",
						model: "model",
						content: [
							{ type: "text", text: "The conversation mentioned fake.ts." },
							{
								type: "toolCall",
								id: "read-call",
								name: "read",
								arguments: {
									path: "real.ts",
									token: "token-value-that-must-not-leak",
									nested: { clientSecret: "nested-value-that-must-not-leak" },
								},
							},
						],
						stopReason: "toolUse",
						timestamp: Date.parse(TEST_TIMESTAMP),
					},
				},
				{
					type: "message",
					id: "bash",
					parentId: "tool-call",
					timestamp: TEST_TIMESTAMP,
					message: {
						role: "bashExecution",
						command: "cat shell-only.ts",
						output: "shell-only.ts",
						timestamp: Date.parse(TEST_TIMESTAMP),
					},
				},
			],
		});
		const tools = createSessionToolHarness();
		const context = searchContext("/work");

		const structuredFile = await tools.search({ query: "file:real.ts" }, context);
		expect(structuredFile.details.sessions.map((session) => session.sessionId)).toEqual(["safe-evidence"]);

		for (const path of ["fake.ts", "shell-only.ts"]) {
			const unstructuredFile = await tools.search({ query: `file:${path}` }, context);
			expect(unstructuredFile.details.sessions).toEqual([]);
		}

		const toolEvidence = await tools.search({ query: "tool:read" }, context);
		expect(toolEvidence.content[0].text).toContain("token-value-that-must-not-leak");
		expect(toolEvidence.content[0].text).toContain("nested-value-that-must-not-leak");
		const argumentSearch = await tools.search({ query: "token-value-that-must-not-leak" }, context);
		expect(argumentSearch.details.sessions.map((session) => session.sessionId)).toEqual(["safe-evidence"]);
	});

	test("excludes hidden evidence and searches complete visible evidence without diagnostics", async () => {
		writeSession(agentDirectory, {
			id: "bounded-evidence",
			cwd: "/work",
			entries: [
				{
					type: "message",
					id: "assistant",
					parentId: null,
					timestamp: TEST_TIMESTAMP,
					message: {
						role: "assistant",
						provider: "provider",
						model: "model",
						content: [
							{ type: "text", text: "visible evidence" },
							{ type: "thinking", thinking: "private-reasoning-marker" },
							{ type: "image", data: "private-image-marker", mimeType: "image/png" },
						],
						stopReason: "stop",
						timestamp: Date.parse(TEST_TIMESTAMP),
					},
				},
				{
					type: "custom_message",
					id: "hidden-custom",
					parentId: "assistant",
					timestamp: TEST_TIMESTAMP,
					customType: "hidden",
					content: "hidden-custom-marker",
					display: false,
				},
				{
					type: "message",
					id: "future-role",
					parentId: "hidden-custom",
					timestamp: TEST_TIMESTAMP,
					message: { role: "futureRole", timestamp: Date.parse(TEST_TIMESTAMP) },
				},
				{
					type: "message",
					id: "bounded-output",
					parentId: "future-role",
					timestamp: TEST_TIMESTAMP,
					message: {
						role: "bashExecution",
						command: "echo tail-marker",
						output: `${"x".repeat(20_000)} tail-marker`,
						timestamp: Date.parse(TEST_TIMESTAMP),
					},
				},
				{
					type: "compaction",
					id: "large-file-list",
					parentId: "bounded-output",
					timestamp: TEST_TIMESTAMP,
					summary: "",
					firstKeptEntryId: "assistant",
					tokensBefore: 100,
					details: { readFiles: Array.from({ length: 1_000 }, (_, index) => `src/file-${index}.ts`) },
				},
			],
		});
		const tools = createSessionToolHarness();
		const context = searchContext("/work");

		for (const hidden of ["private-reasoning-marker", "private-image-marker", "hidden-custom-marker"]) {
			const result = await tools.search({ query: hidden }, context);
			expect(result.details.sessions).toEqual([]);
		}

		const visible = await tools.search({ query: "tail-marker" }, context);
		expect(visible.details.sessions.map((session) => session.sessionId)).toEqual(["bounded-evidence"]);
		expect(visible.details).toMatchObject({ count: 1, hasMore: false });
		expect(visible.content[0].text).not.toContain("warning");
		expect(visible.content[0].text).not.toContain("incomplete");

		const structured = await tools.search({ query: "file:src/file-999.ts" }, context);
		const structuredSnippet = JSON.parse(structured.content[0].text).sessions[0].matchedEntries[0].snippet;
		expect(structuredSnippet.length).toBeLessThanOrEqual(481);
	});

	test("stops before searching when the caller has cancelled", async () => {
		const controller = new AbortController();
		controller.abort(new Error("cancel search"));

		await expect(
			createSessionToolHarness().search({ query: "" }, searchContext("/work"), controller.signal),
		).rejects.toThrow("cancel search");
	});
});
