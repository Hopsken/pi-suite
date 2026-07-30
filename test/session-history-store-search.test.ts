import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	createSessionToolHarness,
	searchContext,
	TEST_TIMESTAMP,
	userEntry,
	writeSession,
} from "./session-history-fixtures.ts";

describe("platform-backed session history", () => {
	let agentDirectory: string;
	let previousAgentDirectory: string | undefined;

	beforeEach(() => {
		agentDirectory = mkdtempSync(join(tmpdir(), "pi-suite-history-"));
		previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDirectory;
	});

	afterEach(() => {
		if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
		rmSync(agentDirectory, { recursive: true, force: true });
	});

	test("returns active-branch evidence across cwd values while excluding the executing session", async () => {
		const historyOnePath = writeSession(agentDirectory, {
			id: "history-one",
			cwd: "/project/one",
			entries: [
				userEntry("root", null, "shared evidence"),
				userEntry("abandoned", "root", "abandoned-only evidence"),
				userEntry("active", "root", "active-only evidence"),
				{
					type: "compaction",
					id: "compact",
					parentId: "active",
					timestamp: TEST_TIMESTAMP,
					summary: "active summary",
					firstKeptEntryId: "active",
					tokensBefore: 100,
					details: { readFiles: ["src/active.ts"] },
				},
			],
		});
		writeSession(agentDirectory, {
			id: "history-two",
			cwd: "/project/two",
			entries: [userEntry("other", null, "shared evidence")],
		});
		const tools = createSessionToolHarness();

		const global = await tools.search({ query: '"shared evidence"' }, searchContext("/project/one"));
		expect(global.details.sessions.map((session) => session.sessionId)).toEqual(["history-one", "history-two"]);
		expect(global.details.sessions.every((session) => session.cwd.startsWith("/project/"))).toBe(true);

		const active = await tools.search({ query: "active-only cwd:." }, searchContext("/project/one"));
		expect(active.details.sessions.map((session) => session.sessionId)).toEqual(["history-one"]);
		expect(active.content[0].text).toContain("active-only evidence");

		const abandoned = await tools.search({ query: "abandoned-only" }, searchContext("/project/one"));
		expect(abandoned.details.sessions).toEqual([]);

		const file = await tools.search({ query: "file:src/active.ts" }, searchContext("/project/one"));
		expect(file.details.sessions.map((session) => session.sessionId)).toEqual(["history-one"]);

		const excludedById = await tools.search(
			{ query: "id:history-one" },
			searchContext("/project/one", "history-one"),
		);
		expect(excludedById.details.sessions).toEqual([]);

		const excludedByPath = await tools.search(
			{ query: "id:history" },
			searchContext("/project/one", "different-id", historyOnePath),
		);
		expect(excludedByPath.details.sessions.map((session) => session.sessionId)).toEqual(["history-two"]);
	});

	test("returns safe partial results and warnings for malformed parent chains", async () => {
		writeSession(agentDirectory, {
			id: "cycle-session",
			cwd: "/project/cycle",
			entries: [userEntry("a", "b", "first"), userEntry("b", "a", "second")],
		});
		writeSession(agentDirectory, {
			id: "broken-session",
			cwd: "/project/broken",
			entries: [userEntry("leaf", "missing", "partial evidence")],
		});
		const tools = createSessionToolHarness();

		const cycle = await tools.search({ query: "first" }, searchContext("/project/cycle"));
		expect(cycle.details.sessions.map((session) => session.sessionId)).toEqual(["cycle-session"]);
		expect(cycle.details.incomplete).toBe(true);
		expect(cycle.content[0].text).toContain("Cycle detected");

		const broken = await tools.search({ query: '"partial evidence"' }, searchContext("/project/broken"));
		expect(broken.details.sessions.map((session) => session.sessionId)).toEqual(["broken-session"]);
		expect(broken.details.incomplete).toBe(true);
		expect(broken.content[0].text).toContain("Broken active-path parent");
	});

	test("composes platform metadata, model, tool, and date filters", async () => {
		writeSession(agentDirectory, {
			id: "filtered-session",
			cwd: "/Project/CaseSensitive",
			entries: [
				{
					type: "session_info",
					id: "named",
					parentId: null,
					timestamp: TEST_TIMESTAMP,
					name: "Queue Investigation",
				},
				{
					type: "message",
					id: "tool-call",
					parentId: "named",
					timestamp: TEST_TIMESTAMP,
					message: {
						role: "assistant",
						provider: "reader-provider",
						model: "reader-model",
						content: [
							{ type: "text", text: "Inspected the queue implementation." },
							{ type: "toolCall", id: "call", name: "read", arguments: { path: "src/Queue.ts" } },
						],
						stopReason: "toolUse",
						timestamp: Date.parse(TEST_TIMESTAMP),
					},
				},
			],
		});

		const tools = createSessionToolHarness();
		const result = await tools.search(
			{
				query: 'name:"queue investigation" model:reader-provider/reader-model tool:read file:src/Queue.ts after:2025-01-01 before:2027-01-01 created_after:2025-01-01 created_before:2027-01-01',
			},
			searchContext("/Project/CaseSensitive"),
		);
		expect(result.details.sessions.map((session) => session.sessionId)).toEqual(["filtered-session"]);

		const wrongCase = await tools.search({ query: "file:src/queue.ts" }, searchContext("/Project/CaseSensitive"));
		expect(process.platform === "win32" ? wrongCase.details.sessions.length : 0).toBe(
			wrongCase.details.sessions.length,
		);
		await expect(tools.search({ query: "", limit: 51 }, searchContext("/Project/CaseSensitive"))).rejects.toThrow(
			"1 to 50",
		);
	});

	test("recovers legacy evidence despite an incomplete final record", async () => {
		writeSession(agentDirectory, {
			id: "legacy-session",
			cwd: "/project/legacy",
			version: 0,
			entries: [
				{
					type: "message",
					timestamp: TEST_TIMESTAMP,
					message: {
						role: "user",
						content: [{ type: "text", text: "legacy evidence" }],
						timestamp: Date.parse(TEST_TIMESTAMP),
					},
				},
			],
			trailingContent: '{"type":"message"',
		});
		const tools = createSessionToolHarness();
		const firstRead = await tools.search({ query: "legacy" }, searchContext("/project/legacy"));
		const secondRead = await tools.search({ query: "legacy" }, searchContext("/project/legacy"));

		expect(firstRead.details.sessions.map((session) => session.sessionId)).toEqual(["legacy-session"]);
		expect(secondRead.content[0].text).toContain("legacy evidence");
	});
});
