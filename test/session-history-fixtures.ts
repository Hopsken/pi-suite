import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import piSuite, { SESSION_READ_TOOL_NAME, SESSION_SEARCH_TOOL_NAME } from "../src/index.ts";

export const TEST_TIMESTAMP = "2026-01-01T00:00:00.000Z";

type ToolContext = {
	cwd: string;
	sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
};

type RegisteredTool = {
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		context: ToolContext,
	): Promise<unknown>;
};

interface ToolTextResult {
	content: [{ type: "text"; text: string }];
}

interface SearchToolResult extends ToolTextResult {
	details: {
		sessions: Array<{ sessionId: string; cwd: string; repo?: string }>;
		count: number;
		hasMore: boolean;
	};
}

interface ReadToolResult extends ToolTextResult {
	details: {
		sessionId: string;
		readerModel: string;
		inspectedEntries: number;
	};
}

export function createSessionToolHarness(thinkingLevel: ModelThinkingLevel = "off") {
	const tools = new Map<string, RegisteredTool>();
	piSuite({
		registerTool: (tool: RegisteredTool & { name: string }) => tools.set(tool.name, tool),
		registerCommand: () => {},
		on: () => {},
		getThinkingLevel: () => thinkingLevel,
	} as never);

	const execute = <T>(
		name: string,
		params: Record<string, unknown>,
		context: ToolContext,
		signal?: AbortSignal,
	): Promise<T> => {
		const tool = tools.get(name);
		if (!tool) throw new Error(`Pi Suite did not register ${name}.`);
		return tool.execute("test-call", params, signal, undefined, context) as Promise<T>;
	};

	return {
		search: (params: { query: string; limit?: number }, context: ToolContext, signal?: AbortSignal) =>
			execute<SearchToolResult>(SESSION_SEARCH_TOOL_NAME, params, context, signal),
		read: (params: { session_id: string; question: string }, context: ToolContext, signal?: AbortSignal) =>
			execute<ReadToolResult>(SESSION_READ_TOOL_NAME, params, context, signal),
	};
}

export function searchContext(cwd: string, currentSessionId = "current-session", currentSessionFile?: string) {
	return {
		cwd,
		sessionManager: {
			getSessionId: () => currentSessionId,
			getSessionFile: () => currentSessionFile,
		},
	};
}

export function userEntry(id: string, parentId: string | null, text: string, timestamp = TEST_TIMESTAMP) {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: { role: "user", content: [{ type: "text", text }], timestamp: Date.parse(timestamp) },
	};
}

export function writeSession(
	agentDirectory: string,
	options: {
		id: string;
		cwd: string;
		entries: unknown[];
		timestamp?: string;
		version?: number;
		trailingContent?: string;
	},
): string {
	if (process.env.PI_CODING_AGENT_DIR !== agentDirectory)
		throw new Error("Test agent directory must be active before creating a session fixture.");
	const directory = SessionManager.create(options.cwd).getSessionDir();
	mkdirSync(directory, { recursive: true });
	const timestamp = options.timestamp ?? TEST_TIMESTAMP;
	const path = join(directory, `${timestamp.replace(/[:.]/g, "-")}_${options.id}.jsonl`);
	const header = {
		type: "session",
		...(options.version === undefined ? { version: 3 } : options.version > 0 ? { version: options.version } : {}),
		id: options.id,
		timestamp,
		cwd: options.cwd,
	};
	const lines = [header, ...options.entries].map((entry) => JSON.stringify(entry)).join("\n");
	writeFileSync(path, `${lines}\n${options.trailingContent ?? ""}`, "utf8");
	return path;
}
