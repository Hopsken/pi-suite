import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { registerPushoverNotify } from "../src/pushover-notify.ts";

let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pushover-test-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
	vi.stubEnv("PUSHOVER_TOKEN", "token");
	vi.stubEnv("PUSHOVER_USER", "user");
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
	let command: any;
	const configure = registerPushoverNotify({
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerCommand: (_name: string, value: any) => {
			command = value;
		},
	} as never);
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: "/project",
		sessionManager: { getSessionName: () => "Session" },
		ui: { notify: vi.fn(), select: vi.fn() },
	};
	return { configure, ctx, command, emit: (event: string) => handlers.get(event)?.({ reason: "startup" }, ctx) };
}

test("defaults off even with credentials; persisted on sends and off survives reload", async () => {
	let app = setup();
	await app.emit("session_start");
	await app.emit("agent_start");
	vi.advanceTimersByTime(31_000);
	await app.emit("agent_settled");
	expect(fetch).not.toHaveBeenCalled();
	expect(app.ctx.ui.notify).not.toHaveBeenCalled();
	writeFileSync(join(directory, "pi-suite.json"), '{"other":42}');
	app.ctx.ui.select.mockResolvedValue("on");
	await app.configure(app.ctx as never);
	expect(app.ctx.ui.select).toHaveBeenCalledWith("Pushover notifications (off)", ["on", "off"]);
	expect(JSON.parse(readFileSync(join(directory, "pi-suite.json"), "utf8"))).toEqual({
		other: 42,
		pushover: true,
	});
	app = setup();
	await app.emit("agent_start");
	vi.advanceTimersByTime(31_000);
	await app.emit("agent_settled");
	expect(fetch).toHaveBeenCalledOnce();
	await app.command.handler("off", app.ctx);
	app = setup();
	await app.emit("agent_start");
	vi.advanceTimersByTime(31_000);
	await app.emit("agent_settled");
	expect(fetch).toHaveBeenCalledOnce();
});

test.each(["PUSHOVER_TOKEN", "PUSHOVER_USER", "both"])("warns only when enabled with missing %s", async (missing) => {
	if (missing !== "PUSHOVER_USER") vi.stubEnv("PUSHOVER_TOKEN", "");
	if (missing !== "PUSHOVER_TOKEN") vi.stubEnv("PUSHOVER_USER", "");
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
	await app.emit("agent_start");
	vi.advanceTimersByTime(31_000);
	await app.emit("agent_settled");
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
	await app.emit("agent_start");
	vi.advanceTimersByTime(31_000);
	await app.emit("agent_settled");
	expect(fetch).not.toHaveBeenCalled();
});
