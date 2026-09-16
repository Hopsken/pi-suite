import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, expect, test, vi } from "vitest";
import { compactToolLine, withCompactRendering } from "../src/compact-renderer.ts";
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

test.each([
	["read", { path: "/repo/src/config.ts", offset: 20, limit: 61 }, "read src/config.ts:20–80 · done"],
	["read", { path: "config.ts", limit: 3 }, "read config.ts:1–3 · done"],
	["read", { path: "config.ts", offset: 7 }, "read config.ts:7– · done"],
	["read", { path: "config.ts", offset: "7", limit: -2 }, "read config.ts · done"],
	["bash", { command: "pnpm test\necho status\nexit 0\n" }, "bash pnpm test (+2 lines) · done"],
	[
		"powershell",
		{ command: "Get-Content config.ts\r\nWrite-Output done" },
		"powershell Get-Content config.ts (+1 line) · done",
	],
	[
		"edit",
		{ file_path: "config.ts", edits: [{ oldText: "secret" }, { newText: "secret" }] },
		"edit config.ts (2 edits) · done",
	],
	["write", { path: "config.ts", content: "secret" }, "write config.ts · done"],
	["grep", { pattern: "timeout", path: "src/" }, 'grep "timeout" in src/ · done'],
	["find", { pattern: "*.ts", path: "/repo" }, 'find "*.ts" in . · done'],
	["ls", { path: "/repository/external" }, "ls /repository/external · done"],
	["read", { path: { incomplete: true } }, "read · done"],
	["bash", undefined, "bash · done"],
	["grep", { pattern: "\u001b[31mred\u001b[0m\nline\tend" }, 'grep "red line end" · done'],
] as const)("formats %s arguments without JSON or payloads", (name, args, expected) => {
	expect(compactToolLine(name, args, "/repo", "done", 120)).toBe(expected);
});

test("truncates by terminal cells, preserves path tails and reserves status and command line counts", () => {
	expect(compactToolLine("read", { path: "very/long/path/to/config.ts" }, "/repo", "done", 30)).toBe(
		"read …path/to/config.ts · done",
	);
	const command = { command: `printf '${"界🙂".repeat(40)}'\necho hidden\nexit 0` };
	const line = compactToolLine("bash", command, "/repo", "failed", 46);
	expect(line).toContain("bash printf");
	expect(line).toContain("… (+2 lines) · failed");
	expect(line).not.toContain("echo hidden");
	for (let width = 0; width <= 60; width++) {
		for (const [name, args] of [
			["bash", command],
			["read", { path: `${"界🙂/".repeat(15)}config.ts`, offset: 3, limit: 9 }],
		] as const) {
			const value = compactToolLine(name, args, "/repo", "running", width);
			expect(visibleWidth(value)).toBeLessThanOrEqual(width);
			expect(value).not.toMatch(/[\n\r\x1b]/);
		}
	}
});

test("all eight built-ins show compact summaries only when collapsed, and restore native detail when expanded", () => {
	const cwd = directory();
	const ui = { requestRender: vi.fn() } as unknown as TUI;
	for (const factory of factories) {
		const original = factory(cwd) as ToolDefinition<any, any>;
		const wrapped = withCompactRendering(original);
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
		for (const expanded of [false, true, false]) {
			native.setExpanded(expanded);
			row.setExpanded(expanded);
			if (expanded) {
				expect(row.render(80)).toEqual(native.render(80));
			} else {
				expect(row.render(80).join("\n")).toContain("· failed");
				expect(row.render(80).join("\n")).not.toMatch(/private-content|private-result/);
			}
		}
	}
});

test("pending, running, partial and completed calls update through public render contexts; native timers stop", () => {
	vi.useFakeTimers();
	const cwd = directory();
	const tool = withCompactRendering(createBashToolDefinition(cwd));
	const row = new ToolExecutionComponent(
		"bash",
		"live",
		{ command: "printf private" },
		{},
		tool,
		{ requestRender: vi.fn() } as unknown as TUI,
		cwd,
	);
	expect(row.render(60).join("\n")).toContain("bash printf private · pending");
	row.markExecutionStarted();
	expect(row.render(60).join("\n")).toContain("bash printf private · running");
	row.updateResult({ content: [{ type: "text", text: "private-partial" }], isError: false }, true);
	expect(vi.getTimerCount()).toBeGreaterThan(0);
	row.setExpanded(true);
	expect(row.render(60).join("\n")).toContain("private-partial");
	row.setExpanded(false);
	expect(row.render(60).join("\n")).not.toContain("private-partial");
	row.updateResult({ content: [{ type: "text", text: "private-final" }], isError: false });
	expect(vi.getTimerCount()).toBe(0);
	expect(row.render(60).join("\n")).toContain("bash printf private · done");
	expect(row.render(60).join("\n")).not.toContain("private-final");
	row.setExpanded(true);
	expect(row.render(60).join("\n")).toContain("private-final");
});

function harness(cwd: string, mode = "tui") {
	const tools = new Map<string, ToolDefinition<any, any>>();
	let start: (event: unknown, ctx: ExtensionContext) => void;
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
			notify: vi.fn(),
		},
	} as unknown as ExtensionContext;
	registerToolDisplay(pi as never);
	return { tools, pi, ctx, ui, start: () => start({}, ctx) };
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

test.each([undefined, "normal", "compact", "invalid"])(
	"summaries need no setting and ignore legacy mode %s without writing config",
	(mode) => {
		const cwd = directory();
		const path = join(cwd, "pi-suite.json");
		const saved = JSON.stringify({ compactionModel: "example:low", custom: 42, toolDisplay: mode });
		if (mode !== undefined) writeFileSync(path, saved);
		const h = harness(cwd);
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
		expect(row.render(80).join("\n")).toContain("read private.txt · pending");
		row.setExpanded(true);
		expect(row.render(80).join("\n")).not.toContain("· pending");
		row.setExpanded(false);
		h.start();
		expect(row.render(80).join("\n")).toContain("read private.txt · pending");
		expect(h.ctx.ui.notify).not.toHaveBeenCalled();
		if (mode === undefined) expect(existsSync(path)).toBe(false);
		else expect(readFileSync(path, "utf8")).toBe(saved);
	},
);

test("reload history built before session_start stays native while subsequent rows use summaries", () => {
	const cwd = directory();
	const h = harness(cwd);
	const args = { path: "history.txt" };
	// Pi's reload callback constructs historical components before session_start.
	const history = new ToolExecutionComponent("read", "old", args, {}, createReadToolDefinition(cwd), h.ui, cwd);
	h.start();
	const next = new ToolExecutionComponent("read", "new", args, {}, h.tools.get("read"), h.ui, cwd);
	expect(history.render(80).join("\n")).toContain("history.txt");
	expect(history.render(80).join("\n")).not.toContain("· pending");
	expect(next.render(80).join("\n")).toContain("read history.txt · pending");
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
});
