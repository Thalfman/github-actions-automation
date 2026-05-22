# github-actions-automation

Shared GitHub Actions automation for Codex-driven repository workflows.

## Codex Review Loop

This repo hosts a reusable Codex-only PR review loop. Target repositories add a
small caller workflow and delegate the review-loop logic here.

The workflow uses:

- GitHub Actions;
- the caller repository `GITHUB_TOKEN`;
- GitHub REST API calls;
- the Codex GitHub integration installed in the target repository.

It does not use API keys, OAuth tokens, personal access tokens, external
webhooks, auto-merge, or branch deletion.

## Target Repository Setup

Copy the template into a target repository:

```text
templates/codex-review-loop-caller.yml
```

Place it at:

```text
.github/workflows/codex-review-loop.yml
```

The caller workflow invokes:

```yaml
uses: Thalfman/github-actions-automation/.github/workflows/codex-review-loop.yml@main
secrets: inherit
```

Keep this automation repository public so private target repositories can call
the reusable workflow. If this repository is ever private, configure GitHub
Actions reusable workflow access before enabling target repositories.

## Documentation

See [docs/CODEX_REVIEW_LOOP.md](docs/CODEX_REVIEW_LOOP.md) for behavior,
configuration variables, safety guarantees, and the REST-only limitation.
