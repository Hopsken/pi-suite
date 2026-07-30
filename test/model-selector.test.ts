import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "vitest";
import { type ModelChoice, ModelSelector } from "../src/model-selector.ts";

function model(id: string, name: string): Model<Api> {
	return {
		id,
		name,
		api: "test-api",
		provider: "test-provider",
		baseUrl: "http://localhost:0",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 10_000,
	};
}

describe("ModelSelector", () => {
	test("fuzzy-searches models by their human-readable names", () => {
		const requestedRender = vi.fn();
		const done = vi.fn<(choice: ModelChoice) => void>();
		const summaryModel = model("model-a", "Fast Summary Specialist");
		const codingModel = model("model-b", "Careful Coding Model");
		const selector = new ModelSelector(
			{ requestRender: requestedRender } as never,
			{
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			} as never,
			[summaryModel, codingModel],
			done,
			{ title: "Select Test Model", activeDescription: "Use active", currentModelId: summaryModel.id },
		);

		for (const character of "summary specialist") selector.handleInput(character);

		const rendered = selector.render(100).join("\n");
		expect(rendered).toContain("Fast Summary Specialist");
		expect(rendered).toContain("(current) model-a");
		expect(rendered).not.toContain("Careful Coding Model");

		selector.handleInput("\r");
		expect(done).toHaveBeenCalledWith({ type: "model", model: summaryModel });
		expect(requestedRender).toHaveBeenCalled();
	});
});
