/**
 * Pushover notifications for Pi.
 *
 * When enabled, the agent gets a `notify_user` tool to send a push notification via https://pushover.net
 * when the user asks for one, or when a long task ends and needs the user's attention.
 *
 * Pi also sends a notification automatically when the agent blocks on a UI prompt (ask_user_question,
 * confirm, select...) during a run, because the agent cannot call a tool while it waits. This only happens
 * in interactive TUI mode, once per run, and only after PI_PUSHOVER_MIN_SECONDS (default 30) of activity.
 *
 * Env:
 *   PUSHOVER_TOKEN            application API token (required)
 *   PUSHOVER_USER             user/group key (required)
 *   PI_PUSHOVER_MIN_SECONDS   minimum run duration before the prompt notification (default 30)
 *
 * Commands:
 *   /pushover test            send a test notification now
 *   /pushover on|off          save the notification setting (default off)
 *   /pushover                 show status
 */

import { basename } from "node:path";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadPushoverEnabled, savePushoverEnabled } from "./state.ts";

export const NOTIFY_USER_TOOL_NAME = "notify_user";

const PUSHOVER_URL = "https://api.pushover.net/1/messages.json";
const REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_MIN_SECONDS = 30;
const MISSING_CREDENTIALS = "set PUSHOVER_TOKEN and PUSHOVER_USER";

export function registerPushoverNotify(pi: ExtensionAPI) {
  const token = process.env.PUSHOVER_TOKEN;
  const user = process.env.PUSHOVER_USER;
  const configured = Boolean(token && user);
  const minSeconds = Number(process.env.PI_PUSHOVER_MIN_SECONDS ?? DEFAULT_MIN_SECONDS);

  let enabled = false;
  let registered = false;
  let loadError: string | undefined;
  try {
    enabled = loadPushoverEnabled();
  } catch (error) {
    loadError = `Could not load Pushover setting: ${String(error)}`;
  }
  let runStartedAt: number | undefined;
  let promptNotifiedThisRun = false;

  async function send(title: string, message: string): Promise<string | undefined> {
    const body = new URLSearchParams({ token: token!, user: user!, title, message });
    try {
      const res = await fetch(PUSHOVER_URL, {
        method: "POST",
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) return undefined;
      const text = await res.text().catch(() => "");
      return `HTTP ${res.status} ${text}`.trim();
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  function sessionTitle(ctx: ExtensionContext): string {
    return `Pi · ${ctx.sessionManager.getSessionName() ?? basename(ctx.cwd)}`;
  }

  const notifyUserTool = defineTool({
    name: NOTIFY_USER_TOOL_NAME,
    label: "Notify User",
    description:
      "Send a push notification to the user's phone. Use it only when the user asked to be notified, or when a long-running task ends and needs the user's attention.",
    promptSnippet: "Send the user a push notification when they asked for one or a long task needs their attention",
    promptGuidelines: [
      "Call notify_user when the user asks to be notified (for example, 'ping me when it is done'), or when a task that ran for many minutes finishes or is blocked and needs the user to come back.",
      "Do not call notify_user for short exchanges, routine progress, or when the user is clearly watching the session.",
      "Keep the message to one short sentence that says what finished or what needs the user's decision.",
    ],
    parameters: Type.Object({
      message: Type.String({ minLength: 1, description: "One short sentence for the notification body." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!configured) throw new Error(`Pushover is not configured: ${MISSING_CREDENTIALS}.`);
      const error = await send(sessionTitle(ctx), params.message);
      if (error) throw new Error(`Pushover failed: ${error}`);
      return { content: [{ type: "text", text: "Notification sent." }], details: undefined };
    },
  });

  // Newly registered tools start active; later toggles only change the active set.
  // Registration must not read the active set: Pi rejects getActiveTools while the extension loads.
  function register(): void {
    pi.registerTool(notifyUserTool);
    registered = true;
  }
  if (enabled) register();

  function applyTool(): void {
    if (!registered) {
      if (enabled) register();
      return;
    }
    const others = pi.getActiveTools().filter((name) => name !== NOTIFY_USER_TOOL_NAME);
    pi.setActiveTools(enabled ? [...others, NOTIFY_USER_TOOL_NAME] : others);
  }

  function warnMissingCredentials(ctx: ExtensionContext): void {
    if (enabled && !configured) ctx.ui.notify(`Pushover cannot send notifications: ${MISSING_CREDENTIALS}`, "warning");
  }

  function setEnabled(value: boolean, ctx: ExtensionContext): void {
    try {
      savePushoverEnabled(value);
    } catch (error) {
      ctx.ui.notify(`Could not save Pushover setting: ${String(error)}`, "error");
      return;
    }
    enabled = value;
    applyTool();
    ctx.ui.notify(`Pushover ${enabled ? "on" : "off"}`, "info");
    warnMissingCredentials(ctx);
  }

  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "startup" && ctx.hasUI) {
      if (loadError) ctx.ui.notify(loadError, "warning");
      warnMissingCredentials(ctx);
    }
  });

  pi.on("agent_start", async () => {
    // Retries/compaction can start several low-level runs; keep the first timestamp.
    runStartedAt ??= Date.now();
  });

  pi.on("ui_prompt_start", async (_event, ctx) => {
    // Only prompts raised while the agent is running; skip ones from idle commands.
    if (!configured || !enabled || ctx.mode !== "tui") return;
    if (runStartedAt === undefined || promptNotifiedThisRun) return;
    if (Date.now() - runStartedAt < minSeconds * 1000) return;
    promptNotifiedThisRun = true;
    void send(sessionTitle(ctx), "Waiting for your input").then((error) => {
      if (error && ctx.hasUI) ctx.ui.notify(`Pushover failed: ${error}`, "warning");
    });
  });

  pi.on("agent_settled", async () => {
    runStartedAt = undefined;
    promptNotifiedThisRun = false;
  });

  pi.registerCommand("pushover", {
    description: "Pushover notifications: test | on | off",
    getArgumentCompletions: (prefix) => {
      const items = ["test", "on", "off"].filter((v) => v.startsWith(prefix)).map((v) => ({ value: v, label: v }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === "on" || arg === "off") {
        setEnabled(arg === "on", ctx);
        return;
      }
      if (arg === "test") {
        if (!configured) {
          ctx.ui.notify(`Pushover not configured: ${MISSING_CREDENTIALS}`, "error");
          return;
        }
        const error = await send(sessionTitle(ctx), "Test notification");
        ctx.ui.notify(error ? `Pushover failed: ${error}` : "Pushover test sent", error ? "error" : "info");
        return;
      }
      const state = !enabled ? "off" : configured ? "on" : "on (not configured)";
      ctx.ui.notify(
        `Pushover: ${state} (${NOTIFY_USER_TOOL_NAME} tool; prompt alert after ${minSeconds}s, tui only)`,
        "info",
      );
    },
  });
  return async (ctx: ExtensionContext): Promise<boolean> => {
    const choice = await ctx.ui.select(`Pushover notifications (${enabled ? "on" : "off"})`, ["on", "off"]);
    if (!choice) return false;
    setEnabled(choice === "on", ctx);
    return true;
  };
}
