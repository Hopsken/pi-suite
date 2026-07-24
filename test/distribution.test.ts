import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

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
		expect(existsSync(resolve(repositoryRoot, "presets/agents/Explore.md"))).toBe(true);
	});
});
