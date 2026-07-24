import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";

type PackageManifest = {
	files: string[];
	pi: { extensions: string[]; skills?: string[] };
	bundleDependencies: string[];
	dependencies: Record<string, string>;
	peerDependencies: Record<string, string>;
};

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("package distribution", () => {
	test("declares and installs every bundled Pi extension resource", () => {
		const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8")) as PackageManifest;
		const extensions = [
			"./src/index.ts",
			"./node_modules/@juicesharp/rpiv-btw/index.ts",
			"./node_modules/@juicesharp/rpiv-ask-user-question/index.ts",
			"./node_modules/@tintinweb/pi-subagents/src/index.ts",
			"./node_modules/pi-web-access/index.ts",
		];

		expect(manifest.pi.extensions).toEqual(extensions);
		expect(manifest.pi.skills).toBeUndefined();
		expect(manifest.files).toContain("presets");
		expect(manifest.bundleDependencies).toEqual([
			"@juicesharp/rpiv-btw",
			"@juicesharp/rpiv-ask-user-question",
			"@tintinweb/pi-subagents",
			"pi-web-access",
		]);
		expect(manifest.dependencies["@juicesharp/rpiv-btw"]).toBe("2.0.0");
		expect(manifest.dependencies["@juicesharp/rpiv-ask-user-question"]).toBe("2.0.0");
		expect(manifest.dependencies["@tintinweb/pi-subagents"]).toBe("0.14.3");
		expect(manifest.dependencies["pi-web-access"]).toBe("0.13.0");
		expect(manifest.peerDependencies.typebox).toBe("*");

		for (const extension of extensions) {
			expect(existsSync(resolve(repositoryRoot, extension))).toBe(true);
		}
		expect(existsSync(resolve(repositoryRoot, "node_modules/@juicesharp/rpiv-btw/prompts/btw-system.txt"))).toBe(
			true,
		);
		expect(
			existsSync(resolve(repositoryRoot, "node_modules/@juicesharp/rpiv-ask-user-question/locales/en.json")),
		).toBe(true);
		expect(existsSync(resolve(repositoryRoot, "node_modules/@tintinweb/pi-subagents/src/default-agents.ts"))).toBe(
			true,
		);
		const explorePreset = readFileSync(resolve(repositoryRoot, "presets/agents/Explore.md"), "utf8");
		expect(explorePreset).toContain("Intelligently search your codebase");
		expect(explorePreset).toContain("tools: read, bash, grep, find, ls");
		expect(explorePreset).toContain("extensions: false");
		expect(explorePreset).toContain("skills: false");
		expect(explorePreset).toContain("model: openai-codex/gpt-5.6-terra");
		expect(explorePreset).toContain("thinking: low");
		expect(explorePreset).toContain("return only the distilled evidence");

		const oraclePreset = readFileSync(resolve(repositoryRoot, "presets/agents/Oracle.md"), "utf8");
		expect(oraclePreset).toContain("Consult a read-only expert for a second opinion");
		expect(oraclePreset).toContain("ext:pi-suite/oracle_research");
		expect(oraclePreset).toContain("ext:pi-web-access/web_search");
		expect(oraclePreset).toContain("ext:pi-web-access/fetch_content");
		expect(oraclePreset).toContain("ext:pi-web-access/get_search_content");
		expect(oraclePreset).toContain("disallowed_tools: edit, write");
		expect(oraclePreset).toContain("extensions: [pi-suite, pi-subagents, pi-web-access]");
		expect(oraclePreset).toContain("skills: false");
		expect(oraclePreset).toContain("model: openai-codex/gpt-5.6-sol");
		expect(oraclePreset).toContain("thinking: high");
		expect(oraclePreset).toContain("inherit_context: false");
		expect(oraclePreset).toContain("run_in_background: false");
		expect(oraclePreset).toContain("independent expert engineering adviser");
		expect(oraclePreset).toContain("parent agent remains responsible");
		expect(oraclePreset).toContain("You remain responsible for interpreting its findings");
	});

	test("Oracle frontmatter resolves to a read-only built-in set and only its intended extension tools", async () => {
		const { loadCustomAgents } = await vi.importActual<{
			loadCustomAgents(cwd: string): Map<string, Record<string, any>>;
		}>(resolve(repositoryRoot, "node_modules/@tintinweb/pi-subagents/src/custom-agents.ts"));
		const { installExtensionToolScope, parseExtSelectors } = await vi.importActual<{
			parseExtSelectors(entries: string[]): {
				extNames: Set<string>;
				narrowing: Map<string, Set<string>>;
			};
			installExtensionToolScope(session: unknown, config: Record<string, unknown>): void;
		}>(resolve(repositoryRoot, "node_modules/@tintinweb/pi-subagents/src/agent-runner.ts"));
		const directory = mkdtempSync(resolve(tmpdir(), "pi-suite-oracle-"));
		try {
			const agentsDirectory = resolve(directory, ".pi", "agents");
			mkdirSync(agentsDirectory, { recursive: true });
			writeFileSync(
				resolve(agentsDirectory, "Oracle.md"),
				readFileSync(resolve(repositoryRoot, "presets/agents/Oracle.md"), "utf8"),
				"utf8",
			);

			const oracle = loadCustomAgents(directory).get("Oracle");
			expect(oracle).toMatchObject({
				builtinToolNames: ["read", "bash", "edit", "write", "grep", "find", "ls"],
				disallowedTools: ["edit", "write"],
				extensions: ["pi-suite", "pi-subagents", "pi-web-access"],
				skills: false,
				model: "openai-codex/gpt-5.6-sol",
				thinking: "high",
				inheritContext: false,
				runInBackground: false,
			});

			const selectors = parseExtSelectors(oracle?.extSelectors ?? []);
			expect([...selectors.extNames]).toEqual(["pi-suite", "pi-web-access"]);
			expect([...(selectors.narrowing.get("pi-suite") ?? [])]).toEqual(["oracle_research"]);
			expect([...(selectors.narrowing.get("pi-web-access") ?? [])]).toEqual([
				"web_search",
				"fetch_content",
				"get_search_content",
			]);

			const allToolNames = [
				"read",
				"bash",
				"edit",
				"write",
				"grep",
				"find",
				"ls",
				"oracle_research",
				"Agent",
				"get_subagent_result",
				"steer_subagent",
				"web_search",
				"fetch_content",
				"get_search_content",
			];
			let activeToolNames: string[] = [];
			const session = {
				agent: { beforeToolCall: undefined },
				getAllTools: () => allToolNames.map((name) => ({ name })),
				getActiveToolNames: () => activeToolNames,
				setActiveToolsByName: (names: string[]) => {
					activeToolNames = names;
				},
				subscribe: () => () => {},
			};
			const extension = (path: string, toolNames: string[]) => ({
				path,
				tools: new Map(toolNames.map((name) => [name, {}])),
			});
			const loader = {
				getExtensions: () => ({
					extensions: [
						extension(resolve(repositoryRoot, "src/index.ts"), ["oracle_research"]),
						extension(resolve(repositoryRoot, "node_modules/@tintinweb/pi-subagents/src/index.ts"), [
							"Agent",
							"get_subagent_result",
							"steer_subagent",
						]),
						extension(resolve(repositoryRoot, "node_modules/pi-web-access/index.ts"), [
							"web_search",
							"fetch_content",
							"get_search_content",
						]),
					],
				}),
			};

			installExtensionToolScope(session, {
				loader,
				toolNames: oracle?.builtinToolNames,
				disallowedSet: new Set(oracle?.disallowedTools),
				extNames: selectors.extNames,
				narrowing: selectors.narrowing,
			});
			expect(activeToolNames).toEqual([
				"read",
				"bash",
				"grep",
				"find",
				"ls",
				"oracle_research",
				"web_search",
				"fetch_content",
				"get_search_content",
			]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
