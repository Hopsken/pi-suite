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
import { withCompactRendering } from "./compact-renderer.ts";

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

export function registerToolDisplay(pi: ExtensionAPI): void {
	let registered = false;
	const registerBuiltIns = (ctx: ExtensionContext) => {
		if (registered) return;
		const active = pi.getActiveTools();
		for (const tool of pi.getAllTools()) {
			const factory = factories[tool.name];
			// Respect tools replaced by other extensions or an SDK host.
			if (!factory || tool.sourceInfo?.source !== "builtin") continue;
			const definition = withCompactRendering(factory(ctx));
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
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		try {
			registerBuiltIns(ctx);
		} catch (error) {
			ctx.ui.notify(`Could not register tool display: ${String(error)}`, "warning");
		}
	});
}
