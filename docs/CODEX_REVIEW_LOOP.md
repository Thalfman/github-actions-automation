# Codex Review Loop

This repository provides a reusable GitHub Actions workflow for a Codex-only pull
request review loop. Target repositories add one small caller workflow and keep
the review-loop logic centralized here.

The loop uses only GitHub Actions, the target repository `GITHUB_TOKEN`, GitHub
REST API calls, and the Codex GitHub integration installed in the target
repository.

## What It Does

- Posts `@codex review` when Codex has not reviewed the current PR head SHA.
- Treats every new commit as a fresh review cycle.
- Treats a Codex `+1` reaction on the parent PR as the approval signal.
- Requests a Codex fix when current-head Codex review findings exist.
- Waits for passing checks/statuses and a quiet window before notifying the
  ready reviewer.
- Adds status labels such as `ai/blocked` and `ai/ready-to-merge`.
- Adds warning labels for sensitive file categories when relevant.

This is Codex-only. Gemini is not used. Claude is not auto-triggered.

## What It Never Does

- It does not use API keys.
- It does not use OAuth tokens.
- It does not use personal access tokens.
- It does not use external webhooks.
- It does not call the GitHub merge API.
- It does not enable auto-merge.
- It does not delete branches.

Final review and merge remain manual.

## Target Repository Setup

Copy `templates/codex-review-loop-caller.yml` into the target repository at:

```text
.github/workflows/codex-review-loop.yml
```

The caller workflow invokes:

```yaml
uses: Thalfman/github-actions-automation/.github/workflows/codex-review-loop.yml@main
secrets: inherit
with:
  automation_ref: main
```

Keep `Thalfman/github-actions-automation` public so private target repositories
can call the reusable workflow without additional source-repository access
configuration.

If this automation repository is ever made private, configure GitHub Actions
access settings so the intended private target repositories can use reusable
workflows from this repository before enabling the caller workflow there.

The `automation_ref` input controls which ref is checked out for the central
script. Keep it aligned with the reusable workflow ref. For example, if the
caller uses `.../codex-review-loop.yml@v1`, set `automation_ref: v1`; if the
caller pins the reusable workflow to a commit SHA, set `automation_ref` to that
same SHA.

## Review Cycle

Each head SHA is independent. A new commit resets the cycle.

Older Codex reviews, comments, reactions, fix markers, ready markers, and blocked
markers are not valid for the latest head SHA. The workflow uses hidden markers
that include the PR number and head SHA to deduplicate comments while preserving
that per-commit reset behavior.

## Approval Signal

Codex approval is a `+1` reaction from the Codex actor on the parent PR, not an
inline review comment.

The `+1` reaction is accepted only when:

- the reaction is from Codex;
- the reaction was created after the current head commit timestamp;
- the current head SHA is still the latest commit;
- checks/statuses for the current head SHA are complete and successful;
- no current-head Codex review findings remain;
- the quiet window has passed.

Codex `eyes` reactions are treated only as seen or in-progress. Codex review
comments are treated as findings.

## REST-Only Limitation

This version intentionally uses the GitHub REST API only. GitHub REST PR review
comment payloads do not expose resolved review-thread state.

Because of that limitation, current-head Codex review comments are treated as
unresolved findings until a new head SHA resets the cycle.

## Ready Notification

When ready, the workflow posts one top-level PR comment:

```text
@Thalfman ✅ Codex approved the latest commit. This PR appears ready to merge manually.
```

The ready notification requires:

- latest head SHA;
- Codex `+1` reaction on the parent PR;
- passing checks/statuses;
- no current-head Codex review findings;
- quiet window passed.

The workflow mentions the ready reviewer only on ready comments. Blocked and
waiting comments do not mention the ready reviewer.

## Optional Variables

Set repository variables in a target repository to tune behavior:

- `CODEX_REVIEW_LOOP_ENABLED=false` disables the loop.
- `CODEX_FIX_ENABLED=false` disables fix requests.
- `CODEX_READY_NOTIFY_ENABLED=false` disables ready notifications.
- `CODEX_QUIET_WINDOW_MINUTES` overrides the quiet window.
- `CODEX_MAX_FIX_CYCLES` overrides total fix requests per PR.
- `CODEX_MAX_FIX_CYCLES_PER_SHA` overrides fix requests per head SHA.
- `CODEX_ACTOR_LOGIN` pins the Codex actor login exactly.
- `READY_NOTIFY_LOGIN` overrides who is mentioned in ready comments.

The reusable workflow also accepts `automation_ref` as a workflow input. This is
not a repository variable; set it in the caller workflow `with:` block when the
caller uses a tag or SHA instead of `main`.

If `CODEX_ACTOR_LOGIN` is unset, the loop matches logins containing `codex`
case-insensitively, including `chatgpt-codex-connector`. It explicitly avoids
matching Claude, Gemini, Vercel, Supabase, or GitHub Actions actors as Codex.

## Sensitive File Warnings

Sensitive files do not hard-block the loop. The workflow may add warning labels:

- `ai/security-sensitive`
- `ai/db-sensitive`
- `ai/workflow-sensitive`
- `ai/dependency-sensitive`

These labels are warnings only. They do not block review requests, fix requests,
or ready notification. The loop removes these managed warning labels when the
current PR diff no longer contains the matching sensitive file category.
