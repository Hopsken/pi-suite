import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import {
	includePreviousFileOperations,
	loadCompactionModelSelection,
	saveCompactionModelSelection,
} from "../src/state.ts";

describe("compaction model settings", () => {
	test("stores the selection without replacing unrelated or subsequently updated Pi settings", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-suite-settings-"));
		const settingsPath = join(directory, "settings.json");
		const selected = {
			provider: "openai",
			modelId: "gpt-test",
			thinkingLevel: "high",
		} as const;
		writeFileSync(settingsPath, JSON.stringify({ theme: "dark", piSuite: { anotherPreference: true } }), "utf8");

		try {
			saveCompactionModelSelection(selected, settingsPath);

			expect(loadCompactionModelSelection(settingsPath)).toEqual(selected);
			expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
				theme: "dark",
				piSuite: { anotherPreference: true, compactionModel: selected },
			});

			const settingsManager = SettingsManager.create(directory, directory);
			settingsManager.setTheme("light");
			await settingsManager.flush();
			expect(loadCompactionModelSelection(settingsPath)).toEqual(selected);
			expect(JSON.parse(readFileSync(settingsPath, "utf8")).theme).toBe("light");

			saveCompactionModelSelection(undefined, settingsPath);
			expect(loadCompactionModelSelection(settingsPath)).toBeUndefined();
			expect(JSON.parse(readFileSync(settingsPath, "utf8")).piSuite.compactionModel).toBeNull();
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
