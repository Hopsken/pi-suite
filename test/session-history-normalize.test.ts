import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createSessionToolHarness, searchContext, TEST_TIMESTAMP, writeSession } from "./session-history-fixtures.ts";

describe("session_search evidence safety", () => {
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

	test("redacts structured secrets and treats only structured paths as file evidence", async () => {
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
		expect(toolEvidence.content[0].text).toContain("[REDACTED]");
		expect(toolEvidence.content[0].text).not.toContain("token-value-that-must-not-leak");
		expect(toolEvidence.content[0].text).not.toContain("nested-value-that-must-not-leak");
	});

	test("excludes hidden evidence and clearly reports bounded or unknown evidence", async () => {
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
						command: "echo bounded-marker",
						output: `bounded-marker ${"x".repeat(20_000)}`,
						timestamp: Date.parse(TEST_TIMESTAMP),
					},
				},
			],
		});
		const tools = createSessionToolHarness();
		const context = searchContext("/work");

		for (const hidden of ["private-reasoning-marker", "private-image-marker", "hidden-custom-marker"]) {
			const result = await tools.search({ query: hidden }, context);
			expect(result.details.sessions).toEqual([]);
		}

		const bounded = await tools.search({ query: "bounded-marker" }, context);
		expect(bounded.details.incomplete).toBe(true);
		expect(bounded.content[0].text).toContain("Bash output was truncated");
		expect(bounded.content[0].text).toContain("Unknown message role ignored");
	});

	test("stops before searching when the caller has cancelled", async () => {
		const controller = new AbortController();
		controller.abort(new Error("cancel search"));

		await expect(
			createSessionToolHarness().search({ query: "" }, searchContext("/work"), controller.signal),
		).rejects.toThrow("cancel search");
	});
});
