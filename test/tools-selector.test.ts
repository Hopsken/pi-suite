import { initTheme } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { registerToolsSelector } from "../src/tools-selector.ts";

initTheme("dark", false);

type Handler = (event: unknown, context: any) => unknown;
type Entry = { type: "custom"; customType: string; data: unknown };

/** A Pi stand-in whose custom entries land on the session branch, as Pi's appendEntry does. */
function createSession(branch: Entry[], activeTools: string[] = ["read", "bash"]) {
  const commands = new Map<string, { handler: Handler }>();
  const handlers = new Map<string, Handler>();
  const session = { active: activeTools };
  registerToolsSelector({
    appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
    getActiveTools: () => session.active,
    getAllTools: () => [{ name: "read" }, { name: "bash" }, { name: "edit" }],
    setActiveTools: (names: string[]) => {
      session.active = names;
    },
    registerCommand: (name: string, command: { handler: Handler }) => commands.set(name, command),
    on: (event: string, handler: Handler) => handlers.set(event, handler),
  } as never);
  const context = { mode: "tui", sessionManager: { getBranch: () => branch } };
  return { commands, handlers, session, context };
}

test("a /tools change applies now and is restored when the session resumes", async () => {
  const branch: Entry[] = [];
  const first = createSession(branch);
  await first.handlers.get("session_start")?.({}, first.context);

  // Drive the real settings list: toggle the first tool (read), move down twice, toggle edit, close.
  await first.commands.get("tools")?.handler("", {
    ...first.context,
    ui: {
      custom: (factory: any) =>
        new Promise((resolve) => {
          const component = factory({ requestRender: () => {} }, undefined, undefined, resolve);
          for (const key of ["\r", "\x1b[B", "\x1b[B", "\r", "\x1b"]) component.handleInput(key);
        }),
    },
  });
  expect(first.session.active).toEqual(["bash", "edit"]);

  const resumed = createSession(branch, ["read", "bash", "edit"]);
  await resumed.handlers.get("session_start")?.({}, resumed.context);
  expect(resumed.session.active).toEqual(["bash", "edit"]);
});

test("navigating the session tree restores the latest branch selection and drops unavailable tools", () => {
  const branch: Entry[] = [
    { type: "custom", customType: "tools-config", data: { enabledTools: ["read"] } },
    { type: "custom", customType: "other", data: { enabledTools: ["edit"] } },
    { type: "custom", customType: "tools-config", data: { enabledTools: ["bash", "removed"] } },
  ];
  const { handlers, session, context } = createSession(branch);
  handlers.get("session_tree")?.({}, context);
  expect(session.active).toEqual(["bash"]);
});
