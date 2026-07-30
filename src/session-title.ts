import { clampThinkingLevel, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionTitleModelSelection } from "./state.ts";

const SYSTEM_PROMPT =
	"You are a session titling assistant. Generate a concise, descriptive title (max 60 chars) for the following conversation. Consider the overall conversation arc, key topics, and primary goals rather than focusing on the most recent messages. Output ONLY the title, no quotes, no explanation.";
const MAX_OUTPUT_TOKENS = 128;

function textParts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	return content.flatMap((part) => {
		if (!part || typeof part !== "object") return [];
		const record = part as Record<string, unknown>;
		return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
	});
}

export function sessionTitleTranscript(entries: SessionEntry[]): string {
	const sections: string[] = [];
	for (const rawEntry of entries) {
		const entry = rawEntry as unknown as Record<string, unknown>;
		if (entry.type === "message") {
			const message = entry.message as Record<string, unknown> | undefined;
			if (message?.role !== "user" && message?.role !== "assistant") continue;
			const text = textParts(message.content).join("\n").trim();
			if (text) sections.push(`${message.role === "user" ? "User" : "Assistant"}: ${text}`);
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			const summary = typeof entry.summary === "string" ? entry.summary.trim() : "";
			if (summary) sections.push(`Conversation summary: ${summary}`);
		}
	}
	return sections.join("\n\n");
}

function fitTranscript(transcript: string, contextWindow: number): string {
	const characterBudget = Math.max(2_000, (contextWindow - MAX_OUTPUT_TOKENS - 1_024) * 4);
	if (transcript.length <= characterBudget) return transcript;
	const side = Math.floor((characterBudget - 30) / 2);
	return `${transcript.slice(0, side)}\n\n[conversation omitted]\n\n${transcript.slice(-side)}`;
}

function titleText(content: { type: string; text?: string }[]): string {
	const output = content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join(" ")
		.trim()
		.replace(/^["'“‘]+|["'”’]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return output.slice(0, 60).trim();
}

/** Generate a title from the complete persisted active branch. */
export async function generateSessionTitle(
	ctx: ExtensionContext,
	selection: SessionTitleModelSelection | undefined,
	activeThinkingLevel: ModelThinkingLevel,
): Promise<string | undefined> {
	const transcript = sessionTitleTranscript(ctx.sessionManager.getBranch());
	if (!transcript.includes("User:") || !transcript.includes("Assistant:")) return undefined;

	const model = selection
		? ctx.modelRegistry.getAvailable().find((candidate) => candidate.id === selection.modelId)
		: ctx.model;
	if (!model)
		throw new Error(
			selection ? `Configured title model not found: ${selection.modelId}` : "No active model is available.",
		);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(`Could not authenticate title model ${model.provider}/${model.id}: ${auth.error}`);
	const thinking = clampThinkingLevel(model, selection?.thinkingLevel ?? activeThinkingLevel);
	const response = await completeSimple(
		model,
		{
			systemPrompt: SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: `Conversation:\n\n${fitTranscript(transcript, model.contextWindow)}\n\nSynthesize the full scope of this conversation into a concise title.`,
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			maxTokens: Math.min(MAX_OUTPUT_TOKENS, model.maxTokens),
			...(thinking === "off" ? {} : { reasoning: thinking }),
		},
	);
	if (response.stopReason === "error") throw new Error(response.errorMessage ?? "Title model failed.");
	if (response.stopReason === "aborted") return undefined;
	const title = titleText(response.content);
	return title || undefined;
}
