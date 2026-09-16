import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	sliceByColumn,
	stripTerminalSequences,
	Text,
	type TuiMouseEvent,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

function singleLine(value: unknown): string {
	return typeof value === "string"
		? stripTerminalSequences(value)
				.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ")
				.trim()
		: "";
}

function displayPath(value: unknown, cwd: string): string {
	if (typeof value !== "string" || !value) return "";
	const absolute = resolve(cwd, value.startsWith(`~${sep}`) ? resolve(homedir(), value.slice(2)) : value);
	const local = relative(cwd, absolute);
	const inCwd = !isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`);
	const path = inCwd ? local || "." : absolute;
	return singleLine(path) + (value.endsWith(sep) && !path.endsWith(sep) ? sep : "");
}

/** Format known argument fields only; never stringify streamed argument objects. */
export function compactToolLine(name: string, input: unknown, cwd: string, status: string, width: number): string {
	const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
	let detail = "";
	let extra = "";
	let keepTail = false;
	if (name === "bash" || name === "powershell") {
		const lines = typeof args.command === "string" ? args.command.trim().split(/\r\n|\r|\n/) : [];
		detail = singleLine(lines[0]);
		if (lines.length > 1) extra = ` (+${lines.length - 1} ${lines.length === 2 ? "line" : "lines"})`;
	} else if (name === "grep" || name === "find") {
		const pattern = singleLine(args.pattern);
		const path = displayPath(args.path, cwd);
		detail = pattern ? `"${pattern}"${path ? ` in ${path}` : ""}` : path;
	} else {
		detail = displayPath(args.path ?? args.file_path, cwd);
		keepTail = true;
		if (name === "read") {
			const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
			const offset = positive(args.offset) ? args.offset : 1;
			if (positive(args.limit)) extra = `:${offset}–${offset + args.limit - 1}`;
			else if (positive(args.offset)) extra = `:${offset}–`;
		} else if (name === "edit" && Array.isArray(args.edits) && args.edits.length > 1) {
			extra = ` (${args.edits.length} edits)`;
		}
	}
	const statusText = ` · ${status}`;
	if (!detail) return stripTerminalSequences(truncateToWidth(`${name}${statusText}`, Math.max(0, width), "…"));
	const prefix = `${name} `;
	const tail = `${extra}${statusText}`;
	const available = width - visibleWidth(prefix) - visibleWidth(tail);
	if (available < 1) return stripTerminalSequences(truncateToWidth(`${name}${statusText}`, Math.max(0, width), "…"));
	if (visibleWidth(detail) > available) {
		detail = keepTail
			? `…${sliceByColumn(detail, visibleWidth(detail) - available + 1, available - 1)}`
			: truncateToWidth(detail, available, "…");
	}
	return stripTerminalSequences(`${prefix}${detail}${tail}`);
}

/** Keep native renderer components separate from the compact presentation. */
class ToolDisplayComponent implements Component {
	readonly normal: Component;
	private readonly minimal: Component;
	private readonly isCompact: () => boolean;

	constructor(normal: Component, minimal: Component, isCompact: () => boolean) {
		this.normal = normal;
		this.minimal = minimal;
		this.isCompact = isCompact;
	}

	render(width: number): string[] {
		return (this.isCompact() ? this.minimal : this.normal).render(width);
	}

	invalidate(): void {
		this.normal.invalidate();
		this.minimal.invalidate();
	}

	handleMouse(event: TuiMouseEvent) {
		if (!this.isCompact()) return this.normal.handleMouse?.(event);
		return undefined;
	}
}

/** Decorate only the public rendering slots; preserve the tool's other fields. */
export function withCompactRendering(
	tool: ToolDefinition<any, any>,
	isCompact: () => boolean,
): ToolDefinition<any, any> {
	const call = tool.renderCall;
	const result = tool.renderResult;
	if (!call || !result) throw new Error(`Built-in tool ${tool.name} does not provide renderers.`);
	return {
		...tool,
		renderCall(args, theme, context) {
			const previous = context.lastComponent;
			const normal = call(args, theme, {
				...context,
				lastComponent: previous instanceof ToolDisplayComponent ? previous.normal : undefined,
			});
			const status = context.isError
				? "failed"
				: !context.isPartial
					? "done"
					: context.executionStarted
						? "running"
						: "pending";
			const color = context.isError ? "error" : "muted";
			const padding = tool.renderShell === "self" ? 1 : 0;
			return new ToolDisplayComponent(
				normal,
				{
					render: (width) => [
						" ".repeat(Math.min(padding, width)) +
							theme.fg(color, compactToolLine(tool.name, args, context.cwd, status, width - padding)),
					],
					invalidate() {},
				},
				isCompact,
			);
		},
		renderResult(value, options, theme, context) {
			const previous = context.lastComponent;
			// Keep calling the native renderer in compact mode too. Some native
			// renderers maintain timers and preview state until the final result.
			const normal = result(value, options, theme, {
				...context,
				lastComponent: previous instanceof ToolDisplayComponent ? previous.normal : undefined,
			});
			return new ToolDisplayComponent(normal, new Text("", 0, 0), isCompact);
		},
	};
}
