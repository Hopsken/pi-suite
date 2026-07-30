import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createSessionToolHarness, searchContext, TEST_TIMESTAMP, writeSession } from "./session-history-fixtures.ts";

describe("session_search query behavior", () => {
	let agentDirectory: string;
	let previousAgentDirectory: string | undefined;

	beforeEach(() => {
		agentDirectory = mkdtempSync(join(tmpdir(), "pi-suite-query-"));
		previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDirectory;
		writeSession(agentDirectory, {
			id: "query-session",
			cwd: "/project/query with spaces",
			entries: [
				{
					type: "session_info",
					id: "name",
					parentId: null,
					timestamp: TEST_TIMESTAMP,
					name: "My Session",
				},
				{
					type: "message",
					id: "evidence",
					parentId: "name",
					timestamp: TEST_TIMESTAMP,
					message: {
						role: "assistant",
						provider: "reader-provider",
						model: "reader-model",
						content: [
							{ type: "text", text: "ＦＯＯ error: ENOENT while opening the queue." },
							{ type: "toolCall", id: "read-call", name: "read", arguments: { path: "src/Queue.ts" } },
						],
						stopReason: "toolUse",
						timestamp: Date.parse(TEST_TIMESTAMP),
					},
				},
			],
		});
	});

	afterEach(() => {
		if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
		rmSync(agentDirectory, { recursive: true, force: true });
	});

	test("combines normalized text and metadata filters with AND semantics", async () => {
		const result = await createSessionToolHarness().search(
			{
				query: 'foo name:"My Session" cwd:"/project/query with spaces" after:2025-01-01 before:2027-01-01 model:reader-provider/reader-model tool:read file:src/Queue.ts',
			},
			searchContext("/project/query with spaces"),
		);

		expect(result.details.sessions.map((session) => session.sessionId)).toEqual(["query-session"]);
		expect(result.content[0].text).toContain("query-session");
		expect(result.content[0].text).toContain("/project/query with spaces");
	});

	test("searches for a colon inside a quoted phrase instead of treating it as a filter", async () => {
		const result = await createSessionToolHarness().search(
			{ query: '"error: ENOENT"' },
			searchContext("/another/project"),
		);

		expect(result.details.sessions.map((session) => session.sessionId)).toEqual(["query-session"]);
	});

	test.each([
		["unknown filter", "wat:x"],
		["missing filter value", "name:"],
		["unterminated quote", '"broken'],
		["empty phrase", '""'],
		["relative cwd", "cwd:relative"],
		["invalid date", "after:999999999999999999999d"],
		["oversized query", `x${"x".repeat(4096)}`],
	])("rejects an %s rather than changing its meaning", async (_case, query) => {
		await expect(
			createSessionToolHarness().search({ query }, searchContext("/project/query with spaces")),
		).rejects.toThrow();
	});
});
