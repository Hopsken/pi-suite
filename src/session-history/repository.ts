import { normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { normalizeQueryPath, normalizeText } from "./query.ts";

export const REPOSITORY_ENTRY_TYPE = "pi-suite-repository";

export interface RepositoryMetadata {
	worktreeRoot: string;
	commonGitDir: string;
	remote?: string;
}

export function normalizeRepositoryRemote(value: string): string | undefined {
	const raw = value.trim();
	if (!raw) return undefined;
	if (/^[a-z][a-z0-9+.-]*::/i.test(raw)) return undefined;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.startsWith("file:")) {
		try {
			const url = new URL(raw);
			if (url.protocol === "file:") return normalizeQueryPath(fileURLToPath(url).replace(/\.git$/i, ""));
			if (!url.hostname) return undefined;
			const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
			return path ? `${url.host.toLowerCase()}/${path.toLowerCase()}` : url.host.toLowerCase();
		} catch {
			return undefined;
		}
	}
	if (/^[^/\s:]+(?:\.[^/\s:]+)+(?::\d+)?(?:\/[^\s]+)+$/.test(raw)) return raw.replace(/\.git$/i, "").toLowerCase();
	const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(raw);
	if (scp)
		return `${scp[1]!.toLowerCase()}/${scp[2]!
			.replace(/^\/+|\/+$/g, "")
			.replace(/\.git$/i, "")
			.toLowerCase()}`;
	if (raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("../") || raw.startsWith("~"))
		return normalizeQueryPath(raw.replace(/\.git$/i, ""));
	return undefined;
}

function repositoryMetadata(value: unknown): RepositoryMetadata | undefined {
	if (!value || typeof value !== "object") return undefined;
	const data = value as Record<string, unknown>;
	if (typeof data.worktreeRoot !== "string" || typeof data.commonGitDir !== "string") return undefined;
	return {
		worktreeRoot: normalizeQueryPath(data.worktreeRoot),
		commonGitDir: normalizeQueryPath(data.commonGitDir),
		remote: typeof data.remote === "string" ? normalizeRepositoryRemote(data.remote) : undefined,
	};
}

export function repositoryFromEntries(entries: SessionEntry[]): RepositoryMetadata | undefined {
	let repository: RepositoryMetadata | undefined;
	for (const entry of entries)
		if (entry.type === "custom" && entry.customType === REPOSITORY_ENTRY_TYPE)
			repository = repositoryMetadata(entry.data) ?? repository;
	return repository;
}

export async function detectRepository(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string,
	signal?: AbortSignal,
): Promise<RepositoryMetadata | undefined> {
	try {
		signal?.throwIfAborted();
		const location = await pi.exec(
			"git",
			["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
			{ cwd, timeout: 2_000, signal },
		);
		if (location.code !== 0) return undefined;
		const [worktreeRoot, commonGitDir] = location.stdout.trim().split(/\r?\n/);
		if (!worktreeRoot || !commonGitDir) return undefined;
		const remotes = await pi.exec("git", ["config", "--get-regexp", "^remote\\..*\\.url$"], {
			cwd,
			timeout: 2_000,
			signal,
		});
		const remoteLines = remotes.code === 0 ? remotes.stdout.trim().split(/\r?\n/) : [];
		const selected = remoteLines.find((line) => line.startsWith("remote.origin.url ")) ?? remoteLines[0];
		const remoteValue = selected?.slice(selected.indexOf(" ") + 1);
		return {
			worktreeRoot: normalizeQueryPath(worktreeRoot),
			commonGitDir: normalizeQueryPath(resolve(worktreeRoot, normalize(commonGitDir))),
			remote: remoteValue ? normalizeRepositoryRemote(remoteValue) : undefined,
		};
	} catch {
		signal?.throwIfAborted();
		return undefined;
	}
}

export function repositoryMatches(
	repository: RepositoryMetadata | undefined,
	value: string,
	current: RepositoryMetadata | undefined,
): boolean {
	if (!repository) return false;
	if (value === ".")
		return Boolean(
			current &&
				((repository.remote && current.remote && repository.remote === current.remote) ||
					repository.commonGitDir === current.commonGitDir),
		);
	const wanted = normalizeText(value.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, ""));
	const remote = repository.remote ? normalizeText(repository.remote) : undefined;
	if (!remote) return false;
	return wanted.split("/").length === 2 ? remote === wanted || remote.endsWith(`/${wanted}`) : remote === wanted;
}
