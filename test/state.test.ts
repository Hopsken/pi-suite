import { describe, expect, test } from "vitest";
import {
	COMPACTION_MODEL_ENTRY,
	includePreviousFileOperations,
	restoreCompactionModelSelection,
} from "../src/state.ts";

describe("restoreCompactionModelSelection", () => {
	test("restores the latest branch selection and respects a reset", () => {
		const selected = {
			provider: "openai",
			modelId: "gpt-test",
			thinkingLevel: "high",
		};
		const entries = [
			{ type: "custom", customType: COMPACTION_MODEL_ENTRY, data: { version: 1, selection: selected } },
		] as Parameters<typeof restoreCompactionModelSelection>[0];

		expect(restoreCompactionModelSelection(entries)).toEqual(selected);

		entries.push({
			type: "custom",
			customType: COMPACTION_MODEL_ENTRY,
			data: { version: 1, selection: null },
		} as (typeof entries)[number]);

		expect(restoreCompactionModelSelection(entries)).toBeUndefined();
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
