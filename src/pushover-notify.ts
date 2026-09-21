/**
 * Pushover notifications for Pi.
 *
 * Sends a push notification via https://pushover.net when:
 * - the agent finishes a run and is waiting for input (`agent_settled`)
 * - the agent blocks on a UI prompt (ask_user_question, confirm, select...) (`ui_prompt_start`)
 *
 * Only fires in interactive TUI mode and only when the run has been going for
 * at least PI_PUSHOVER_MIN_SECONDS (default 30) so quick exchanges don't spam.
 *
 * Env:
 *   PUSHOVER_TOKEN            application API token (required)
 *   PUSHOVER_USER             user/group key (required)
 *   PI_PUSHOVER_MIN_SECONDS   minimum run duration before notifying (default 30)
 *
 * Commands:
 *   /pushover test            send a test notification now
 *   /pushover on|off          toggle for the current process
 *   /pushover                 show status
 */

import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PUSHOVER_URL = "https://api.pushover.net/1/messages.json";
const REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_MIN_SECONDS = 30;

const token = process.env.PUSHOVER_TOKEN;
const user = process.env.PUSHOVER_USER;
const configured = Boolean(token && user);
const minSeconds = Number(process.env.PI_PUSHOVER_MIN_SECONDS ?? DEFAULT_MIN_SECONDS);

let enabled = true;
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

function longEnough(): boolean {
	return runStartedAt !== undefined && Date.now() - runStartedAt >= minSeconds * 1000;
}

function notify(ctx: ExtensionContext, message: string): void {
	if (!configured || !enabled || ctx.mode !== "tui") return;
	void send(sessionTitle(ctx), message).then((error) => {
		if (error && ctx.hasUI) ctx.ui.notify(`Pushover failed: ${error}`, "warning");
	});
}

export function registerPushoverNotify(pi: ExtensionAPI) {
	pi.on("session_start", async (event, ctx) => {
		if (!configured && event.reason === "startup" && ctx.hasUI) {
			ctx.ui.notify("Pushover disabled: set PUSHOVER_TOKEN and PUSHOVER_USER", "warning");
		}
	});

	pi.on("agent_start", async () => {
		// Retries/compaction can start several low-level runs; keep the first timestamp.
		runStartedAt ??= Date.now();
	});

	pi.on("ui_prompt_start", async (_event, ctx) => {
		// Only prompts raised while the agent is running; skip ones from idle commands.
		if (runStartedAt === undefined || promptNotifiedThisRun || !longEnough()) return;
		promptNotifiedThisRun = true;
		notify(ctx, "Waiting for your input");
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (longEnough()) notify(ctx, "Task done");
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
				enabled = arg === "on";
				ctx.ui.notify(`Pushover ${arg}`, "info");
				return;
			}
			if (arg === "test") {
				if (!configured) {
					ctx.ui.notify("Pushover not configured: set PUSHOVER_TOKEN and PUSHOVER_USER", "error");
					return;
				}
				const error = await send(sessionTitle(ctx), "Test notification");
				ctx.ui.notify(error ? `Pushover failed: ${error}` : "Pushover test sent", error ? "error" : "info");
				return;
			}
			const state = !configured ? "not configured" : enabled ? "on" : "off";
			ctx.ui.notify(`Pushover: ${state} (min ${minSeconds}s, tui only)`, "info");
		},
	});
}
