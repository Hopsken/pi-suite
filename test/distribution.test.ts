import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

type PackageManifest = {
	pi: { extensions: string[] };
	bundledDependencies: string[];
	dependencies: Record<string, string>;
};

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("package distribution", () => {
	test("declares and installs every bundled Pi extension resource", () => {
		const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8")) as PackageManifest;
		const extensions = [
			"./src/index.ts",
			"./node_modules/@juicesharp/rpiv-btw/index.ts",
			"./node_modules/@juicesharp/rpiv-ask-user-question/index.ts",
		];

		expect(manifest.pi.extensions).toEqual(extensions);
		expect(manifest.bundledDependencies).toEqual(["@juicesharp/rpiv-btw", "@juicesharp/rpiv-ask-user-question"]);
		expect(manifest.dependencies["@juicesharp/rpiv-btw"]).toBe("2.0.0");
		expect(manifest.dependencies["@juicesharp/rpiv-ask-user-question"]).toBe("2.0.0");

		for (const extension of extensions) {
			expect(existsSync(resolve(repositoryRoot, extension))).toBe(true);
		}
		expect(existsSync(resolve(repositoryRoot, "node_modules/@juicesharp/rpiv-btw/prompts/btw-system.txt"))).toBe(
			true,
		);
		expect(
			existsSync(resolve(repositoryRoot, "node_modules/@juicesharp/rpiv-ask-user-question/locales/en.json")),
		).toBe(true);
	});
});
