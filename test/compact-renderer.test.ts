import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getPackageDir, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, expect, test, vi } from "vitest";
import { installCompactRenderer } from "../src/compact-renderer.ts";
import { loadToolDisplayMode, saveToolDisplayMode } from "../src/state.ts";
import { registerToolDisplay } from "../src/tool-display.ts";

// Exercise actual Pi components, including their private compatibility fields.
const base = join(getPackageDir(), "dist/modes/interactive");
const { ToolExecutionComponent } = await import(pathToFileURL(join(base, "components/tool-execution.js")).href);
const { AssistantMessageComponent } = await import(pathToFileURL(join(base, "components/assistant-message.js")).href);
const { theme }: { theme: Theme } = await import(pathToFileURL(join(base, "theme/theme.js")).href);
initTheme("dark", false);

function fixture() {
	const chat = new Container();
	const document = new Container();
	document.addChild(new Container());
	document.addChild(new Container());
	document.addChild(chat);
	const root = new Container();
	root.addChild(document);
	for (let i = 0; i < 6; i++) root.addChild(new Container());
	const tui = Object.assign(root, { requestRender: vi.fn() }) as unknown as TUI;
	const tool = (name: string, id: string) => {
		const row = new ToolExecutionComponent(name, id, { command: "secret-argument" }, {}, undefined, tui, "/tmp");
		chat.addChild(row);
		return row;
	};
	const thought = new AssistantMessageComponent(
		fauxAssistantMessage([{ type: "thinking", thinking: "Check the configuration first." }]),
	);
	chat.addChild(thought);
	const first = tool("bash", "first");
	first.markExecutionStarted();
	const second = tool("read", "second");
	second.updateResult({ content: [{ type: "text", text: "private-tool-output" }], isError: false });
	const third = tool("bash", "third");
	third.updateResult({ content: [{ type: "text", text: "failure-details" }], isError: true });
	const boundary = new Container(); // A hidden assistant row must still separate groups.
	chat.addChild(boundary);
	const extension = tool("web_search", "fourth");
	chat.addChild(new Text("Final answer: configuration fixed.", 1, 0));
	return { chat, tui, first, second, third, extension, thought };
}

test("groups real native and extension rows, retains hidden boundaries and restores exact normal output", () => {
	const f = fixture();
	const native = f.chat.render(100);
	const originalChildren = f.chat.children;
	let compact = true;
	const detach = installCompactRenderer(f.tui, theme, () => compact);
	const output = f.chat.render(100).join("\n");
	expect(output).toContain("bash ×2 · read ×1 · 1 running");
	expect(output).toContain("1 failed");
	expect(output).toContain("web_search ×1 · 1 pending");
	expect(output).toContain("Check the configuration first.");
	expect(output).toContain("Final answer: configuration fixed.");
	expect(output).not.toMatch(/secret-argument|private-tool-output|failure-details/);
	expect(f.chat.children).toBe(originalChildren);
	f.thought.setHideThinkingBlock(true);
	expect(f.chat.render(100).join("\n")).not.toContain("Check the configuration first.");
	expect(f.chat.render(100).join("\n")).toContain("web_search ×1");
	f.thought.setHideThinkingBlock(false);
	compact = false;
	expect(f.chat.render(100)).toEqual(native);
	compact = true;
	detach();
	expect(f.chat.render(100)).toEqual(native);
});

test("refreshes partial, parallel completion, rebuilt history and narrow widths without accumulating counts", () => {
	const f = fixture();
	const detach = installCompactRenderer(f.tui, theme, () => true);
	f.first.updateResult({ content: [{ type: "text", text: "partial" }], isError: false }, true);
	expect(f.chat.render(100).join("\n")).toContain("1 running");
	f.extension.updateResult({ content: [], isError: false });
	f.first.updateResult({ content: [], isError: false });
	for (let i = 0; i < 3; i++) {
		const text = f.chat.render(100).join("\n");
		expect(text).toContain("bash ×2 · read ×1");
		expect(text).not.toMatch(/running|pending/);
	}
	for (const line of f.chat.render(18)) expect(visibleWidth(line)).toBeLessThanOrEqual(18);
	f.chat.clear();
	f.chat.addChild(f.extension);
	expect(f.chat.render(100).join("\n")).toContain("web_search ×1");
	expect(f.chat.render(100).join("\n")).not.toContain("bash");
	detach();
});

test("restores child ownership even if a native component throws", () => {
	const f = fixture();
	const children = f.chat.children;
	const detach = installCompactRenderer(f.tui, theme, () => true);
	f.chat.addChild({
		render: () => {
			throw new Error("render failure");
		},
		invalidate() {},
	});
	expect(() => f.chat.render(100)).toThrow("render failure");
	expect(f.chat.children).toBe(children);
	detach();
	expect(() => installCompactRenderer(new Container() as TUI, theme, () => true)).toThrow("incompatible");
});

const directories: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function configDirectory() {
	const directory = mkdtempSync(join(tmpdir(), "suite-display-"));
	directories.push(directory);
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
	return directory;
}

test("defaults to normal, preserves settings, persists both choices, and refuses malformed config", () => {
	const directory = configDirectory();
	const path = join(directory, "pi-suite.json");
	expect(loadToolDisplayMode()).toBe("normal");
	writeFileSync(path, '{"compactionModel":"example:low","custom":42}');
	saveToolDisplayMode("compact");
	expect(loadToolDisplayMode()).toBe("compact");
	expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
		compactionModel: "example:low",
		custom: 42,
		toolDisplay: "compact",
	});
	saveToolDisplayMode("normal");
	expect(loadToolDisplayMode()).toBe("normal");
	writeFileSync(path, '{"toolDisplay":"unknown"}');
	expect(() => loadToolDisplayMode()).toThrow("invalid");
	writeFileSync(path, "broken");
	expect(() => saveToolDisplayMode("compact")).toThrow();
	expect(readFileSync(path, "utf8")).toBe("broken");
});

test("menu selection, reload disposal, persisted restoration, cancellation and failed saves", async () => {
	const directory = configDirectory();
	const f = fixture();
	const nativeRender = f.chat.render;
	let start: any;
	let widget: any;
	const pi = {
		on: (_name: string, handler: any) => {
			start = handler;
		},
	};
	const ctx: any = {
		mode: "tui",
		ui: {
			select: vi.fn().mockResolvedValue("Compact"),
			notify: vi.fn(),
			setWidget: (_key: string, factory: any) => {
				widget?.dispose();
				widget = factory(f.tui, theme);
			},
		},
	};
	let configure = registerToolDisplay(pi as never);
	start({}, ctx);
	expect(f.chat.render).toBe(nativeRender);
	await configure(ctx);
	expect(loadToolDisplayMode()).toBe("compact");
	expect(f.chat.render(100).join("\n")).toContain("bash ×2");
	widget.dispose();
	expect(f.chat.render).toBe(nativeRender);
	widget = undefined;
	configure = registerToolDisplay(pi as never);
	start({}, ctx);
	expect(f.chat.render(100).join("\n")).toContain("bash ×2");
	ctx.ui.select.mockResolvedValue(undefined);
	expect(await configure(ctx)).toBe(false);
	expect(loadToolDisplayMode()).toBe("compact");
	ctx.ui.select.mockResolvedValue("Normal");
	writeFileSync(join(directory, "pi-suite.json"), "broken");
	await configure(ctx);
	expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Could not change"), "error");
	expect(f.chat.render(100).join("\n")).toContain("bash ×2");
	writeFileSync(join(directory, "pi-suite.json"), "{}");
	await configure(ctx);
	expect(loadToolDisplayMode()).toBe("normal");
	expect(f.chat.render(100).join("\n")).toContain("private-tool-output");
	widget.dispose();
});
