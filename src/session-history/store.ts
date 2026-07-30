import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { type SessionEntry, type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";

export const MAX_DISCOVERED_SESSIONS = 10_000;
export const MAX_SESSION_BYTES = 64 * 1024 * 1024;
export const MAX_TOTAL_OPENED_BYTES = 512 * 1024 * 1024;
export const MAX_ACTIVE_PATH_DEPTH = 100_000;

export interface DiscoveryResult {
	sessions: SessionInfo[];
	hasMore: boolean;
}

export interface LoadedHistoricalSession {
	info: SessionInfo;
	activePath: SessionEntry[];
	sizeBytes: number;
}

export class RemainingSessionReadBudgetError extends Error {}

const abort = (signal?: AbortSignal) => signal?.throwIfAborted();
export async function canonicalPath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return resolve(path);
	}
}

export async function discoverHistoricalSessions(
	options: { currentSessionId?: string; currentSessionFile?: string; signal?: AbortSignal } = {},
): Promise<DiscoveryResult> {
	abort(options.signal);
	const all = await SessionManager.listAll();
	abort(options.signal);
	const currentPath = options.currentSessionFile ? await canonicalPath(options.currentSessionFile) : undefined;
	const eligible: SessionInfo[] = [];
	for (const info of all) {
		abort(options.signal);
		if (info.id === options.currentSessionId) continue;
		if (currentPath && (await canonicalPath(info.path)) === currentPath) continue;
		eligible.push(info);
	}
	return {
		sessions: eligible.slice(0, MAX_DISCOVERED_SESSIONS),
		hasMore: eligible.length > MAX_DISCOVERED_SESSIONS,
	};
}

export async function loadHistoricalSession(
	info: SessionInfo,
	signal?: AbortSignal,
	maxBytes = MAX_SESSION_BYTES,
): Promise<LoadedHistoricalSession> {
	abort(signal);
	const sizeBytes = (await stat(info.path)).size;
	if (sizeBytes > MAX_SESSION_BYTES) throw new Error(`Session exceeds the 64 MiB per-file limit: ${info.id}`);
	if (sizeBytes > maxBytes)
		throw new RemainingSessionReadBudgetError(`Session ${info.id} exceeds the remaining total-read limit.`);
	const manager = SessionManager.open(info.path);
	abort(signal);
	const reversed: SessionEntry[] = [];
	const seen = new Set<string>();
	let id = manager.getLeafId();
	for (let depth = 0; id !== null; depth++) {
		abort(signal);
		if (depth >= MAX_ACTIVE_PATH_DEPTH)
			throw new Error(`Session active path exceeds ${MAX_ACTIVE_PATH_DEPTH.toLocaleString()} entries: ${info.id}`);
		if (seen.has(id)) throw new Error(`Cycle detected in session active path: ${info.id}`);
		seen.add(id);
		const entry = manager.getEntry(id);
		if (!entry) throw new Error(`Broken active-path parent reference in session ${info.id}: ${id}`);
		reversed.push(entry);
		id = entry.parentId;
	}
	return { info, activePath: reversed.reverse(), sizeBytes };
}
