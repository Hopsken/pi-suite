import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { withCompactRendering } from "./compact-renderer.ts";
import { loadToolDisplayMode, saveToolDisplayMode, type ToolDisplayMode } from "./state.ts";

function settings(ctx: ExtensionContext): SettingsManager {
	return SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
}

const factories: Record<string, (ctx: ExtensionContext) => ToolDefinition<any, any>> = {
	read: (ctx) => createReadToolDefinition(ctx.cwd, { autoResizeImages: settings(ctx).getImageAutoResize() }),
	bash: (ctx) => {
		const config = settings(ctx);
		return createBashToolDefinition(ctx.cwd, {
			commandPrefix: config.getShellCommandPrefix(),
			shellPath: config.getShellPath(),
		});
	},
	powershell: (ctx) => createPowerShellToolDefinition(ctx.cwd),
	edit: (ctx) => createEditToolDefinition(ctx.cwd),
	write: (ctx) => createWriteToolDefinition(ctx.cwd),
	find: (ctx) => createFindToolDefinition(ctx.cwd),
	grep: (ctx) => createGrepToolDefinition(ctx.cwd),
	ls: (ctx) => createLsToolDefinition(ctx.cwd),
};

export function registerToolDisplay(pi: ExtensionAPI): (ctx: ExtensionContext) => Promise<boolean> {
	let mode: ToolDisplayMode = "normal";
	let tui: TUI | undefined;
	let registered = false;
	const registerBuiltIns = (ctx: ExtensionContext) => {
		if (registered) return;
		const active = pi.getActiveTools();
		for (const tool of pi.getAllTools()) {
			const factory = factories[tool.name];
			// Respect tools replaced by other extensions or an SDK host.
			if (!factory || tool.sourceInfo?.source !== "builtin") continue;
			const definition = withCompactRendering(factory(ctx), () => mode === "compact");
			pi.registerTool({
				...definition,
				// Resolve cwd and trusted settings at execution time, including after
				// a session switch. Preserve the native validation and execution fields.
				execute: (id, args, signal, update, current) => factory(current).execute(id, args, signal, update, current),
			});
		}
		pi.setActiveTools(active);
		registered = true;
	};
	const attach = (ctx: ExtensionContext) => {
		if (tui) return;
		ctx.ui.setWidget("suite-tool-display", (ui) => {
			tui = ui;
			return {
				render: () => [],
				invalidate: () => {},
				dispose: () => {
					tui = undefined;
				},
			};
		});
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		mode = "normal";
		try {
			registerBuiltIns(ctx);
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
