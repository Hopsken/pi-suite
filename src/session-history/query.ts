import { isAbsolute, normalize } from "node:path";

export const normalizeText = (value: string): string =>
	value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

export const normalizeQueryPath = (value: string): string => {
	const normalized = normalize(value.normalize("NFKC"));
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

export type QueryFilterName =
	| "id"
	| "name"
	| "cwd"
	| "after"
	| "before"
	| "created_after"
	| "created_before"
	| "model"
	| "tool"
	| "file";
export interface QueryClause {
	kind: "term" | "phrase" | "filter";
	value: string;
	name?: QueryFilterName;
	date?: Date;
	path?: string;
}
export interface ParsedQuery {
	raw: string;
	clauses: QueryClause[];
	requiresContent: boolean;
}
const names = new Set<QueryFilterName>([
	"id",
	"name",
	"cwd",
	"after",
	"before",
	"created_after",
	"created_before",
	"model",
	"tool",
	"file",
]);
const dateNames = new Set(["after", "before", "created_after", "created_before"]);

function parseDate(value: string, now: Date): Date {
	const relative = /^(\d+)([dw])$/i.exec(value);
	const date = relative
		? new Date(now.getTime() - Number(relative[1]) * (relative[2]!.toLowerCase() === "w" ? 7 : 1) * 86_400_000)
		: new Date(value);
	if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
	return date;
}

export function parseSessionQuery(raw: string, now = new Date()): ParsedQuery {
	if (Buffer.byteLength(raw) > 4096) throw new Error("Query exceeds 4 KiB.");
	const tokens: { value: string; quoted: boolean; filterColon: number }[] = [];
	let value = "",
		quoted = false,
		inQuote = false,
		filterColon = -1;
	const push = () => {
		if (value || quoted) tokens.push({ value, quoted, filterColon });
		value = "";
		quoted = false;
		filterColon = -1;
	};
	for (let i = 0; i < raw.length; i++) {
		const char = raw[i]!;
		if (char === "\\" && inQuote) {
			const next = raw[++i];
			if (next !== '"' && next !== "\\") throw new Error("Only quote and backslash may be escaped.");
			value += next;
		} else if (char === '"') {
			inQuote = !inQuote;
			quoted = true;
		} else if (/\s/.test(char) && !inQuote) push();
		else {
			if (char === ":" && !inQuote && filterColon < 0) filterColon = value.length;
			value += char;
		}
	}
	if (inQuote) throw new Error("Malformed quoted query.");
	push();
	const clauses = tokens.map<QueryClause>((token) => {
		if (!token.value) throw new Error("Quoted query values must not be empty.");
		const colon = token.filterColon;
		if (colon < 0) return { kind: token.quoted ? "phrase" : "term", value: normalizeText(token.value) };
		const name = token.value.slice(0, colon) as QueryFilterName;
		const filterValue = token.value.slice(colon + 1);
		if (!names.has(name)) throw new Error(`Unsupported filter: ${name}`);
		if (!filterValue) throw new Error(`Missing value for ${name}.`);
		if (name === "cwd" && filterValue !== "." && !isAbsolute(filterValue))
			throw new Error("cwd must be absolute or '.'.");
		if (name === "model" && !filterValue.includes("/")) throw new Error("model must use provider/model-id syntax.");
		return {
			kind: "filter",
			name,
			value: normalizeText(filterValue),
			date: dateNames.has(name) ? parseDate(filterValue, now) : undefined,
			path: name === "cwd" || name === "file" ? normalizeQueryPath(filterValue) : undefined,
		};
	});
	return {
		raw,
		clauses,
		requiresContent: clauses.some(
			(c) => c.kind !== "filter" || c.name === "model" || c.name === "tool" || c.name === "file",
		),
	};
}
