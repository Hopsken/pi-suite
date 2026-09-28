import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { type Component, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadThinkAloudEnabled, saveThinkAloudEnabled } from "./state.ts";

export const THINK_ALOUD_TOOL_NAME = "think_aloud";

/** Render the note as an always-visible aside; tool expansion does not apply. */
class ThinkAloudNote implements Component {
	private readonly markdown: Markdown;
	private readonly bar: string;

	constructor(thought: string, bar: string) {
		this.markdown = new Markdown(thought, 0, 0, getMarkdownTheme());
		this.bar = bar;
	}

	render(width: number): string[] {
		if (width < 4) return [];
		return this.markdown.render(width - 3).map((line) => ` ${this.bar} ${line}`);
	}

	invalidate(): void {
		this.markdown.invalidate();
	}
}

const thinkAloudTool = defineTool({
	name: THINK_ALOUD_TOOL_NAME,
	label: "Think Aloud",
	description:
		"Show the user a brief note about reasoning that matters: the approach you are choosing and why, an assumption, a tradeoff, or evidence that changes your plan. The note is always visible to the user, even when thinking blocks and tool output are collapsed.",
	promptSnippet: "Show the user a brief key insight, decision, or change of plan",
	promptGuidelines: [
		"Use think_aloud to make important reasoning visible, because thinking blocks may be collapsed or hidden from the user: the approach you choose and why, an assumption you make, a tradeoff you settle, or evidence that changes your plan.",
		"Keep each think_aloud note to one to three sentences of conclusions and reasons. Do not use think_aloud to narrate routine actions, restate tool results, or replace your final answer.",
		"Call think_aloud in the same response as your next tool call rather than on its own, so it does not cost an extra turn.",
	],
	parameters: Type.Object({
		thought: Type.String({ minLength: 1, description: "The note to show the user, in Markdown." }),
	}),
	renderShell: "self",
	async execute() {
		return { content: [{ type: "text", text: "Shown to the user." }], details: undefined };
	},
	renderCall(args, theme) {
		// Streamed arguments may still be incomplete.
		return new ThinkAloudNote(typeof args.thought === "string" ? args.thought : "", theme.fg("borderAccent", "│"));
	},
	renderResult(result, _options, theme, context) {
		if (!context.isError) return new Text("", 0, 0);
		const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		return new Text(theme.fg("error", text), 1, 0);
	},
});

/** Registers the opt-in think_aloud tool and returns its Suite configuration step. */
export function registerThinkAloud(pi: ExtensionAPI) {
	let enabled = false;
	let registered = false;
	let loadError: string | undefined;
	try {
		enabled = loadThinkAloudEnabled();
	} catch (error) {
		loadError = `Could not load the think aloud setting: ${String(error)}`;
	}
	// Newly registered tools start active; later toggles only change the active set.
	const register = () => {
		pi.registerTool(thinkAloudTool);
		registered = true;
	};
	if (enabled) register();

	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "startup" && loadError && ctx.hasUI) ctx.ui.notify(loadError, "warning");
	});

	return async (ctx: ExtensionContext): Promise<boolean> => {
		const choice = await ctx.ui.select(`Think aloud (${enabled ? "on" : "off"})`, ["on", "off"]);
		if (!choice) return false;
		const next = choice === "on";
		try {
			saveThinkAloudEnabled(next);
		} catch (error) {
			ctx.ui.notify(`Could not save the think aloud setting: ${String(error)}`, "error");
			return true;
		}
		enabled = next;
		const others = pi.getActiveTools().filter((name) => name !== THINK_ALOUD_TOOL_NAME);
		if (!enabled) pi.setActiveTools(others);
		else if (registered) pi.setActiveTools([...others, THINK_ALOUD_TOOL_NAME]);
		else register();
		ctx.ui.notify(`Think aloud ${enabled ? "on" : "off"}`, "info");
		return true;
	};
}
