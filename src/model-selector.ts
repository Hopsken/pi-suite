import type { Api, Model } from "@earendil-works/pi-ai";
import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	SelectList,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";

const ACTIVE_MODEL_LABEL = "Use active session model (default)";

export type ModelChoice = { type: "active" } | { type: "model"; model: Model<Api> } | undefined;

export interface ModelSelectorCopy {
	title: string;
	activeDescription: string;
}

interface SearchableChoice {
	key: string;
	label: string;
	description: string;
	searchText: string;
	result: Exclude<ModelChoice, undefined>;
}

function modelSearchText(model: Model<Api>): string {
	return `${model.provider} ${model.provider}/${model.id} ${model.provider} ${model.id} ${model.name}`;
}

/** Searchable model picker built from the same public Pi TUI primitives as Pi's model selector. */
export class ModelSelector extends Container implements Focusable {
	private readonly searchInput = new Input();
	private readonly listContainer = new Container();
	private readonly choices: SearchableChoice[];
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly done: (choice: ModelChoice) => void;
	private selectList: SelectList | undefined;
	private _focused = false;

	constructor(
		tui: TUI,
		theme: Theme,
		models: Model<Api>[],
		done: (choice: ModelChoice) => void,
		copy: ModelSelectorCopy,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.choices = [
			{
				key: "active",
				label: ACTIVE_MODEL_LABEL,
				description: copy.activeDescription,
				searchText: "active session model default",
				result: { type: "active" },
			},
			...models.map((model) => ({
				key: `${model.provider}/${model.id}`,
				label: `${model.id} [${model.provider}]`,
				description: model.name,
				searchText: modelSearchText(model),
				result: { type: "model" as const, model },
			})),
		];

		this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		this.addChild(new Text(theme.fg("accent", theme.bold(copy.title))));
		this.addChild(new Text(theme.fg("muted", "Type to search by provider, model ID, or model name")));
		this.addChild(new Spacer(1));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "↑↓ navigate • Enter select • Esc cancel")));
		this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));

		this.updateList("");
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.done(undefined);
			return;
		}

		if (
			keybindings.matches(data, "tui.select.up") ||
			keybindings.matches(data, "tui.select.down") ||
			keybindings.matches(data, "tui.select.confirm")
		) {
			this.selectList?.handleInput(data);
		} else {
			this.searchInput.handleInput(data);
			this.updateList(this.searchInput.getValue());
		}
		this.tui.requestRender();
	}

	private updateList(query: string): void {
		this.listContainer.clear();
		const matches = fuzzyFilter(this.choices, query, (choice) => choice.searchText);
		if (matches.length === 0) {
			this.selectList = undefined;
			this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching models")));
			return;
		}

		this.selectList = new SelectList(
			matches.map((choice) => ({
				value: choice.key,
				label: choice.label,
				description: choice.description,
			})),
			10,
			{
				selectedPrefix: (text) => this.theme.fg("accent", text),
				selectedText: (text) => this.theme.fg("accent", text),
				description: (text) => this.theme.fg("muted", text),
				scrollInfo: (text) => this.theme.fg("dim", text),
				noMatch: (text) => this.theme.fg("muted", text),
			},
		);
		this.selectList.onSelect = (item) => this.done(matches.find((choice) => choice.key === item.value)?.result);
		this.selectList.onCancel = () => this.done(undefined);
		this.listContainer.addChild(this.selectList);
	}
}
