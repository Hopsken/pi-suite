import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { registerAvailableCliToolsPrompt } from "../src/available-cli-tools.ts";

type BeforeAgentStartHandler = (event: { systemPrompt: string }) => unknown;
type SessionStartHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

describe("available CLI tools prompt", () => {
	let binDirectory: string;
	let originalPath: string | undefined;
	let originalAgentDirectory: string | undefined;

	beforeEach(() => {
		binDirectory = mkdtempSync(join(tmpdir(), "pi-suite-bin-"));
		originalPath = process.env.PATH;
		originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;
		process.env.PATH = binDirectory;
		process.env.PI_CODING_AGENT_DIR = binDirectory;
	});

	afterEach(() => {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		if (originalAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;
		rmSync(binDirectory, { recursive: true, force: true });
	});

	function addCommand(name: string, executable = true, directory = binDirectory): void {
		const path = join(directory, name);
		writeFileSync(path, "#!/bin/sh\n", { encoding: "utf8", mode: executable ? 0o755 : 0o644 });
		chmodSync(path, executable ? 0o755 : 0o644);
	}

	function register(): { beforeAgentStart: BeforeAgentStartHandler; sessionStart: SessionStartHandler } {
		let beforeAgentStart: BeforeAgentStartHandler | undefined;
		let sessionStart: SessionStartHandler | undefined;
		registerAvailableCliToolsPrompt({
			on(event: string, candidate: BeforeAgentStartHandler | SessionStartHandler) {
				if (event === "before_agent_start") beforeAgentStart = candidate as BeforeAgentStartHandler;
				if (event === "session_start") sessionStart = candidate as SessionStartHandler;
			},
		} as never);
		expect(beforeAgentStart).toBeDefined();
		expect(sessionStart).toBeDefined();
		return { beforeAgentStart: beforeAgentStart!, sessionStart: sessionStart! };
	}

	async function startSession(handlers: ReturnType<typeof register>): Promise<void> {
		await handlers.sessionStart({ reason: "startup" }, { cwd: binDirectory, isProjectTrusted: () => true });
	}

	test("tells the agent which supported executables are available", async () => {
		addCommand("tmux");
		addCommand("rg");
		addCommand("sg");
		addCommand("ast-grep");
		addCommand("mise");
		addCommand("asdf");
		addCommand("nix");
		addCommand("gh");
		addCommand("glab");
		addCommand("unknown-tool");
		addCommand("jq", false);
		const handlers = register();
		await startSession(handlers);

		expect(handlers.beforeAgentStart({ systemPrompt: "Base prompt" })).toEqual({
			systemPrompt: [
				"Base prompt",
				"",
				"## Available CLI tools",
				"The following commonly used CLI tools were detected on PATH: `tmux`, ripgrep (`rg`), `ast-grep`, `mise`, `asdf`, Nix CLI (`nix`), GitHub CLI (`gh`), GitLab CLI (`glab`).",
				"Use them directly when appropriate; availability does not imply that a tool is configured or that its services are running.",
			].join("\n"),
		});
	});

	test("does not mistake the unrelated sg executable for ast-grep", async () => {
		addCommand("sg");
		const handlers = register();
		await startSession(handlers);

		expect(handlers.beforeAgentStart({ systemPrompt: "Base prompt" })).toBeUndefined();
	});

	test("does not change the prompt when no supported executable is available", async () => {
		addCommand("unknown-tool");
		const handlers = register();
		await startSession(handlers);

		expect(handlers.beforeAgentStart({ systemPrompt: "Base prompt" })).toBeUndefined();
	});

	test("uses the environment captured when the session starts", async () => {
		addCommand("pnpm");
		const handlers = register();
		await startSession(handlers);
		const replacementDirectory = join(binDirectory, "replacement");
		mkdirSync(replacementDirectory);
		process.env.PATH = replacementDirectory;

		expect(handlers.beforeAgentStart({ systemPrompt: "First turn" })).toMatchObject({
			systemPrompt: expect.stringContaining("`pnpm`"),
		});
		expect(handlers.beforeAgentStart({ systemPrompt: "Second turn" })).toMatchObject({
			systemPrompt: expect.stringMatching(/^Second turn\n\n## Available CLI tools/),
		});
	});

	test("uses the shell configured by Pi settings", async () => {
		addCommand("tmux");
		const configuredBinDirectory = join(binDirectory, "configured-bin");
		mkdirSync(configuredBinDirectory);
		addCommand("ffmpeg", true, configuredBinDirectory);
		addCommand("glab", true, configuredBinDirectory);
		const shellPath = join(binDirectory, "configured-shell");
		writeFileSync(
			shellPath,
			`#!/bin/sh\nprintf 'jq\\nstartup chatter\\n'\nPATH='${configuredBinDirectory}' exec /bin/sh "$@"\n`,
			{ encoding: "utf8", mode: 0o755 },
		);
		chmodSync(shellPath, 0o755);
		writeFileSync(join(binDirectory, "settings.json"), JSON.stringify({ shellPath }), "utf8");
		const handlers = register();
		await startSession(handlers);

		const result = handlers.beforeAgentStart({ systemPrompt: "Base prompt" });
		expect(result).toMatchObject({
			systemPrompt: expect.stringContaining("`ffmpeg`, GitLab CLI (`glab`)"),
		});
		expect(result).not.toMatchObject({ systemPrompt: expect.stringContaining("`tmux`") });
		expect(result).not.toMatchObject({ systemPrompt: expect.stringContaining("`jq`") });
		expect(result).not.toMatchObject({ systemPrompt: expect.stringContaining("startup chatter") });
	});

	test("applies Pi's shell command prefix before discovery", async () => {
		addCommand("tmux");
		const prefixedBinDirectory = join(binDirectory, "prefix-bin");
		mkdirSync(prefixedBinDirectory);
		addCommand("pnpm", true, prefixedBinDirectory);
		writeFileSync(
			join(binDirectory, "settings.json"),
			JSON.stringify({ shellCommandPrefix: `export PATH='${prefixedBinDirectory}'` }),
			"utf8",
		);
		const handlers = register();
		await startSession(handlers);

		const result = handlers.beforeAgentStart({ systemPrompt: "Base prompt" });
		expect(result).toMatchObject({ systemPrompt: expect.stringContaining("`pnpm`") });
		expect(result).not.toMatchObject({ systemPrompt: expect.stringContaining("`tmux`") });
	});

	test("keeps the previous prompt when discovery fails", async () => {
		addCommand("pnpm");
		const handlers = register();
		await startSession(handlers);
		writeFileSync(join(binDirectory, "settings.json"), JSON.stringify({ shellPath: "/missing/shell" }), "utf8");

		await startSession(handlers);

		expect(handlers.beforeAgentStart({ systemPrompt: "Base prompt" })).toMatchObject({
			systemPrompt: expect.stringContaining("`pnpm`"),
		});
	});
});
