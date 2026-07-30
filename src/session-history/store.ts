import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { type SessionEntry, type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";

export const MAX_DISCOVERED_SESSIONS = 10_000;
export const MAX_SESSION_BYTES = 64 * 1024 * 1024;
export const MAX_TOTAL_OPENED_BYTES = 512 * 1024 * 1024;
export const MAX_ACTIVE_PATH_DEPTH = 100_000;

export interface DiscoveryResult {
	sessions: SessionInfo[];
	warnings: string[];
	incomplete: boolean;
}

export interface LoadedHistoricalSession {
	info: SessionInfo;
	activePath: SessionEntry[];
	sizeBytes: number;
	warnings: string[];
	incomplete: boolean;
}

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
	const incomplete = eligible.length > MAX_DISCOVERED_SESSIONS;
	return {
		sessions: eligible.slice(0, MAX_DISCOVERED_SESSIONS),
		warnings: incomplete ? [`Discovery capped at ${MAX_DISCOVERED_SESSIONS} sessions.`] : [],
		incomplete,
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
	if (sizeBytes > maxBytes) throw new Error(`Session ${info.id} exceeds the remaining total-read limit.`);
	const manager = SessionManager.open(info.path);
	abort(signal);
	const reversed: SessionEntry[] = [];
	const seen = new Set<string>();
	const warnings: string[] = [];
	let id = manager.getLeafId();
	let incomplete = false;
	for (let depth = 0; id !== null; depth++) {
		abort(signal);
		if (depth >= MAX_ACTIVE_PATH_DEPTH) {
			warnings.push(`Active path exceeded ${MAX_ACTIVE_PATH_DEPTH.toLocaleString()} entries.`);
			incomplete = true;
			break;
		}
		if (seen.has(id)) {
			warnings.push(`Cycle detected in active path at entry ${id}.`);
			incomplete = true;
			break;
		}
		seen.add(id);
		const entry = manager.getEntry(id);
		if (!entry) {
			warnings.push(`Broken active-path parent reference: ${id}.`);
			incomplete = true;
			break;
		}
		reversed.push(entry);
		id = entry.parentId;
	}
	return { info, activePath: reversed.reverse(), sizeBytes, warnings, incomplete };
}
