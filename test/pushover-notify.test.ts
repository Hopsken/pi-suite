import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import piSuite from "../src/index.ts";
import { NOTIFY_USER_TOOL_NAME, registerPushoverNotify } from "../src/pushover-notify.ts";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pushover-test-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  vi.stubEnv("PUSHOVER_TOKEN", "token");
  vi.stubEnv("PUSHOVER_USER", "user");
  vi.stubEnv("PI_PUSHOVER_MIN_SECONDS", "30");
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
  const tools = new Map<string, any>();
  let active = ["read"];
  let command: any;
  const configure = registerPushoverNotify({
    on: (event: string, handler: any) => handlers.set(event, handler),
    registerCommand: (_name: string, value: any) => {
      command = value;
    },
    registerTool: (tool: any) => {
      tools.set(tool.name, tool);
      active = [...active, tool.name];
    },
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
  } as never);
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: "/project",
    sessionManager: { getSessionName: () => "Session" },
    ui: { notify: vi.fn(), select: vi.fn() },
  };
  return {
    configure,
    ctx,
    command,
    active: () => active,
    callTool: (message: string) =>
      tools.get(NOTIFY_USER_TOOL_NAME).execute("id", { message }, undefined, undefined, ctx),
    emit: (event: string) => handlers.get(event)?.({ reason: "startup" }, ctx),
    runFor: async (seconds: number, during?: () => unknown) => {
      await handlers.get("agent_start")?.({}, ctx);
      vi.advanceTimersByTime(seconds * 1000);
      await during?.();
      await handlers.get("agent_settled")?.({}, ctx);
    },
  };
}

function sentMessages(): string[] {
  return vi.mocked(fetch).mock.calls.map(([, init]) => (init!.body as URLSearchParams).get("message") ?? "");
}

test("defaults off; enabling persists and exposes notify_user; long runs never notify automatically", async () => {
  writeFileSync(join(directory, "pi-suite.json"), '{"other":42}');
  let app = setup();
  await app.emit("session_start");
  expect(app.active()).toEqual(["read"]);
  expect(app.ctx.ui.notify).not.toHaveBeenCalled();

  app.ctx.ui.select.mockResolvedValue("on");
  await app.configure(app.ctx as never);
  expect(JSON.parse(readFileSync(join(directory, "pi-suite.json"), "utf8"))).toEqual({ other: 42, pushover: true });
  expect(app.active()).toEqual(["read", NOTIFY_USER_TOOL_NAME]);

  app = setup();
  expect(app.active()).toEqual(["read", NOTIFY_USER_TOOL_NAME]);
  await app.runFor(600);
  expect(fetch).not.toHaveBeenCalled();

  await expect(app.callTool("Build finished")).resolves.toMatchObject({
    content: [{ type: "text", text: "Notification sent." }],
  });
  const [url, init] = vi.mocked(fetch).mock.calls[0]!;
  expect(url).toBe("https://api.pushover.net/1/messages.json");
  expect(Object.fromEntries(init!.body as URLSearchParams)).toEqual({
    token: "token",
    user: "user",
    title: "Pi · Session",
    message: "Build finished",
  });

  await app.command.handler("off", app.ctx);
  expect(app.active()).toEqual(["read"]);
  await app.command.handler("on", app.ctx);
  expect(app.active()).toEqual(["read", NOTIFY_USER_TOOL_NAME]);
});

test("notify_user reports Pushover failures to the agent", async () => {
  writeFileSync(join(directory, "pi-suite.json"), '{"pushover":true}');
  vi.mocked(fetch).mockResolvedValue({ ok: false, status: 429, text: async () => "rate limited" } as never);
  await expect(setup().callTool("Done")).rejects.toThrow("Pushover failed: HTTP 429 rate limited");
});

test("prompt notification fires once per long run and skips short runs", async () => {
  writeFileSync(join(directory, "pi-suite.json"), '{"pushover":true}');
  const app = setup();
  const prompt = () => app.emit("ui_prompt_start");

  await app.runFor(10, prompt);
  expect(fetch).not.toHaveBeenCalled();

  await app.runFor(31, async () => {
    await prompt();
    await prompt();
  });
  expect(sentMessages()).toEqual(["Waiting for your input"]);

  await app.runFor(31, prompt);
  expect(sentMessages()).toEqual(["Waiting for your input", "Waiting for your input"]);

  // A retry starts another low-level run; the run still counts from its first start.
  await app.runFor(20, async () => {
    await app.emit("agent_start");
    vi.advanceTimersByTime(15_000);
    await prompt();
  });
  expect(sentMessages()).toHaveLength(3);
});

test("with only one credential set, warns once enabled and never sends", async () => {
  vi.stubEnv("PUSHOVER_USER", "");
  let app = setup();
  await app.emit("session_start");
  expect(app.ctx.ui.notify).not.toHaveBeenCalled();
  await app.command.handler("on", app.ctx);
  expect(app.ctx.ui.notify).toHaveBeenCalledWith(
    expect.stringContaining("PUSHOVER_TOKEN and PUSHOVER_USER"),
    "warning",
  );
  app = setup();
  await app.emit("session_start");
  expect(app.ctx.ui.notify).toHaveBeenCalledWith(
    expect.stringContaining("PUSHOVER_TOKEN and PUSHOVER_USER"),
    "warning",
  );
  await expect(app.callTool("Done")).rejects.toThrow("PUSHOVER_TOKEN and PUSHOVER_USER");
  await app.runFor(31, () => app.emit("ui_prompt_start"));
  expect(fetch).not.toHaveBeenCalled();
});

test("invalid config is preserved and a failed save does not enable notifications", async () => {
  writeFileSync(join(directory, "pi-suite.json"), "{invalid");
  const app = setup();
  await app.emit("session_start");
  expect(app.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Could not load"), "warning");
  await app.command.handler("on", app.ctx);
  expect(app.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Could not save"), "error");
  expect(readFileSync(join(directory, "pi-suite.json"), "utf8")).toBe("{invalid");
  expect(app.active()).toEqual(["read"]);
});

test("Pi's real extension loader loads Suite with every opt-in tool turned on", async () => {
  // Pi rejects action methods such as getActiveTools while an extension loads; the fake pi above does not.
  writeFileSync(join(directory, "pi-suite.json"), '{"pushover":true,"thinkAloud":true}');
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory(),
    extensionFactories: [piSuite],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const { extensions, errors } = loader.getExtensions();
  expect(errors).toEqual([]);
  expect(extensions.flatMap((extension) => [...extension.tools.keys()])).toEqual(
    expect.arrayContaining([NOTIFY_USER_TOOL_NAME, "think_aloud"]),
  );
});
