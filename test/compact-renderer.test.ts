import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionContext,
	initTheme,
	type ToolDefinition,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { afterEach, expect, test, vi } from "vitest";
import { withCompactRendering } from "../src/compact-renderer.ts";
import { loadToolDisplayMode, saveToolDisplayMode } from "../src/state.ts";
import { registerToolDisplay } from "../src/tool-display.ts";

initTheme("dark", false);

const directories: string[] = [];
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory() {
	const path = mkdtempSync(join(tmpdir(), "suite-display-"));
	directories.push(path);
	vi.stubEnv("PI_CODING_AGENT_DIR", path);
	return path;
}

const factories = [
	createReadToolDefinition,
	createBashToolDefinition,
	createPowerShellToolDefinition,
	createEditToolDefinition,
	createWriteToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
];

test("all eight built-ins keep native rendering in Normal and hide text arguments/results in Compact", () => {
	const cwd = directory();
	const ui = { requestRender: vi.fn() } as unknown as TUI;
	let compact = false;
	for (const factory of factories) {
		const original = factory(cwd) as ToolDefinition<any, any>;
		const wrapped = withCompactRendering(original, () => compact);
		expect(wrapped.execute).toBe(original.execute);
		expect(wrapped.parameters).toBe(original.parameters);
		expect(wrapped.prepareArguments).toBe(original.prepareArguments);
		expect(wrapped.executionMode).toBe(original.executionMode);
		expect(wrapped.renderShell).toBe(original.renderShell);
		expect(wrapped.promptGuidelines).toBe(original.promptGuidelines);
		const args = {
			path: "private-file.txt",
			command: "private-command",
			pattern: "private-pattern",
			content: "private-content",
		};
		const native = new ToolExecutionComponent(original.name, "native", args, {}, original, ui, cwd);
		const row = new ToolExecutionComponent(original.name, "wrapped", args, {}, wrapped, ui, cwd);
		const result = { content: [{ type: "text", text: "private-result" }], isError: true };
		native.updateResult(result);
		row.updateResult(result);
		for (const expanded of [false, true]) {
			native.setExpanded(expanded);
			row.setExpanded(expanded);
			compact = false;
			expect(row.render(80)).toEqual(native.render(80));
			compact = true;
			expect(row.render(80).join("\n")).toContain(`${original.name} · failed`);
			expect(row.render(80).join("\n")).not.toContain("private-");
			compact = false;
			// No new result or call is needed to restore an existing row.
			expect(row.render(80)).toEqual(native.render(80));
		}
	}
});

test("pending, running, partial and completed calls update through public render contexts; native timers stop", () => {
	vi.useFakeTimers();
	const cwd = directory();
	let compact = true;
	const tool = withCompactRendering(createBashToolDefinition(cwd), () => compact);
	const row = new ToolExecutionComponent(
		"bash",
		"live",
		{ command: "printf private" },
		{},
		tool,
		{ requestRender: vi.fn() } as unknown as TUI,
		cwd,
	);
	expect(row.render(60).join("\n")).toContain("bash · pending");
	row.markExecutionStarted();
	expect(row.render(60).join("\n")).toContain("bash · running");
	row.updateResult({ content: [{ type: "text", text: "private-partial" }], isError: false }, true);
	expect(vi.getTimerCount()).toBeGreaterThan(0);
	compact = false;
	expect(row.render(60).join("\n")).toContain("private-partial");
	compact = true;
	row.updateResult({ content: [{ type: "text", text: "private-final" }], isError: false });
	expect(vi.getTimerCount()).toBe(0);
	expect(row.render(60).join("\n")).toContain("bash · done");
	expect(row.render(60).join("\n")).not.toContain("private");
	compact = false;
	expect(row.render(60).join("\n")).toContain("private-final");
});

function harness(cwd: string, mode = "tui") {
	const tools = new Map<string, ToolDefinition<any, any>>();
	let start: (event: unknown, ctx: ExtensionContext) => void;
	let widget: (Component & { dispose?: () => void }) | undefined;
	const ui = { requestRender: vi.fn() } as unknown as TUI; // No private TUI layout.
	const pi = {
		on: (_name: string, handler: typeof start) => {
			start = handler;
		},
		getAllTools: () => [
			...factories.map((factory) => ({ name: factory(cwd).name, sourceInfo: { source: "builtin" } })),
			{ name: "web_search", sourceInfo: { source: "package" } },
		],
		getActiveTools: () => ["read", "bash", "web_search"],
		setActiveTools: vi.fn(),
		registerTool: vi.fn((tool: ToolDefinition<any, any>) => {
			tools.set(tool.name, tool);
		}),
	};
	const ctx = {
		mode,
		cwd,
		isProjectTrusted: () => false,
		sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined },
		ui: {
			select: vi.fn().mockResolvedValue("Compact"),
			notify: vi.fn(),
			setWidget: (_key: string, factory: (ui: TUI) => typeof widget) => {
				widget?.dispose?.();
				widget = factory(ui);
			},
		},
	} as unknown as ExtensionContext;
	const configure = registerToolDisplay(pi as never);
	return { tools, pi, ctx, ui, configure, start: () => start({}, ctx), dispose: () => widget?.dispose?.() };
}

test("registration preserves active tools, excludes third-party overrides and skips non-TUI sessions", () => {
	const cwd = directory();
	const h = harness(cwd);
	const getAll = h.pi.getAllTools;
	h.pi.getAllTools = () =>
		getAll().map((tool) => (tool.name === "bash" ? { ...tool, sourceInfo: { source: "package" } } : tool));
	h.start();
	expect([...h.tools.keys()]).toEqual(["read", "powershell", "edit", "write", "find", "grep", "ls"]);
	expect(h.pi.setActiveTools).toHaveBeenCalledWith(["read", "bash", "web_search"]);
	h.start();
	expect(h.pi.registerTool).toHaveBeenCalledTimes(7);
	const headless = harness(cwd, "print");
	headless.start();
	expect(headless.pi.registerTool).not.toHaveBeenCalled();
});

test("mode persists across reloads, updates existing rows, and failed saves preserve the current view", async () => {
	const cwd = directory();
	const path = join(cwd, "pi-suite.json");
	expect(loadToolDisplayMode()).toBe("normal");
	writeFileSync(path, '{"compactionModel":"example:low","custom":42}');
	let h = harness(cwd);
	h.start();
	const row = new ToolExecutionComponent(
		"read",
		"history",
		{ path: "private.txt" },
		{},
		h.tools.get("read"),
		h.ui,
		cwd,
	);
	expect(row.render(80).join("\n")).toContain("private.txt");
	await h.configure(h.ctx);
	expect(row.render(80).join("\n")).not.toContain("private.txt");
	expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
		compactionModel: "example:low",
		custom: 42,
		toolDisplay: "compact",
	});
	h.dispose();
	h = harness(cwd);
	h.start();
	const restored = new ToolExecutionComponent(
		"read",
		"history",
		{ path: "private.txt" },
		{},
		h.tools.get("read"),
		h.ui,
		cwd,
	);
	expect(restored.render(80).join("\n")).toContain("read · pending");
	vi.mocked(h.ctx.ui.select).mockResolvedValue(undefined);
	expect(await h.configure(h.ctx)).toBe(false);
	vi.mocked(h.ctx.ui.select).mockResolvedValue("Normal");
	writeFileSync(path, "broken");
	await h.configure(h.ctx);
	expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Could not change"), "error");
	expect(readFileSync(path, "utf8")).toBe("broken");
	expect(restored.render(80).join("\n")).toContain("read · pending");
	writeFileSync(path, "{}");
	await h.configure(h.ctx);
	expect(loadToolDisplayMode()).toBe("normal");
	expect(restored.render(80).join("\n")).toContain("private.txt");
	h.dispose();
	writeFileSync(path, '{"toolDisplay":"invalid"}');
	expect(() => loadToolDisplayMode()).toThrow("invalid");
});

test("reload history built before session_start stays native while subsequent rows use the saved mode", () => {
	const cwd = directory();
	saveToolDisplayMode("compact");
	const h = harness(cwd);
	const args = { path: "history.txt" };
	// Pi's reload callback constructs historical components before session_start.
	const history = new ToolExecutionComponent("read", "old", args, {}, createReadToolDefinition(cwd), h.ui, cwd);
	h.start();
	const next = new ToolExecutionComponent("read", "new", args, {}, h.tools.get("read"), h.ui, cwd);
	expect(history.render(80).join("\n")).toContain("history.txt");
	expect(next.render(80).join("\n")).toContain("read · pending");
	expect(next.render(80).join("\n")).not.toContain("history.txt");
	expect(loadToolDisplayMode()).toBe("compact");
	h.dispose();
});

test("delegated execution uses current cwd and native shell settings without changing tool results", async () => {
	const cwd = directory();
	const other = join(cwd, "other");
	mkdirSync(other);
	writeFileSync(
		join(cwd, "settings.json"),
		JSON.stringify({ shellPath: "/bin/bash", shellCommandPrefix: "export SUITE_DISPLAY_TEST=from-prefix" }),
	);
	writeFileSync(join(cwd, "sample.txt"), "wrong-directory");
	writeFileSync(join(other, "sample.txt"), "right-directory");
	const h = harness(cwd);
	h.start();
	const current = { ...h.ctx, cwd: other };
	const read = await h.tools.get("read")!.execute("read", { path: "sample.txt" }, undefined, undefined, current);
	expect(read.content).toEqual([{ type: "text", text: "right-directory" }]);
	const bash = await h.tools
		.get("bash")!
		.execute("bash", { command: 'printf "%s\\n%s" "$PWD" "$SUITE_DISPLAY_TEST"' }, undefined, undefined, current);
	expect(bash.content).toEqual([{ type: "text", text: `${other}\nfrom-prefix` }]);
	saveToolDisplayMode("compact");
	expect(loadToolDisplayMode()).toBe("compact");
});
