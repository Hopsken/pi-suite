import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	includePreviousFileOperations,
	loadCompactionModelSelection,
	loadSessionReadModelSelection,
	saveCompactionModelSelection,
	saveSessionReadModelSelection,
} from "../src/state.ts";

describe("Pi Suite model config", () => {
	test("stores compact model values without provider names and preserves other Suite config", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-suite-settings-"));
		const configPath = join(directory, "pi-suite.json");
		const selected = {
			modelId: "gpt-test",
			thinkingLevel: "high",
		} as const;
		const reader = {
			modelId: "reader-test",
			thinkingLevel: "low",
		} as const;
		writeFileSync(configPath, JSON.stringify({ anotherPreference: true }), "utf8");

		try {
			saveCompactionModelSelection(selected, configPath);
			saveSessionReadModelSelection(reader, configPath);

			expect(loadCompactionModelSelection(configPath)).toEqual(selected);
			expect(loadSessionReadModelSelection(configPath)).toEqual(reader);
			expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
				anotherPreference: true,
				compactionModel: "gpt-test:high",
				sessionReadModel: "reader-test:low",
			});

			saveCompactionModelSelection(undefined, configPath);
			expect(loadCompactionModelSelection(configPath)).toBeUndefined();
			expect(JSON.parse(readFileSync(configPath, "utf8")).compactionModel).toBeNull();
			expect(loadSessionReadModelSelection(configPath)).toEqual(reader);
			saveSessionReadModelSelection(undefined, configPath);
			expect(loadSessionReadModelSelection(configPath)).toBeUndefined();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("includePreviousFileOperations", () => {
	test("carries native file metadata forward without mutating fallback preparation", () => {
		const preparation = {
			fileOps: {
				read: new Set(["current-read.ts"]),
				written: new Set(["current-write.ts"]),
				edited: new Set(["current-edit.ts"]),
			},
		} as Parameters<typeof includePreviousFileOperations>[0];
		const entries = [
			{
				type: "compaction",
				details: {
					readFiles: ["previous-read.ts"],
					modifiedFiles: ["previous-edit.ts"],
				},
			},
		] as Parameters<typeof includePreviousFileOperations>[1];

		const result = includePreviousFileOperations(preparation, entries);

		expect([...result.fileOps.read]).toEqual(["current-read.ts", "previous-read.ts"]);
		expect([...result.fileOps.written]).toEqual(["current-write.ts"]);
		expect([...result.fileOps.edited]).toEqual(["current-edit.ts", "previous-edit.ts"]);
		expect([...preparation.fileOps.read]).toEqual(["current-read.ts"]);
		expect([...preparation.fileOps.written]).toEqual(["current-write.ts"]);
		expect([...preparation.fileOps.edited]).toEqual(["current-edit.ts"]);
	});

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
