import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { searchHistoricalSessions } from "../src/session-history/search.ts";
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
		expect(global.details).toMatchObject({ count: 2, hasMore: false });
		const envelope = JSON.parse(global.content[0].text);
		expect(envelope).toMatchObject({ count: 2, hasMore: false });
		expect(
			envelope.sessions.map(({ sessionId, cwd }: { sessionId: string; cwd: string }) => ({ sessionId, cwd })),
		).toEqual([
			{ sessionId: "history-one", cwd: "/project/one" },
			{ sessionId: "history-two", cwd: "/project/two" },
		]);

		const limited = await tools.search({ query: '"shared evidence"', limit: 1 }, searchContext("/project/one"));
		expect(limited.details.sessions).toHaveLength(1);
		expect(limited.details).toMatchObject({ count: 1, hasMore: true });

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

	test("filters persisted repository identity across worktrees", async () => {
		for (const [id, cwd, remote, commonGitDir] of [
			["main-worktree", "/project/main", "github.com/hopsken/pi-suite", "/git/pi-suite"],
			["feature-worktree", "/project/feature", "git@github.com:Hopsken/pi-suite.git", "/git/pi-suite"],
			["other-repository", "/project/other", "github.com/other/repository", "/git/other"],
		] as const)
			writeSession(agentDirectory, {
				id,
				cwd,
				entries: [
					{
						type: "custom",
						id: `${id}-repo`,
						parentId: null,
						timestamp: TEST_TIMESTAMP,
						customType: "pi-suite-repository",
						data: { worktreeRoot: cwd, commonGitDir, remote },
					},
				],
			});
		writeSession(agentDirectory, {
			id: "no-remote-worktree",
			cwd: "/project/no-remote",
			entries: [
				{
					type: "custom",
					id: "no-remote-repo",
					parentId: null,
					timestamp: TEST_TIMESTAMP,
					customType: "pi-suite-repository",
					data: { worktreeRoot: "/project/no-remote", commonGitDir: "/git/pi-suite" },
				},
			],
		});
		writeSession(agentDirectory, {
			id: "legacy-without-repository",
			cwd: "/project/legacy",
			entries: [userEntry("legacy-entry", null, "old evidence")],
		});

		const explicit = await createSessionToolHarness().search(
			{ query: "repo:hopsken/pi-suite" },
			searchContext("/project/unrelated"),
		);
		expect(explicit.details.sessions.map((session) => session.sessionId).sort()).toEqual([
			"feature-worktree",
			"main-worktree",
		]);
		expect(explicit.details.sessions.every((session) => session.repo === "github.com/hopsken/pi-suite")).toBe(true);

		const current = await searchHistoricalSessions({
			query: "repo:.",
			invokingCwd: "/project/another-worktree",
			invokingRepository: {
				worktreeRoot: "/project/another-worktree",
				commonGitDir: "/git/pi-suite",
				remote: "github.com/hopsken/pi-suite",
			},
		});
		expect(current.sessions.map((session) => session.sessionId).sort()).toEqual([
			"feature-worktree",
			"main-worktree",
			"no-remote-worktree",
		]);

		await expect(
			createSessionToolHarness().search({ query: "repo:." }, searchContext("/not/a/repository")),
		).rejects.toThrow("identifiable Git repository");
	});

	test("skips malformed parent chains without adding diagnostics to valid results", async () => {
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
		writeSession(agentDirectory, {
			id: "valid-session",
			cwd: "/project/valid",
			entries: [userEntry("valid", null, "valid evidence")],
		});
		const tools = createSessionToolHarness();

		const cycle = await tools.search({ query: "first" }, searchContext("/project/cycle"));
		expect(cycle.details.sessions).toEqual([]);

		const broken = await tools.search({ query: '"partial evidence"' }, searchContext("/project/broken"));
		expect(broken.details.sessions).toEqual([]);

		const valid = await tools.search({ query: '"valid evidence"' }, searchContext("/project/valid"));
		expect(valid.details.sessions.map((session) => session.sessionId)).toEqual(["valid-session"]);
		expect(valid.content[0].text).not.toContain("warning");
		expect(valid.content[0].text).not.toContain("incomplete");
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
