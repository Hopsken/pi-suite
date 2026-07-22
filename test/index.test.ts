import { beforeEach, describe, expect, test, vi } from "vitest";

const { compactMock } = vi.hoisted(() => ({ compactMock: vi.fn() }));

vi.mock("@earendil-works/pi-coding-agent", () => ({ compact: compactMock }));

import piSuite from "../src/index.ts";
import { COMPACTION_MODEL_ENTRY } from "../src/state.ts";

type Handler = (event: any, context: any) => any;

function createExtensionApi() {
	const commands = new Map<string, { handler: Handler }>();
	const handlers = new Map<string, Handler>();
	const appendEntry = vi.fn();
	const pi = {
		registerCommand(name: string, command: { handler: Handler }) {
			commands.set(name, command);
		},
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		appendEntry,
	};

	piSuite(pi as never);
	return { appendEntry, commands, handlers };
}

describe("compaction model extension", () => {
	beforeEach(() => compactMock.mockReset());

	test("selects a model and thinking level, then delegates to native compaction", async () => {
		const { appendEntry, commands, handlers } = createExtensionApi();
		const model = {
			provider: "test-provider",
			id: "summary-model",
			name: "Summary Model",
			reasoning: true,
		};
		const select = vi
			.fn()
			.mockResolvedValueOnce("test-provider/summary-model — Summary Model")
			.mockResolvedValueOnce("high");
		const context = {
			hasUI: true,
			ui: { select, notify: vi.fn() },
			modelRegistry: {
				getAvailable: () => [model],
				find: () => model,
				getApiKeyAndHeaders: async () => ({
					ok: true,
					apiKey: "secret",
					headers: { "x-test": "yes" },
					env: { TEST_ENV: "yes" },
				}),
			},
			sessionManager: { getBranch: () => [] },
		};

		await commands.get("compaction-model")?.handler("", context);

		expect(appendEntry).toHaveBeenCalledWith(COMPACTION_MODEL_ENTRY, {
			version: 1,
			selection: {
				provider: "test-provider",
				modelId: "summary-model",
				thinkingLevel: "high",
			},
		});

		const result = { summary: "compact", firstKeptEntryId: "kept", tokensBefore: 100 };
		compactMock.mockResolvedValue(result);
		const signal = new AbortController().signal;
		const preparation = {
			fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
		};
		const event = {
			preparation,
			branchEntries: [],
			customInstructions: "Focus on decisions",
			signal,
		};

		await expect(handlers.get("session_before_compact")?.(event, context)).resolves.toEqual({ compaction: result });
		expect(compactMock).toHaveBeenCalledWith(
			expect.objectContaining({ fileOps: preparation.fileOps }),
			model,
			"secret",
			{ "x-test": "yes" },
			"Focus on decisions",
			signal,
			"high",
			undefined,
			{ TEST_ENV: "yes" },
		);
	});
});
