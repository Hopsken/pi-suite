import { isAbsolute } from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { type EvidenceUnit, normalizeActivePath } from "./normalize.ts";
import { normalizeQueryPath, normalizeText, type ParsedQuery, parseSessionQuery, type QueryClause } from "./query.ts";
import { type RepositoryMetadata, repositoryFromEntries, repositoryMatches } from "./repository.ts";
import {
	canonicalPath,
	discoverHistoricalSessions,
	loadHistoricalSession,
	MAX_TOTAL_OPENED_BYTES,
	RemainingSessionReadBudgetError,
} from "./store.ts";

export interface SearchMatch {
	entryId: string;
	timestamp: string;
	type: string;
	role?: string;
	snippet: string;
}
export interface HistoricalSessionResult {
	sessionId: string;
	name?: string;
	cwd: string;
	createdAt: string;
	modifiedAt: string;
	repo?: string;
	matchCount: number;
	matchedEntries: SearchMatch[];
}
export interface HistoricalSearchResult {
	sessions: HistoricalSessionResult[];
	count: number;
	hasMore: boolean;
}
export interface HistoricalSearchOptions {
	query: string;
	limit?: number;
	invokingCwd: string;
	currentSessionId?: string;
	currentSessionFile?: string;
	signal?: AbortSignal;
	now?: Date;
	invokingRepository?: RepositoryMetadata;
}

function metadataMatches(info: SessionInfo, query: ParsedQuery, invokingCwd: string): boolean {
	return query.clauses.every((clause) => {
		if (clause.kind !== "filter" || ["repo", "model", "tool", "file"].includes(clause.name!)) return true;
		switch (clause.name) {
			case "id":
				return normalizeText(info.id).startsWith(clause.value);
			case "name":
				return normalizeText(info.name ?? "").includes(clause.value);
			case "cwd":
				return (
					Boolean(info.cwd) &&
					normalizeQueryPath(info.cwd) === (clause.value === "." ? normalizeQueryPath(invokingCwd) : clause.path)
				);
			case "after":
				return info.modified > clause.date!;
			case "before":
				return info.modified < clause.date!;
			case "created_after":
				return info.created > clause.date!;
			case "created_before":
				return info.created < clause.date!;
			default:
				return true;
		}
	});
}
function unitMatches(unit: EvidenceUnit, clause: QueryClause): boolean {
	if (clause.kind !== "filter") return unit.normalizedText.includes(clause.value);
	if (clause.name === "tool") return unit.tools.some((tool) => normalizeText(tool) === clause.value);
	if (clause.name === "model")
		return unit.models.some((m) => normalizeText(`${m.provider}/${m.model}`) === clause.value);
	if (clause.name === "file") {
		const wanted = clause.path!;
		return unit.files.some((file) =>
			isAbsolute(wanted)
				? Boolean(file.absolute) && normalizeQueryPath(file.absolute!) === wanted
				: Boolean(file.relative) && normalizeQueryPath(file.relative!) === wanted,
		);
	}
	return true;
}
function snippet(unit: EvidenceUnit, clauses: QueryClause[]): string {
	const text = unit.text.replace(/\s+/g, " ").trim();
	if (!text) {
		let fallback = "";
		if (unit.tools.length) fallback = `Tools: ${unit.tools.join(", ")}`;
		if (unit.models.length)
			fallback = `Models: ${unit.models.map((model) => `${model.provider}/${model.model}`).join(", ")}`;
		if (unit.files.length)
			fallback = `Files: ${unit.files.map((file) => file.relative ?? file.absolute ?? "(unknown)").join(", ")}`;
		return `${fallback.slice(0, 480)}${fallback.length > 480 ? "…" : ""}`;
	}
	let at = 0;
	for (const clause of clauses)
		if (clause.kind !== "filter") {
			const found = normalizeText(text).indexOf(clause.value);
			if (found >= 0) {
				at = found;
				break;
			}
		}
	const start = Math.max(0, at - 200),
		value = text.slice(start, start + 480);
	return `${start ? "…" : ""}${value}${start + 480 < text.length ? "…" : ""}`;
}

export async function searchHistoricalSessions(options: HistoricalSearchOptions): Promise<HistoricalSearchResult> {
	const limit = options.limit ?? 10;
	if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("limit must be an integer from 1 to 50.");
	const query = parseSessionQuery(options.query, options.now);
	const discovered = await discoverHistoricalSessions(options);
	const repoClauses = query.clauses.filter((clause) => clause.kind === "filter" && clause.name === "repo");
	const contentClauses = query.clauses.filter(
		(c) => c.kind !== "filter" || ["model", "tool", "file"].includes(c.name!),
	);
	let hasMore = discovered.hasMore,
		opened = 0;
	const candidates = discovered.sessions.filter((info) => metadataMatches(info, query, options.invokingCwd));
	const results: (HistoricalSessionResult & { score: number; path: string; sameCwd: boolean })[] = [];
	for (const info of candidates) {
		options.signal?.throwIfAborted();
		let units: EvidenceUnit[] = [];
		let repository: RepositoryMetadata | undefined;
		if (query.requiresContent) {
			try {
				const remainingBytes = MAX_TOTAL_OPENED_BYTES - opened;
				if (remainingBytes <= 0) {
					hasMore = true;
					break;
				}
				const loaded = await loadHistoricalSession(info, options.signal, remainingBytes);
				opened += loaded.sizeBytes;
				repository = repositoryFromEntries(loaded.activePath);
				if (contentClauses.length) units = normalizeActivePath(loaded.activePath, info.cwd, options.signal).units;
			} catch (error) {
				if (options.signal?.aborted) throw options.signal.reason ?? error;
				if (error instanceof RemainingSessionReadBudgetError) hasMore = true;
				continue;
			}
		}
		if (repoClauses.some((clause) => !repositoryMatches(repository, clause.value, options.invokingRepository)))
			continue;
		if (contentClauses.some((clause) => !units.some((unit) => unitMatches(unit, clause)))) continue;
		const matched = units.filter((unit) => contentClauses.some((clause) => unitMatches(unit, clause)));
		results.push({
			sessionId: info.id,
			name: info.name,
			cwd: info.cwd || "(unknown)",
			createdAt: info.created.toISOString(),
			modifiedAt: info.modified.toISOString(),
			repo: repository?.remote,
			matchCount: matched.length,
			matchedEntries: matched.slice(0, 3).map((u) => ({
				entryId: u.entryId,
				timestamp: u.timestamp,
				type: u.type,
				role: u.role,
				snippet: snippet(u, contentClauses),
			})),
			score:
				contentClauses.reduce((n, c) => n + units.filter((u) => unitMatches(u, c)).length, 0) +
				(query.clauses.some((clause) => clause.name === "id" && normalizeText(info.id) === clause.value)
					? 10_000
					: 0),
			path: await canonicalPath(info.path),
			sameCwd: Boolean(info.cwd) && normalizeQueryPath(info.cwd) === normalizeQueryPath(options.invokingCwd),
		});
	}
	const hasCwd = query.clauses.some((c) => c.name === "cwd");
	results.sort((a, b) =>
		query.clauses.length
			? b.score - a.score ||
				(!hasCwd ? Number(b.sameCwd) - Number(a.sameCwd) : 0) ||
				b.modifiedAt.localeCompare(a.modifiedAt) ||
				a.path.localeCompare(b.path) ||
				a.sessionId.localeCompare(b.sessionId)
			: b.modifiedAt.localeCompare(a.modifiedAt) ||
				a.path.localeCompare(b.path) ||
				a.sessionId.localeCompare(b.sessionId),
	);
	hasMore ||= results.length > limit;
	const sessions = results
		.slice(0, limit)
		.map(({ score: _score, path: _path, sameCwd: _sameCwd, ...result }) => result);
	return {
		sessions,
		count: sessions.length,
		hasMore,
	};
}
