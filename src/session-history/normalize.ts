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
	warnings: string[];
	incomplete: boolean;
}
const SECRET =
	/^(authorization|auth|token|access[_-]?token|refresh[_-]?token|password|passwd|cookie|set[_-]?cookie|api[_-]?key|secret|client[_-]?secret|private[_-]?key|credentials?)$/i;
const bounded = (text: string, bytes: number) => Buffer.from(text).subarray(0, bytes).toString("utf8");
const MAX_VISIBLE_TEXT_BYTES = 64 * 1024;
const MAX_STRUCTURED_STRING_BYTES = 4096;
const MAX_STRUCTURED_DEPTH = 12;
const MAX_STRUCTURED_ITEMS = 100;

interface SanitizationState {
	truncated: boolean;
}

function sanitizeStructuredValue(
	value: unknown,
	state: SanitizationState,
	depth = 0,
	seen = new WeakSet<object>(),
): unknown {
	if (typeof value === "string") {
		if (Buffer.byteLength(value) > MAX_STRUCTURED_STRING_BYTES) state.truncated = true;
		return bounded(value, MAX_STRUCTURED_STRING_BYTES);
	}
	if (!value || typeof value !== "object") return value;
	if (depth >= MAX_STRUCTURED_DEPTH) {
		state.truncated = true;
		return "[TRUNCATED]";
	}
	if (seen.has(value)) return "[CIRCULAR]";
	seen.add(value);
	if (Array.isArray(value)) {
		if (value.length > MAX_STRUCTURED_ITEMS) state.truncated = true;
		return value.slice(0, MAX_STRUCTURED_ITEMS).map((item) => sanitizeStructuredValue(item, state, depth + 1, seen));
	}
	const entries = Object.entries(value);
	if (entries.length > MAX_STRUCTURED_ITEMS) state.truncated = true;
	return Object.fromEntries(
		entries
			.slice(0, MAX_STRUCTURED_ITEMS)
			.map(([key, item]) => [
				key,
				SECRET.test(key) ? "[REDACTED]" : sanitizeStructuredValue(item, state, depth + 1, seen),
			]),
	);
}

export function sanitizeStructured(value: unknown): unknown {
	return sanitizeStructuredValue(value, { truncated: false });
}
function fileEvidence(path: string, cwd: string): FileEvidence {
	if (!cwd && !isAbsolute(path)) return { relative: normalize(path) };
	const absolute = normalize(isAbsolute(path) ? path : resolve(cwd, path));
	if (!cwd) return { absolute };
	const rel = relative(cwd, absolute);
	return { absolute, relative: rel && !rel.startsWith("..") && !isAbsolute(rel) ? normalize(rel) : undefined };
}
function textParts(content: unknown, warnings: string[], maxBytes = MAX_VISIBLE_TEXT_BYTES): string[] {
	if (typeof content === "string") {
		if (Buffer.byteLength(content) > maxBytes) warnings.push("Visible message text was truncated to a safe bound.");
		return [bounded(content, maxBytes)];
	}
	if (!Array.isArray(content)) {
		warnings.push("Unknown message content type ignored.");
		return [];
	}
	const out: string[] = [];
	let usedBytes = 0;
	if (content.length > MAX_STRUCTURED_ITEMS)
		warnings.push("Visible message content items were truncated to a safe bound.");
	for (const part of content.slice(0, MAX_STRUCTURED_ITEMS)) {
		if (!part || typeof part !== "object") {
			warnings.push("Unknown message content item ignored.");
			continue;
		}
		const p = part as Record<string, unknown>;
		if (p.type === "text" && typeof p.text === "string") {
			const remainingBytes = maxBytes - usedBytes;
			if (remainingBytes <= 0) {
				warnings.push("Visible message text was truncated to a safe bound.");
				break;
			}
			if (Buffer.byteLength(p.text) > remainingBytes)
				warnings.push("Visible message text was truncated to a safe bound.");
			const next = bounded(p.text, remainingBytes);
			out.push(next);
			usedBytes += Buffer.byteLength(next);
		} else if (p.type !== "thinking" && p.type !== "image" && p.type !== "toolCall")
			warnings.push(`Unknown message content type ignored: ${String(p.type)}`);
	}
	return out;
}

export function normalizeActivePath(entries: SessionEntry[], cwd: string, signal?: AbortSignal): NormalizationResult {
	signal?.throwIfAborted();
	const warnings: string[] = [],
		units: EvidenceUnit[] = [];
	let incomplete = false;
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
			if (!message || typeof message !== "object") {
				warnings.push(`Unknown message at ${entry.id}.`);
				continue;
			}
			role = typeof message.role === "string" ? message.role : undefined;
			if (role === "user" || role === "assistant") text.push(...textParts(message.content, warnings));
			else if (role === "bashExecution") {
				tools.push("bash");
				text.push(bounded(String(message.command ?? ""), 4096), bounded(String(message.output ?? ""), 16 * 1024));
				if (Buffer.byteLength(String(message.command ?? "")) > 4096) {
					warnings.push("Bash command text was truncated to a safe bound.");
					incomplete = true;
				}
				if (Buffer.byteLength(String(message.output ?? "")) > 16 * 1024 || message.truncated) {
					warnings.push("Bash output was truncated to a safe bound.");
					incomplete = true;
				}
			} else if (role === "custom" && message.display !== false) text.push(...textParts(message.content, warnings));
			else if (role === "toolResult") {
				text.push(...textParts(message.content, warnings, 16 * 1024));
				if (message.isError) text.unshift("Tool error");
				if (typeof message.toolName === "string") tools.push(message.toolName);
			} else if (role !== "custom") warnings.push(`Unknown message role ignored: ${bounded(String(role), 256)}`);
			if (role === "assistant") {
				if (message.provider && message.model)
					models.push({ provider: String(message.provider), model: String(message.model) });
				for (const part of Array.isArray(message.content) ? message.content : [])
					if (part?.type === "toolCall") {
						const name = String(part.name ?? "");
						if (name) tools.push(name);
						const state = { truncated: false };
						const args = sanitizeStructuredValue(part.arguments ?? part.args ?? {}, state);
						const serializedArgs = JSON.stringify(args);
						if (Buffer.byteLength(serializedArgs) > 4096) state.truncated = true;
						if (state.truncated) {
							warnings.push("Tool arguments were truncated to a safe bound.");
							incomplete = true;
						}
						text.push(name, bounded(serializedArgs, 4096));
						if (["read", "write", "edit"].includes(name.toLowerCase())) {
							const path = (args as any)?.path ?? (args as any)?.file_path;
							if (typeof path === "string") files.push(fileEvidence(path, cwd));
						}
					}
			}
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			const summary = String(entry.summary ?? "");
			if (Buffer.byteLength(summary) > MAX_VISIBLE_TEXT_BYTES) {
				warnings.push("Summary text was truncated to a safe bound.");
				incomplete = true;
			}
			text.push(bounded(summary, MAX_VISIBLE_TEXT_BYTES));
			if (entry.type === "compaction" && entry.details && typeof entry.details === "object")
				for (const key of ["readFiles", "modifiedFiles"]) {
					const paths = entry.details[key];
					if (Array.isArray(paths)) {
						if (paths.length > MAX_STRUCTURED_ITEMS) {
							warnings.push("Compaction file evidence was truncated to a safe bound.");
							incomplete = true;
						}
						for (const path of paths.slice(0, MAX_STRUCTURED_ITEMS))
							if (typeof path === "string") {
								if (Buffer.byteLength(path) > MAX_STRUCTURED_STRING_BYTES) {
									warnings.push("Compaction file path was truncated to a safe bound.");
									incomplete = true;
								}
								files.push(fileEvidence(bounded(path, MAX_STRUCTURED_STRING_BYTES), cwd));
							}
					}
				}
		} else if (entry.type === "custom_message") {
			if (entry.display !== false) text.push(...textParts(entry.content, warnings));
		} else if (entry.type === "model_change")
			models.push({ provider: String(entry.provider), model: String(entry.modelId) });
		else if (!["thinking_level_change", "custom", "label", "session_info"].includes(entry.type))
			warnings.push(`Unknown entry type ignored: ${entry.type}`);
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
	if (warnings.some((warning) => warning.includes("truncated to a safe bound"))) incomplete = true;
	return { units, warnings: [...new Set(warnings)], incomplete };
}
