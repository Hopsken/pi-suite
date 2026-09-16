import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Component, Text, type TuiMouseEvent } from "@earendil-works/pi-tui";

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
			return new ToolDisplayComponent(
				normal,
				new Text(theme.fg(color, `${tool.name} · ${status}`), tool.renderShell === "self" ? 1 : 0, 0),
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
