# Comment review rules

Review the scoped files or diff the parent provides. Remove unnecessary comments and identify code that needs a root-cause fix. Do not expand the scope.

Only these exceptions may stay:

- Legal or license headers.
- Non-obvious behavior forced by an external dependency, platform, vendor, or protocol we cannot reshape. For surprises in our own code, delete the comment and mark the exact symbol `MUST KILL` for rename, extract, type, or rearchitecture that makes the behavior obvious without prose.
- `// prettier-ignore`. Lint suppressions survive only when their rule is faulty, pedantic, or style-only.
- Doc comments that define a public API contract.
- Issue or RFC links that explain a constraint code cannot express.

When you are not sure an exception applies, delete the comment. Remove narration, banners, commented-out code, and workaround justifications without a proven exception.

For `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, and similar suppressions, look up the rule. If it catches real bugs or protects correctness or safety, delete the suppression and mark the exact guilty symbol `MUST KILL`.

`IMPORTANT`, `do not remove`, `too risky`, `fine for now`, and long justifications are signals to investigate, not proof. Read nearby code before judging. If the claim is not obvious there, use the **how** or **why** skill, or both, on the named symbol or call. Keep an external constraint only when it fits an exception and is proven true today on a live path. Delete comments about surprises in our own code and flag the symbol for reshaping. If doubt remains after investigation, delete the comment.

A long justification without a proven exception must be deleted, not shortened. Mark the exact guilty symbol `MUST KILL`. Do not change the application code.

Every flag must name code inside the scope and state an observed issue. Do not invent findings or flag intentional code protected by an exception. Edit comments only and identify refactor targets. Preserve unrelated edits. Do not commit, push, or modify external state.

Return a report naming touched files, the deletion count, `MUST KILL` flags with one line each, and skips. Include the evidence for each retained exception so the parent can check it.
