import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { registerThinkAloud, THINK_ALOUD_TOOL_NAME } from "../src/think-aloud.ts";

initTheme("dark", false);

let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "think-aloud-test-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

function setup() {
	const tools = new Map<string, any>();
	let active = ["read"];
	let sessionStart: ((event: any, ctx: any) => Promise<void>) | undefined;
	const pi = {
		registerTool: vi.fn((tool: any) => {
			tools.set(tool.name, tool);
			active = [...active, tool.name];
		}),
		getActiveTools: () => active,
		setActiveTools: vi.fn((names: string[]) => {
			active = names;
		}),
		on: (event: string, handler: any) => {
			if (event === "session_start") sessionStart = handler;
		},
	};
	const configure = registerThinkAloud(pi as never);
	const ctx = { hasUI: true, ui: { notify: vi.fn(), select: vi.fn() } };
	return {
		pi,
		tools,
		ctx,
		active: () => active,
		configure: (choice: string | undefined) => {
			ctx.ui.select.mockResolvedValueOnce(choice);
			return configure(ctx as never);
		},
		start: () => sessionStart?.({ reason: "startup" }, ctx),
	};
}

test("defaults off; enabling persists, activates immediately, and survives reload", async () => {
	writeFileSync(join(directory, "pi-suite.json"), '{"other":42}');
	let app = setup();
	expect(app.tools.size).toBe(0);
	expect(await app.configure(undefined)).toBe(false);
	expect(await app.configure("on")).toBe(true);
	expect(app.ctx.ui.select).toHaveBeenLastCalledWith("Think aloud (off)", ["on", "off"]);
	expect(app.active()).toEqual(["read", THINK_ALOUD_TOOL_NAME]);
	expect(JSON.parse(readFileSync(join(directory, "pi-suite.json"), "utf8"))).toEqual({ other: 42, thinkAloud: true });

	app = setup();
	expect(app.active()).toEqual(["read", THINK_ALOUD_TOOL_NAME]);
	await app.configure("off");
	expect(app.active()).toEqual(["read"]);
	await app.configure("on");
	expect(app.pi.registerTool).toHaveBeenCalledOnce();
	expect(app.active()).toEqual(["read", THINK_ALOUD_TOOL_NAME]);
	await app.configure("off");

	app = setup();
	expect(app.tools.size).toBe(0);
});

test("invalid config warns at startup and a failed save does not enable the tool", async () => {
	writeFileSync(join(directory, "pi-suite.json"), "{invalid");
	const app = setup();
	await app.start();
	expect(app.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Could not load"), "warning");
	await app.configure("on");
	expect(app.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Could not save"), "error");
	expect(readFileSync(join(directory, "pi-suite.json"), "utf8")).toBe("{invalid");
	expect(app.tools.size).toBe(0);
});

test("the note stays visible when tool output is collapsed; only failures show a result", async () => {
	const app = setup();
	await app.configure("on");
	const tool = app.tools.get(THINK_ALOUD_TOOL_NAME);
	const ui = { requestRender: vi.fn() } as unknown as TUI;
	const row = new ToolExecutionComponent(
		THINK_ALOUD_TOOL_NAME,
		"call",
		{ thought: "Use the **native** toggle instead." },
		{},
		tool,
		ui,
		directory,
	);
	const result = await tool.execute("call", { thought: "x" });
	row.updateResult({ ...result, isError: false });
	for (const expanded of [false, true]) {
		row.setExpanded(expanded);
		const text = row.render(60).join("\n");
		expect(text).toContain("│");
		expect(text).toContain("native");
		expect(text).not.toContain("Shown to the user");
	}

	const failed = new ToolExecutionComponent(THINK_ALOUD_TOOL_NAME, "failed", {}, {}, tool, ui, directory);
	failed.updateResult({ content: [{ type: "text", text: "thought is required" }], isError: true });
	expect(failed.render(60).join("\n")).toContain("thought is required");
});
