import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  includePreviousFileOperations,
  loadCompactionModelSelection,
  loadSessionReadModelSelection,
  loadSessionTitleModelSelection,
  saveCompactionModelSelection,
} from "../src/state.ts";

describe("Pi Suite model config", () => {
  test("reads a pi-suite.json written by an earlier release, and a reset keeps every other setting", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-suite-settings-"));
    const configPath = join(directory, "pi-suite.json");
    // Already on users' disks; changing how these values load breaks existing installations.
    const saved = {
      anotherPreference: true,
      pushover: true,
      thinkAloud: false,
      compactionModel: "gpt-test:high",
      sessionReadModel: "reader-test:low",
      sessionTitleModel: "title-test:off",
    };
    writeFileSync(configPath, JSON.stringify(saved), "utf8");

    try {
      expect(loadCompactionModelSelection(configPath)).toEqual({ modelId: "gpt-test", thinkingLevel: "high" });
      expect(loadSessionReadModelSelection(configPath)).toEqual({ modelId: "reader-test", thinkingLevel: "low" });
      expect(loadSessionTitleModelSelection(configPath)).toEqual({ modelId: "title-test", thinkingLevel: "off" });

      saveCompactionModelSelection(undefined, configPath);
      expect(loadCompactionModelSelection(configPath)).toBeUndefined();
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ ...saved, compactionModel: null });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("includePreviousFileOperations", () => {
  test("does not cross a newer compaction without native file metadata", () => {
    const preparation = {
      fileOps: {
        read: new Set<string>(),
        written: new Set<string>(),
        edited: new Set<string>(),
      },
    } as Parameters<typeof includePreviousFileOperations>[0];
    const entries = [
      { type: "compaction", details: { readFiles: ["stale.ts"] } },
      { type: "compaction" },
    ] as Parameters<typeof includePreviousFileOperations>[1];

    const result = includePreviousFileOperations(preparation, entries);

    expect([...result.fileOps.read]).toEqual([]);
  });
});
