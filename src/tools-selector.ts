import {
	type ExtensionAPI,
	type ExtensionContext,
	getSettingsListTheme,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";

interface ToolsState {
	enabledTools: string[];
}

/** Registers the interactive, branch-aware tool selector. */
export function registerToolsSelector(pi: ExtensionAPI): void {
	let enabledTools = new Set<string>();
	let allTools: ToolInfo[] = [];

	const persistState = (): void => {
		pi.appendEntry<ToolsState>("tools-config", {
			enabledTools: Array.from(enabledTools),
		});
	};

	const applyTools = (): void => {
		pi.setActiveTools(Array.from(enabledTools));
	};

	const restoreFromBranch = (ctx: ExtensionContext): void => {
		allTools = pi.getAllTools();
		let savedTools: string[] | undefined;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === "tools-config") {
				const data = entry.data as ToolsState | undefined;
				if (data?.enabledTools) savedTools = data.enabledTools;
			}
		}

		if (!savedTools) {
			enabledTools = new Set(pi.getActiveTools());
			return;
		}

		const availableToolNames = new Set(allTools.map((tool) => tool.name));
		enabledTools = new Set(savedTools.filter((name) => availableToolNames.has(name)));
		applyTools();
	};

	pi.registerCommand("tools", {
		description: "Enable or disable tools",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/tools requires interactive mode.", "warning");
				return;
			}

			allTools = pi.getAllTools();

			await ctx.ui.custom((tui, theme, _keybindings, done) => {
				const items: SettingItem[] = allTools.map((tool) => ({
					id: tool.name,
					label: tool.name,
					currentValue: enabledTools.has(tool.name) ? "enabled" : "disabled",
					values: ["enabled", "disabled"],
				}));

				const container = new Container();
				container.addChild(
					new (class {
						render(): string[] {
							return [theme.fg("accent", theme.bold("Tool Configuration")), ""];
						}

						invalidate(): void {}
					})(),
				);

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 15),
					getSettingsListTheme(),
					(id, value) => {
						if (value === "enabled") enabledTools.add(id);
						else enabledTools.delete(id);
						applyTools();
						persistState();
					},
					() => done(undefined),
				);
				container.addChild(settingsList);

				return {
					render: (width: number) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};
			});
		},
	});

	pi.on("session_start", (_event, ctx) => restoreFromBranch(ctx));
	pi.on("session_tree", (_event, ctx) => restoreFromBranch(ctx));
}
