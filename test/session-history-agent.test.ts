import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import piSuite, { SESSION_READ_TOOL_NAME, SESSION_SEARCH_TOOL_NAME } from "../src/index.ts";
import { userEntry, writeSession } from "./session-history-fixtures.ts";

function lastToolResultText(context: Context, toolName: string): string {
  const result = [...context.messages]
    .reverse()
    .find((message) => message.role === "toolResult" && message.toolName === toolName);
  if (result?.role !== "toolResult") throw new Error(`No ${toolName} result reached the model.`);
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function lastAssistantText(session: AgentSession): string {
  const message = session.messages.at(-1);
  if (message?.role !== "assistant") throw new Error("The agent did not produce a final assistant response.");
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

describe("session history through the Pi agent loop", () => {
  let agentDirectory: string;
  let previousAgentDirectory: string | undefined;
  let faux: FauxProviderRegistration | undefined;
  let session: AgentSession | undefined;

  beforeEach(() => {
    agentDirectory = mkdtempSync(join(tmpdir(), "pi-suite-agent-history-"));
    previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDirectory;
  });

  afterEach(() => {
    session?.dispose();
    session = undefined;
    faux?.unregister();
    faux = undefined;
    if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
    rmSync(agentDirectory, { recursive: true, force: true });
  });

  async function createHistoryAgent(cwd: string, sessionManager = SessionManager.inMemory(cwd)): Promise<AgentSession> {
    if (!faux) throw new Error("Register the faux provider before creating the agent.");
    const apiProvider = getApiProvider(faux.api);
    if (!apiProvider) throw new Error(`Faux API ${faux.api} was not registered.`);
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
    });
    modelRuntime.registerNativeProvider(
      createProvider({
        id: faux.getModel().provider,
        auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } },
        models: faux.models,
        api: apiProvider,
      }),
    );
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: agentDirectory,
      settingsManager,
      extensionFactories: [piSuite],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => "Use the session history tools to answer requests about previous work.",
    });
    await resourceLoader.reload();
    const created = await createAgentSession({
      cwd,
      agentDir: agentDirectory,
      model: faux.getModel(),
      thinkingLevel: "off",
      modelRuntime,
      resourceLoader,
      settingsManager,
      sessionManager,
      tools: [SESSION_SEARCH_TOOL_NAME, SESSION_READ_TOOL_NAME],
    });
    return created.session;
  }

  test("repo:. finds sessions from another worktree of the same Git repository through real git", async () => {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd });
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-suite-git-")));
    const main = join(root, "main");
    const feature = join(root, "feature");
    const other = join(root, "other");
    try {
      for (const repository of [main, other]) {
        mkdirSync(repository);
        git(repository, "init", "--quiet");
        git(repository, "commit", "--quiet", "--allow-empty", "-m", "init");
      }
      git(main, "remote", "add", "origin", "https://user:secret@github.com/Hopsken/pi-suite.git");
      git(main, "remote", "add", "upstream", "git@github.com:someone-else/pi-suite.git");
      git(main, "worktree", "add", "--quiet", feature);
      git(other, "remote", "add", "origin", "git@github.com:other/project.git");

      faux = registerFauxProvider({ api: "pi-suite-agent-repo", provider: "pi-suite-agent-repo" });
      let searchResult = "";
      faux.setResponses(
        Array.from({ length: 10 }, () => (context: Context) => {
          if (context.systemPrompt?.includes("session titling assistant")) return fauxAssistantMessage("Retry queue");
          const asked = context.messages.find((message) => message.role === "user");
          const text = asked?.role === "user" && typeof asked.content !== "string" ? asked.content : [];
          if (!JSON.stringify(text).includes("Find")) return fauxAssistantMessage("Recorded the retry queue decision.");
          if (!context.messages.some((message) => message.role === "toolResult"))
            return fauxAssistantMessage(fauxToolCall(SESSION_SEARCH_TOOL_NAME, { query: 'repo:. "retry queue"' }), {
              stopReason: "toolUse",
            });
          searchResult = lastToolResultText(context, SESSION_SEARCH_TOOL_NAME);
          return fauxAssistantMessage("Found it.");
        }),
      );

      const sessionIds: Record<string, string> = {};
      for (const [name, cwd] of [
        ["main", main],
        ["other", other],
      ] as const) {
        const history = await createHistoryAgent(cwd, SessionManager.create(cwd));
        await history.bindExtensions({});
        await history.prompt("Record the retry queue decision.");
        sessionIds[name] = history.sessionManager.getSessionId();
        const repository = history.sessionManager
          .getEntries()
          .find((entry) => entry.type === "custom" && entry.customType === "pi-suite-repository");
        if (name === "main")
          expect(repository).toMatchObject({
            data: {
              worktreeRoot: main,
              commonGitDir: join(main, ".git"),
              remote: "github.com/hopsken/pi-suite",
            },
          });
        expect(JSON.stringify(repository)).not.toContain("secret");
        history.dispose();
      }

      session = await createHistoryAgent(feature);
      await session.bindExtensions({});
      await session.prompt("Find the retry queue decision from this repository.");

      expect(searchResult).toContain(sessionIds.main);
      expect(searchResult).not.toContain(sessionIds.other);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("lets the model search history and use the real tool result in its answer", async () => {
    writeSession(agentDirectory, {
      id: "search-agent-session",
      cwd: "/project/search-agent",
      entries: [userEntry("search-evidence", null, "The durable queue was selected for retry safety.")],
    });
    faux = registerFauxProvider({
      api: "pi-suite-agent-search",
      provider: "pi-suite-agent-search",
    });
    let observedToolResult = "";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(SESSION_SEARCH_TOOL_NAME, { query: '"durable queue"' }), {
        stopReason: "toolUse",
      }),
      (context) => {
        observedToolResult = lastToolResultText(context, SESSION_SEARCH_TOOL_NAME);
        return fauxAssistantMessage(
          observedToolResult.includes("search-agent-session")
            ? "I found the prior queue decision."
            : "I could not find the prior queue decision.",
        );
      },
      fauxAssistantMessage("Durable queue retry decision"),
    ]);
    session = await createHistoryAgent("/project/current");

    await session.prompt("Find the previous durable queue decision.");

    expect(observedToolResult).toContain("search-agent-session");
    expect(observedToolResult).toContain("durable queue");
    expect(session.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(lastAssistantText(session)).toBe("I found the prior queue decision.");
    expect(session.sessionName).toBe("Durable queue retry decision");
    expect(faux.getPendingResponseCount()).toBe(0);
  });

  test("lets the model read history, runs reader inference, and returns the answer to the agent", async () => {
    writeSession(agentDirectory, {
      id: "read-agent-session",
      cwd: "/project/read-agent",
      entries: [userEntry("read-evidence", null, "Retries are durable because jobs are persisted before dispatch.")],
    });
    faux = registerFauxProvider({
      api: "pi-suite-agent-read",
      provider: "pi-suite-agent-read",
    });
    let readerPrompt = "";
    let observedToolResult = "";
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(SESSION_READ_TOOL_NAME, {
          session_id: "read-agent-session",
          question: "Why are retries durable?",
        }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const request = context.messages[0];
        readerPrompt = request?.role === "user" && typeof request.content === "string" ? request.content : "";
        return fauxAssistantMessage("Jobs are persisted before dispatch. session:read-agent-session#read-evidence");
      },
      (context) => {
        observedToolResult = lastToolResultText(context, SESSION_READ_TOOL_NAME);
        return fauxAssistantMessage(
          observedToolResult.includes("Jobs are persisted before dispatch")
            ? "The prior session says persistence makes retries durable."
            : "The prior session did not explain retry durability.",
        );
      },
      fauxAssistantMessage("Durable retries from persisted jobs"),
    ]);
    session = await createHistoryAgent("/project/current");

    await session.prompt("Read the previous session and explain why retries are durable.");

    expect(readerPrompt).toContain("Retries are durable because jobs are persisted before dispatch.");
    expect(observedToolResult).toContain("# Historical session answer");
    expect(observedToolResult).toContain("session:read-agent-session#read-evidence");
    expect(session.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(lastAssistantText(session)).toBe("The prior session says persistence makes retries durable.");
    expect(session.sessionName).toBe("Durable retries from persisted jobs");
    expect(faux.state.callCount).toBe(4);
    expect(faux.getPendingResponseCount()).toBe(0);
  });
});
