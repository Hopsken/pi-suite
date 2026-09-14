import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { installCompactRenderer } from "./compact-renderer.ts";
import { loadToolDisplayMode, saveToolDisplayMode, type ToolDisplayMode } from "./state.ts";

export function registerToolDisplay(pi: ExtensionAPI): (ctx: ExtensionContext) => Promise<boolean> {
	let mode: ToolDisplayMode = "normal";
	let tui: TUI | undefined;
	const attach = (ctx: ExtensionContext) => {
		if (tui) return;
		ctx.ui.setWidget("suite-tool-display", (ui, theme) => {
			const detach = installCompactRenderer(ui, theme, () => mode === "compact");
			tui = ui;
			return {
				render: () => [],
				invalidate: () => {},
				dispose: () => {
					detach();
					tui = undefined;
				},
			};
		});
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		mode = "normal";
		try {
			const saved = loadToolDisplayMode();
			if (saved === "compact") attach(ctx);
			mode = saved;
			tui?.requestRender(true);
		} catch (error) {
			ctx.ui.notify(`Could not restore tool display: ${String(error)} Using normal display.`, "warning");
		}
	});

	return async (ctx) => {
		const selected = await ctx.ui.select("Tool display", ["Normal", "Compact"]);
		if (!selected) return false;
		const next = selected === "Compact" ? "compact" : "normal";
		try {
			if (next === "compact") attach(ctx);
			saveToolDisplayMode(next);
			mode = next;
			tui?.requestRender(true);
			ctx.ui.notify(`Tool display: ${next}.`, "info");
		} catch (error) {
			ctx.ui.notify(`Could not change tool display: ${String(error)}`, "error");
		}
		return true;
	};
}
