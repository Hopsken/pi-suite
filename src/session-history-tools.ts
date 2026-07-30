import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseSessionQuery } from "./session-history/query.ts";
import { readHistoricalSession } from "./session-history/read.ts";
import { searchHistoricalSessions } from "./session-history/search.ts";
import type { SessionReadModelSelection } from "./state.ts";

export const SESSION_SEARCH_TOOL_NAME = "session_search";
export const SESSION_READ_TOOL_NAME = "session_read";

function formatSearchResult(query: string, result: Awaited<ReturnType<typeof searchHistoricalSessions>>): string {
	const parsed = parseSessionQuery(query);
	const cwdFilter = parsed.clauses.find((clause) => clause.name === "cwd");
	const scope = cwdFilter
		? `Search was restricted by cwd:${cwdFilter.value}.`
		: "Search covered historical sessions from all working directories.";
	const noMatches = result.sessions.length === 0 ? " No historical sessions matched." : "";
	return JSON.stringify(
		{
			scope: `${scope}${noMatches}`,
			incomplete: result.incomplete,
			warnings: result.warnings,
			results: result.sessions,
		},
		null,
		2,
	);
}

/** Register question-directed historical Pi session retrieval tools. */
export function registerSessionHistoryTools(
	pi: ExtensionAPI,
	getReaderModel: () => SessionReadModelSelection | undefined,
): void {
	pi.registerTool({
		name: SESSION_SEARCH_TOOL_NAME,
		label: "Session Search",
		description:
			"Search historical Pi sessions with deterministic text and metadata filters. Search is global across all historical working directories by default; add cwd:. for the exact current directory. The executing session is always excluded. Returns source session IDs, cwd values, metadata, and short active-branch evidence snippets, never full transcripts.",
		parameters: Type.Object({
			query: Type.String({
				description:
					"Bare terms and quoted phrases plus id:, name:, cwd:, after:, before:, created_after:, created_before:, model:, tool:, and structured file: filters. Conditions use AND. May be empty for recent sessions.",
			}),
			limit: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 50, description: "Maximum sessions to return; defaults to 10." }),
			),
		}),
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			const result = await searchHistoricalSessions({
				query: params.query,
				limit: params.limit,
				invokingCwd: ctx.cwd,
				currentSessionId: ctx.sessionManager.getSessionId(),
				currentSessionFile: ctx.sessionManager.getSessionFile(),
				signal,
			});
			return {
				content: [{ type: "text", text: formatSearchResult(params.query, result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: SESSION_READ_TOOL_NAME,
		label: "Session Read",
		description:
			"Answer one focused question from a discovered historical Pi session's complete active branch, including original evidence before compaction. Use session_search first to obtain an ID and verify its cwd. The executing session is always excluded. Historical content is normalized, redacted, treated as untrusted evidence, and read by the configured tool-free reader model with entry citations.",
		parameters: Type.Object({
			session_id: Type.String({
				description: "A full historical session ID or unique ID prefix, never a file path.",
			}),
			question: Type.String({ description: "The concrete question to answer using only that session's evidence." }),
		}),
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			const result = await readHistoricalSession(
				{
					sessionId: params.session_id,
					question: params.question,
					model: getReaderModel(),
					activeThinkingLevel: pi.getThinkingLevel(),
				},
				ctx,
				signal,
			);
			return {
				content: [{ type: "text", text: result.content }],
				details: result.details,
			};
		},
	});
}
