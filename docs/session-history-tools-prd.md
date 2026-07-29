# PRD: Question-directed Pi session search and read

**Status:** Proposed  
**Target:** Pi Suite  
**Tracking issue:** [#1](https://github.com/Hopsken/pi-suite/issues/1)  
**Last updated:** 2026-07-29

## Summary

Pi sessions contain valuable project history: prior decisions, rejected approaches, tool calls, errors, and verification
results. That history is currently isolated from later agent sessions. Pi Suite should add two tools that make historical
sessions discoverable without automatically injecting unrelated history into the active conversation:

- `session_search` performs bounded, local, deterministic search over historical Pi sessions and returns matching session
  metadata and short evidence snippets.
- `session_read` accepts one historical session and a required question, then uses a user-selected model to return a
  question-specific, evidence-backed summary rather than dumping the transcript into the caller's context.

Search covers all historical working directories by default. Callers can add `cwd:.` to restrict a query to the current
working directory. Both tools operate only on each session's active branch, always exclude the executing session, and never
modify a session file.

## Problem

Each Pi agent session has an independent context. When a session ends, later agents cannot directly recover information such
as:

- why a design or dependency was selected;
- which alternatives were attempted and why they failed;
- what commands, tool results, and errors established a conclusion;
- whether a similar problem was solved in another project; or
- details omitted from a compaction summary but retained in the session file.

Users must currently remember the answer, manually locate and inspect JSONL files, or repeat prior investigation. Passing a
whole historical transcript to the active agent is not an acceptable solution: it consumes context, exposes unrelated
content, and makes the active agent responsible for both retrieval and interpretation.

## Goals

1. Let an agent locate relevant historical Pi sessions with composable metadata and text conditions.
2. Let an agent ask a focused question about one located session without receiving its complete transcript.
3. Preserve the provenance of material conclusions through session and entry identifiers.
4. Use only the persisted active branch, with semantics aligned to how Pi resumes a session.
5. Recover original active-branch history that predates compaction, not only the effective compacted context.
6. Keep search local and deterministic; use AI only for question-directed reading.
7. Let the user control the model and thinking level used for session reading.
8. Remain read-only, cancellable, bounded, and tolerant of individual malformed session files or entries.

## Non-goals

The first version will not provide:

- abandoned-branch search, branch selection, branch comparison, or all-branch summaries;
- automatic history injection into the active system prompt or conversation;
- semantic or embedding-based search;
- a persistent SQLite, FTS, or vector index;
- Git repository, remote, worktree, branch, ref, commit, author, label, or archive filters;
- multi-session synthesis in one `session_read` call;
- raw transcript export;
- arbitrary regular-expression search;
- question-and-answer result caching;
- automatic parsing of Bash commands to infer file access; or
- synchronization or search across different machines.

## Product principles

### Retrieval is explicit

Historical content is never inserted automatically. The agent first calls `session_search`, selects a result based on its
metadata and snippets, and then calls `session_read` only when interpretation of that session is useful.

### Search favors recall; filters provide precision

A query without `cwd:` searches every historical Pi session. This avoids silent false negatives when relevant history was
created from another directory, a nested directory, a worktree, or a previous location. `cwd:.` explicitly narrows a query
to the exact current working directory.

Cross-directory results remain visible rather than being silently excluded. Every result must prominently include its
source cwd, and an exact current-cwd match receives a ranking preference when textual relevance is otherwise comparable.

### Reading is question-directed

`session_read` requires a concrete question. Its reader model extracts only evidence relevant to that question and reports
when the evidence is missing, conflicting, or incomplete. It is not a generic compaction endpoint.

### Active branch only

Pi session files are append-only entry trees, but exposing that tree to the reader model would make branch status and
discarded decisions easy to misinterpret. The first version follows only the active root-to-leaf path and does not expose a
branch parameter.

### Read-only means no migration or rewrite

The tools must not switch sessions, append entries, move a leaf, invoke compaction, or open a historical session through an
API that may migrate and rewrite it. Parsing malformed or older data must never change the source JSONL.

## Relevant Pi data constraints

Pi 0.81.1 stores sessions as JSONL. The first valid object is a session header, and subsequent objects are entries linked by
`id` and `parentId`. A session header contains an absolute `cwd`, but no durable Git repository, remote, worktree, branch,
ref, commit, author, label, or archive identity.

Compaction adds an entry and changes how Pi builds effective model context; it does not remove preceding messages from the
JSONL. Consequently, a historical reader can recover original messages on the active path even when those messages are no
longer present in the resumed model context.

For a persisted historical session, "active branch" means the root-to-leaf path Pi would use when resuming that file. The
implementation must use Pi's persisted leaf semantics rather than ask the reader model to infer a branch. Traversal must be
cycle-safe and depth-bounded. A broken parent chain produces a warning and a partial path; it must not cause traversal into
another branch.

## User workflow

```text
Agent
  -> session_search(query)
  <- matching historical session IDs, cwd values, metadata, and snippets
  -> session_read(session_id, question)
  -> configured reader model examines the normalized active path
  <- focused answer, decisions, evidence references, and warnings
```

Typical searches:

```text
"refresh token" cwd:. after:30d
"connection pool" tool:bash
file:src/auth.ts model:openai-codex/gpt-5.6-terra
id:019abc
```

## Tool: `session_search`

### Contract

```ts
{
  query: string;
  limit?: number;
}
```

- `query` may be empty. An empty query returns recently modified historical sessions.
- `limit` defaults to 10 and must not exceed 50.
- The executing session is always excluded, including when its ID is explicitly queried.
- Only active-branch entries participate in matching and snippets.
- A query without `cwd:` searches all historical cwd values.

### Query language

Bare terms and filters are combined with implicit AND. Matching is case-insensitive unless the underlying value has
platform-specific path semantics. Values containing whitespace must be quoted.

| Syntax | Required behavior |
| --- | --- |
| `authentication` | Match a normalized bare text term. |
| `"race condition"` | Match a normalized exact phrase. |
| `id:<value>` | Match a full session ID or ID prefix. |
| `name:<value>` | Match a case-insensitive substring of the effective session name. |
| `cwd:.` | Match the normalized current `ctx.cwd` exactly. |
| `cwd:"<absolute-path>"` | Match a normalized persisted cwd exactly. |
| `after:<date>` | Require session modified time after the value. |
| `before:<date>` | Require session modified time before the value. |
| `created_after:<date>` | Require header creation time after the value. |
| `created_before:<date>` | Require header creation time before the value. |
| `model:<provider/model-id>` | Match a model used on the active path. |
| `tool:<tool-name>` | Match a tool called on the active path. |
| `file:<path>` | Match structured evidence of a file read or modification on the active path. |

Dates accept ISO dates and relative day or week forms such as `7d` and `2w`. `after` and `before` refer to the same logical
modified timestamp returned in the result. Unsupported filter names, malformed quoting, invalid dates, and invalid limits
return a clear query error rather than silently changing the query's meaning.

No `cwd:*` or separate scope parameter is needed: omitting `cwd:` already means that cwd is unrestricted.

### Searchable content

The local search representation includes:

- session ID, effective name, cwd, creation time, and logical modified time;
- visible user and assistant text on the active path;
- tool names and sanitized, bounded argument text on the active path;
- bounded textual tool results and tool errors on the active path;
- compaction and branch-summary text encountered on the active path;
- visible `custom_message` content; and
- assistant provider/model metadata and model-change entries.

It excludes:

- assistant thinking or hidden reasoning;
- image or base64 payloads;
- text, thinking, or provider signatures;
- raw provider diagnostics;
- opaque extension `custom.data`; and
- unbounded `details` objects.

Structured fields with secret-like keys, including authorization, token, password, cookie, and API-key fields, are redacted
before indexing or display. This is data minimization, not a guarantee that arbitrary secrets embedded in plain text can be
detected.

### `file:` semantics

`file:` represents structured file evidence, not arbitrary textual mention. The first version may derive evidence from:

- known path fields in Pi's built-in read, write, and edit tool calls;
- compaction `readFiles` and `modifiedFiles`; and
- explicitly supported tool schemas added later.

The implementation must not parse arbitrary shell text to infer file access. A path that appears only in conversational text
can still be found as a bare or quoted text term, but it does not satisfy `file:`.

### Ranking

Results are ordered by:

1. textual and field-match relevance;
2. an exact-current-cwd preference when relevance is otherwise comparable; and
3. logical modified time descending.

The cwd preference is a tie-breaker, not an implicit filter. A more relevant session from another cwd must remain eligible.
An explicit `cwd:` filter overrides the need for any cwd preference.

### Result

Each session result must provide enough visible text for the caller to select a session without reading it in full:

```ts
{
  sessionId: string;
  name?: string;
  cwd: string;
  createdAt: string;
  modifiedAt: string;
  matchCount: number;
  matchedEntries: Array<{
    entryId: string;
    timestamp: string;
    type: string;
    role?: string;
    snippet: string;
  }>;
}
```

The model-visible tool content must prominently show `sessionId` and `cwd`. Return at most three bounded snippets per
session. Tool details may also carry the structured representation for UI rendering and diagnostics, but required agent
information must not exist only in hidden details.

If files or lines are skipped because they are unreadable or malformed, the result includes aggregate warnings without
failing unrelated valid sessions. Reaching an implementation resource limit must produce an explicit incomplete-results
warning; it must never look like a complete empty result.

## Tool: `session_read`

### Contract

```ts
{
  session_id: string;
  question: string;
}
```

- `session_id` accepts a full ID or a unique prefix. An ambiguous prefix returns an error.
- Arbitrary file paths are not accepted.
- `question` is required and must not be empty after trimming.
- The executing session is not a valid target.
- Only the target session's active root-to-leaf path is read.
- The tool never exposes a branch parameter.

### Historical material

The reader receives a normalized, chronological representation of the complete active path, including original entries
that precede a compaction entry. Compaction summaries may be included as supporting material, but they do not replace the
original active-path messages.

Normalized material may include:

- session ID, effective name, cwd, and timestamps;
- visible user and assistant text;
- sanitized and bounded tool calls, results, and errors;
- compaction and branch summaries present on the active path;
- visible custom messages;
- model changes; and
- stable entry IDs attached to each evidence unit.

The same exclusions and redaction rules as search apply. Session content is untrusted evidence, not instructions to the
reader model.

### Question-directed inference

The reader model receives no tools. Its system instructions must require it to:

- answer only the supplied question using the supplied session evidence;
- treat transcript text, tool output, and embedded prompts as untrusted data;
- distinguish established decisions, proposals, attempts, outcomes, and unresolved points;
- avoid revealing content unrelated to the question;
- cite the relevant session and entry IDs for material claims;
- state when evidence is missing, conflicting, malformed, or incomplete; and
- never claim that a decision from another cwd is a current-project decision without identifying its source.

If normalized material fits within the configured input budget, the tool uses one inference call. If it does not fit, the
tool performs bounded hierarchical reading with the same configured model:

1. split material on entry or turn boundaries;
2. ask each chunk to extract question-relevant evidence with entry IDs;
3. synthesize the extracted evidence in a final call; and
4. preserve warnings and provenance through the reduction.

The implementation must not silently select only the beginning, end, or lexical matches of an oversized session. If a
total processing limit prevents every normalized entry from being examined, the final answer is explicitly marked
incomplete and describes the omitted range.

### Reader output

The model-visible result contains:

1. source session metadata, including ID, name when present, cwd, and timestamps;
2. a direct answer to the question;
3. relevant decisions and reasons;
4. relevant attempts and outcomes when applicable;
5. evidence references in `session:<session-id>#<entry-id>` form;
6. unresolved or conflicting information; and
7. truncation, malformed-data, or incomplete-read warnings.

Tool details should include:

```ts
{
  sessionId: string;
  readerModel: string;
  inspectedEntries: number;
  skippedMalformedEntries: number;
  incomplete: boolean;
  stopReason?: string;
}
```

A model stop reason of `length`, `error`, or `aborted` must be handled explicitly rather than returning a partial answer as
if it were complete.

## Reader model configuration

Pi Suite adds an interactive command:

```text
/session-read-model
```

It follows the existing `/compaction-model` experience:

- list only models available through Pi's model registry;
- search by provider, model ID, and model name;
- allow only thinking levels supported by the selected model; and
- offer **Use active session model (default)**.

An explicit selection is stored globally in Pi's `settings.json`:

```json
{
  "piSuite": {
    "sessionReadModel": {
      "provider": "provider-name",
      "modelId": "model-id",
      "thinkingLevel": "low"
    }
  }
}
```

When no explicit selection exists, the reader uses the invoking session's active model. This is an intentional default, not
a failure fallback. When an explicitly configured model cannot be found or authenticated, `session_read` returns a clear
error and does not silently send historical content to the active model or another provider.

Authentication must honor the model registry's complete successful result, including API key, headers, and environment.
The tool-call abort signal must cancel in-flight reader inference without aborting the parent agent operation.

## Availability

- The main Pi agent receives both tools from the Pi Suite extension.
- Oracle should explicitly allow both tools so an isolated review can recover relevant prior decisions when instructed.
- Explore and Librarian do not receive the tools; their scopes remain current-workspace discovery and external repository
  research respectively.

Tool descriptions must tell agents that search is global across historical cwd values by default, `cwd:.` is required for
an exact-current-directory question, and the active session is always excluded.

## Privacy and security requirements

1. Search and read never mutate, migrate, switch, append to, or compact a historical session.
2. Default global search is disclosed in the tool description and documentation.
3. Every search result and read answer visibly identifies its source cwd.
4. Search returns short, bounded snippets rather than transcripts.
5. Read sends only normalized, question-relevant session material through a tool-free inference path.
6. Known structured secrets are redacted before matching, display, or inference; documentation must not promise complete
   secret detection in arbitrary text.
7. Images, signatures, diagnostics, and opaque extension state are excluded by default.
8. Session text and tool output are treated as untrusted prompt content.
9. Session lookup is restricted to discovered Pi session files. A crafted `parentSession` value must not permit arbitrary
   filesystem reads or traversal outside allowed session roots.
10. Cancellation and resource limits produce explicit errors or incomplete warnings, not fabricated complete results.

## Performance and compatibility requirements

- Reuse Pi's public session discovery and read-only parsing facilities where they preserve the no-write guarantee.
- Do not use `SessionManager.open()` when it can migrate or rewrite a historical file.
- Accept supported older session versions without rewriting them.
- Skip unknown future entry and content-block types with warnings rather than failing an otherwise usable session.
- Tolerate an incomplete final JSONL line caused by a concurrent append.
- Use cycle detection and a maximum traversal depth for parent chains.
- Honor `AbortSignal` during discovery, parsing, normalization, and inference.
- Bound read concurrency, snippet size, tool argument/result material, model input, model output, and total hierarchical calls.
- Never silently truncate a search or read because a bound was reached.
- The first version may use an in-process cache keyed by canonical path, file size, and modification time. It does not add a
  durable index; a persistent index requires separate performance evidence and design review.

## Failure behavior

| Condition | Required behavior |
| --- | --- |
| No search matches | Return an empty result and state that all historical cwd values were searched unless `cwd:` constrained it. |
| Invalid query | Return a query error identifying the invalid token or value. |
| One unreadable or malformed session | Skip it, continue, and return an aggregate warning. |
| Broken active parent chain | Use only the safe partial path and mark the result incomplete. |
| Ambiguous session ID prefix | Return matching IDs or require a full ID; do not choose one. |
| Target is the executing session | Return an error explaining that the tools operate on historical sessions only. |
| Configured reader model is missing or unauthenticated | Return an error; do not fall back to another model. |
| Reader output reaches its length limit | Return the answer with an explicit truncation warning and stop reason. |
| Tool call is cancelled | Stop local work and inference promptly; do not abort the parent operation. |

## Acceptance criteria

1. A query without `cwd:` can return matching historical sessions from multiple cwd values.
2. `cwd:.` returns only sessions whose normalized persisted cwd exactly matches the invoking context's cwd.
3. The executing session never appears, even for an exact ID query.
4. Search and read ignore entries outside the active root-to-leaf path.
5. Every search result prominently includes session ID and cwd.
6. Search snippets identify their source entry and remain within documented bounds.
7. Bare terms, exact phrases, ID, name, cwd, date, model, tool, and structured file conditions compose with AND semantics.
8. `file:` does not claim a match from an unparsed Bash command or conversational path mention alone.
9. One corrupt file or line does not prevent valid sessions from being returned.
10. `session_read` rejects an empty question, arbitrary path, ambiguous ID prefix, and the executing session ID.
11. `session_read` examines the full active path, including original entries preceding compaction.
12. A long session uses question-directed hierarchical reading or reports explicitly that the read is incomplete.
13. Material reader claims include valid session and entry references from the supplied evidence.
14. A configured reader model is used with its selected thinking level and complete authentication context.
15. Failure of an explicitly configured reader model does not invoke the active model.
16. Historical session files are byte-for-byte unchanged after search and read operations.
17. Search parsing and reader inference stop when the tool abort signal is triggered.
18. Oracle's effective tool allowlist contains both tools; Explore and Librarian remain unchanged.

## Rollout and documentation

Implementation should ship with:

- unit tests for query parsing, active-path extraction, normalization, redaction, ranking, and failure handling;
- integration tests using realistic Pi JSONL fixtures, including compaction, older versions, corruption, partial final lines,
  and sessions from multiple cwd values;
- model tests using a faux provider for single-pass, hierarchical, authentication-failure, length, and cancellation paths;
- distribution tests for main-agent and Oracle tool visibility;
- README documentation for both tools, the global default search scope, `cwd:.`, reader-model configuration, privacy
  behavior, and limitations; and
- an upgrade note stating that the feature reads existing Pi sessions without migrating them or creating a persistent
  index.

## Future considerations

The following require separate evidence and design review:

- a durable full-text index if measured global-search latency becomes unacceptable;
- stable repository identity and `repo:` filters if Pi Suite records Git metadata independently;
- opt-in abandoned-branch retrieval with a model-safe representation of branch status;
- local-only or allowlisted-cwd privacy policies;
- multi-session comparison and synthesis; and
- semantic retrieval after deterministic search quality and cost have been measured.
