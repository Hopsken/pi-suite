import { describe, expect, test, vi } from "vitest";
import { registerToolsSelector } from "../src/tools-selector.ts";

type Handler = (event: unknown, context: any) => unknown;

function createExtensionApi(activeTools: string[] = ["read", "bash"]) {
	const commands = new Map<string, { handler: Handler }>();
	const handlers = new Map<string, Handler>();
	const setActiveTools = vi.fn();
	const pi = {
		appendEntry: vi.fn(),
		getActiveTools: vi.fn(() => activeTools),
		getAllTools: vi.fn(() => [{ name: "read" }, { name: "bash" }, { name: "edit" }]),
		setActiveTools,
		registerCommand(name: string, command: { handler: Handler }) {
			commands.set(name, command);
		},
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
	};

	registerToolsSelector(pi as never);
	return { commands, handlers, pi, setActiveTools };
}

describe("tool selector", () => {
	test("registers /tools and rejects non-interactive use", async () => {
		const { commands } = createExtensionApi();
		const notify = vi.fn();

		await commands.get("tools")?.handler({}, { mode: "print", ui: { notify } });

		expect(notify).toHaveBeenCalledWith("/tools requires interactive mode.", "warning");
	});

	test("restores the latest branch selection and removes unavailable tools", () => {
		const { handlers, setActiveTools } = createExtensionApi();
		const context = {
			sessionManager: {
				getBranch: () => [
					{ type: "custom", customType: "tools-config", data: { enabledTools: ["read"] } },
					{ type: "custom", customType: "other", data: { enabledTools: ["edit"] } },
					{ type: "custom", customType: "tools-config", data: { enabledTools: ["bash", "removed"] } },
				],
			},
		};

		handlers.get("session_start")?.({}, context);

		expect(setActiveTools).toHaveBeenCalledWith(["bash"]);
	});

	test("tracks the active tool set when the branch has no saved selection", () => {
		const { handlers, pi, setActiveTools } = createExtensionApi(["edit"]);

		handlers.get("session_tree")?.({}, { sessionManager: { getBranch: () => [] } });

		expect(pi.getActiveTools).toHaveBeenCalledOnce();
		expect(setActiveTools).not.toHaveBeenCalled();
	});
});
