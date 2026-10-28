import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";

type PackageManifest = {
  pi: { extensions: string[]; skills?: string[] };
  bundleDependencies: string[];
  dependencies: Record<string, string>;
};

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("package distribution", () => {
  test("every declared Pi resource exists and every bundled extension is a pinned bundled dependency", () => {
    const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8")) as PackageManifest;

    for (const path of [...manifest.pi.extensions, ...(manifest.pi.skills ?? [])]) {
      expect(existsSync(resolve(repositoryRoot, path)), path).toBe(true);
    }
    for (const extension of manifest.pi.extensions.filter((path) => path.startsWith("./node_modules/"))) {
      const name = /^\.\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(extension)![1]!;
      expect(manifest.bundleDependencies, extension).toContain(name);
      expect(manifest.dependencies[name], extension).toMatch(/^\d+\.\d+\.\d+$/);
    }
    // Files the bundled extensions read at runtime, outside their entry points.
    for (const path of [
      "node_modules/@juicesharp/rpiv-btw/prompts/btw-system.txt",
      "node_modules/@juicesharp/rpiv-ask-user-question/locales/en.json",
      "node_modules/@tintinweb/pi-subagents/src/default-agents.ts",
    ]) {
      expect(existsSync(resolve(repositoryRoot, path)), path).toBe(true);
    }
  });

  test("upstream Subagents parses every preset as blocking, unpersisted, and context-free", async () => {
    const { loadCustomAgents } = await vi.importActual<{
      loadCustomAgents(cwd: string): Map<string, Record<string, any>>;
    }>(resolve(repositoryRoot, "node_modules/@tintinweb/pi-subagents/src/custom-agents.ts"));
    const directory = mkdtempSync(resolve(tmpdir(), "pi-suite-agents-"));
    try {
      const agentsDirectory = resolve(directory, ".pi", "agents");
      mkdirSync(agentsDirectory, { recursive: true });
      const names = readdirSync(resolve(repositoryRoot, "presets/agents")).map((file) => file.replace(/\.md$/, ""));
      for (const name of names) {
        writeFileSync(
          resolve(agentsDirectory, `${name}.md`),
          readFileSync(resolve(repositoryRoot, `presets/agents/${name}.md`), "utf8"),
        );
      }

      const agents = loadCustomAgents(directory);
      for (const name of names) {
        expect(agents.get(name), name).toMatchObject({
          persistSession: false,
          outputTranscript: false,
          runInBackground: false,
          inheritContext: false,
        });
      }
      expect(agents.get("Oracle")?.allowedSubagents).toEqual(["Explore", "Librarian"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
