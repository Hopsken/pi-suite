import { isAbsolute, normalize, relative, resolve } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { normalizeText } from "./query.ts";

export interface FileEvidence {
	absolute?: string;
	relative?: string;
}
export interface EvidenceUnit {
	entryId: string;
	timestamp: string;
	type: string;
	role?: string;
	text: string;
	normalizedText: string;
	tools: string[];
	models: { provider: string; model: string }[];
	files: FileEvidence[];
}
export interface NormalizationResult {
	units: EvidenceUnit[];
}
function fileEvidence(path: string, cwd: string): FileEvidence {
	if (!cwd && !isAbsolute(path)) return { relative: normalize(path) };
	const absolute = normalize(isAbsolute(path) ? path : resolve(cwd, path));
	if (!cwd) return { absolute };
	const rel = relative(cwd, absolute);
	return { absolute, relative: rel && !rel.startsWith("..") && !isAbsolute(rel) ? normalize(rel) : undefined };
}
function textParts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	return content.flatMap((part) =>
		part && typeof part === "object" && (part as Record<string, unknown>).type === "text"
			? [String((part as Record<string, unknown>).text ?? "")]
			: [],
	);
}

export function normalizeActivePath(entries: SessionEntry[], cwd: string, signal?: AbortSignal): NormalizationResult {
	signal?.throwIfAborted();
	const units: EvidenceUnit[] = [];
	for (const raw of entries) {
		signal?.throwIfAborted();
		const entry = raw as unknown as Record<string, any>;
		const text: string[] = [],
			tools: string[] = [],
			models: { provider: string; model: string }[] = [],
			files: FileEvidence[] = [];
		let role: string | undefined;
		if (entry.type === "message") {
			const message = entry.message;
			if (!message || typeof message !== "object") continue;
			role = typeof message.role === "string" ? message.role : undefined;
			if (role === "user" || role === "assistant") text.push(...textParts(message.content));
			else if (role === "bashExecution") {
				tools.push("bash");
				text.push(String(message.command ?? ""), String(message.output ?? ""));
			} else if (role === "custom" && message.display !== false) text.push(...textParts(message.content));
			else if (role === "toolResult") {
				text.push(...textParts(message.content));
				if (message.isError) text.unshift("Tool error");
				if (typeof message.toolName === "string") tools.push(message.toolName);
			}
			if (role === "assistant") {
				if (message.provider && message.model)
					models.push({ provider: String(message.provider), model: String(message.model) });
				for (const part of Array.isArray(message.content) ? message.content : [])
					if (part?.type === "toolCall") {
						const name = String(part.name ?? "");
						if (name) tools.push(name);
						const args = part.arguments ?? part.args ?? {};
						const serializedArgs = JSON.stringify(args);
						text.push(name, serializedArgs);
						if (["read", "write", "edit"].includes(name.toLowerCase())) {
							const path = (args as any)?.path ?? (args as any)?.file_path;
							if (typeof path === "string") files.push(fileEvidence(path, cwd));
						}
					}
			}
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			text.push(String(entry.summary ?? ""));
			if (entry.type === "compaction" && entry.details && typeof entry.details === "object")
				for (const key of ["readFiles", "modifiedFiles"]) {
					const paths = entry.details[key];
					if (Array.isArray(paths))
						for (const path of paths) if (typeof path === "string") files.push(fileEvidence(path, cwd));
				}
		} else if (entry.type === "custom_message") {
			if (entry.display !== false) text.push(...textParts(entry.content));
		} else if (entry.type === "model_change")
			models.push({ provider: String(entry.provider), model: String(entry.modelId) });
		const joined = text.filter(Boolean).join("\n");
		if (joined || tools.length || models.length || files.length)
			units.push({
				entryId: entry.id,
				timestamp: entry.timestamp,
				type: entry.type,
				role,
				text: joined,
				normalizedText: normalizeText(joined),
				tools: [...new Set(tools)],
				models,
				files: files.filter(
					(file, index) =>
						files.findIndex(
							(candidate) => candidate.absolute === file.absolute && candidate.relative === file.relative,
						) === index,
				),
			});
	}
	return { units };
}
