import { type Theme, VERSION } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text, type TUI } from "@earendil-works/pi-tui";

// Pi has no public transcript transform. Keep the private 0.85.1 contract here,
// fail closed on upgrades, and never replace tools or mutate session messages.
interface ToolRow extends Component {
	toolName: string;
	toolCallId: string;
	isPartial: boolean;
	executionStarted: boolean;
	result?: { isError: boolean };
}

function isToolRow(component: Component): component is ToolRow {
	return (
		"toolName" in component &&
		typeof component.toolName === "string" &&
		"toolCallId" in component &&
		typeof component.toolCallId === "string" &&
		"isPartial" in component &&
		typeof component.isPartial === "boolean" &&
		"executionStarted" in component &&
		typeof component.executionStarted === "boolean" &&
		"updateResult" in component &&
		typeof component.updateResult === "function"
	);
}

function summary(tools: ToolRow[], theme: Theme): Component {
	const counts = new Map<string, number>();
	let running = 0;
	let pending = 0;
	let failed = 0;
	for (const tool of tools) {
		counts.set(tool.toolName, (counts.get(tool.toolName) ?? 0) + 1);
		if (!tool.result || tool.isPartial) {
			if (tool.executionStarted) running++;
			else pending++;
		} else if (tool.result.isError) failed++;
	}
	const parts = Array.from(counts, ([name, count]) => `${name} ×${count}`);
	if (running) parts.push(`${running} running`);
	if (pending) parts.push(`${pending} pending`);
	const label = theme.fg("muted", parts.join(" · "));
	const errors = failed ? theme.fg("error", ` · ${failed} failed`) : "";
	return new Text(`\n${label}${errors}`, 1, 0);
}

export function installCompactRenderer(tui: TUI, theme: Theme, isCompact: () => boolean): () => void {
	if (VERSION !== "0.85.1") throw new Error(`Compact display supports Pi 0.85.1; found ${VERSION}.`);
	const document = tui.children[0];
	if (!(document instanceof Container) || document.children.length !== 3 || tui.children.length !== 7)
		throw new Error("Pi transcript layout is incompatible with compact display.");
	const chat = document.children[2];
	if (!(chat instanceof Container)) throw new Error("Pi chat container is unavailable.");
	const originalRender = chat.render;
	const render = (width: number): string[] => {
		if (!isCompact()) return originalRender.call(chat, width);
		const originalChildren = chat.children;
		const children: Component[] = [];
		let group: ToolRow[] = [];
		const flush = () => {
			if (group.length) children.push(summary(group, theme));
			group = [];
		};
		for (const child of originalChildren) {
			if (isToolRow(child)) group.push(child);
			else {
				// Invisible thinking/assistant rows still delimit groups.
				flush();
				children.push(child);
			}
		}
		flush();
		// Let Container build mouse hit regions for the displayed children, then
		// restore the exact native array before Pi receives any further events.
		chat.children = children;
		try {
			return originalRender.call(chat, width);
		} finally {
			chat.children = originalChildren;
		}
	};
	chat.render = render;
	return () => {
		if (chat.render === render) chat.render = originalRender;
		tui.requestRender(true);
	};
}
