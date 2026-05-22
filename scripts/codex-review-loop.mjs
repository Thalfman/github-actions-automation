#!/usr/bin/env node

const API_ROOT = "https://api.github.com";
const MARKER_PREFIX = "codex-review-loop";
const STATUS_LABEL_BLOCKED = "ai/blocked";
const STATUS_LABEL_READY = "ai/ready-to-merge";
const SUCCESSFUL_CHECK_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const DEFAULT_CODEX_ACTOR_LOGINS = new Set([
  "chatgpt-codex-connector",
  "chatgpt-codex-connector[bot]",
]);

const WARNING_LABELS = {
  security: {
    label: "ai/security-sensitive",
    color: "b60205",
    description: "PR changes security-sensitive files.",
  },
  db: {
    label: "ai/db-sensitive",
    color: "5319e7",
    description: "PR changes database-sensitive files.",
  },
  workflow: {
    label: "ai/workflow-sensitive",
    color: "fbca04",
    description: "PR changes workflow-sensitive files.",
  },
  dependency: {
    label: "ai/dependency-sensitive",
    color: "0e8a16",
    description: "PR changes dependency-sensitive files.",
  },
};

const config = readConfig();

if (!config.enabled) {
  log("CODEX_REVIEW_LOOP_ENABLED is false; exiting.");
  process.exit(0);
}

await main();

async function main() {
  const prs = await getPullRequestsToProcess();

  if (prs.length === 0) {
    log("No pull requests to process.");
    return;
  }

  for (const pr of prs) {
    try {
      await processPullRequest(pr);
    } catch (error) {
      console.error(`Failed processing PR #${pr.number}: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

function readConfig() {
  const repository = requireEnv("GITHUB_REPOSITORY");
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error(`GITHUB_REPOSITORY must be owner/repo, got ${repository}`);
  }

  return {
    token: requireEnv("GITHUB_TOKEN"),
    owner,
    repo,
    repository,
    runId: env("GITHUB_RUN_ID", ""),
    eventName: env("GITHUB_EVENT_NAME", ""),
    prNumber: parseOptionalInteger(env("CODEX_LOOP_PR_NUMBER", "")),
    headSha: env("CODEX_LOOP_HEAD_SHA", "").trim(),
    dryRun: readBoolean("CODEX_LOOP_DRY_RUN", false),
    codexActorLogin: env("CODEX_ACTOR_LOGIN", "").trim(),
    readyNotifyLogin: env("READY_NOTIFY_LOGIN", "Thalfman").trim() || "Thalfman",
    enabled: readBoolean("CODEX_REVIEW_LOOP_ENABLED", true),
    fixEnabled: readBoolean("CODEX_FIX_ENABLED", true),
    readyNotifyEnabled: readBoolean("CODEX_READY_NOTIFY_ENABLED", true),
    quietWindowMinutes: parsePositiveInteger(
      env("CODEX_QUIET_WINDOW_MINUTES", "5"),
      5,
    ),
    maxFixCycles: parsePositiveInteger(env("CODEX_MAX_FIX_CYCLES", "3"), 3),
    maxFixCyclesPerSha: parsePositiveInteger(
      env("CODEX_MAX_FIX_CYCLES_PER_SHA", "1"),
      1,
    ),
  };
}

async function processPullRequest(pr) {
  if (!pr.head?.repo || !pr.base?.repo) {
    log(`Skipping PR #${pr.number}; missing head or base repository metadata.`);
    return;
  }

  if (pr.head.repo.fork) {
    log(`Skipping PR #${pr.number}; forked PRs are not supported.`);
    return;
  }

  if (pr.head.repo.full_name !== pr.base.repo.full_name) {
    log(
      `Skipping PR #${pr.number}; head repo ${pr.head.repo.full_name} differs from base repo ${pr.base.repo.full_name}.`,
    );
    return;
  }

  const headSha = pr.head.sha;
  const issueNumber = pr.number;
  log(`Processing PR #${issueNumber} at ${headSha}.`);

  const [
    commit,
    issueComments,
    reviewComments,
    reviews,
    reactions,
    changedFiles,
    checkState,
  ] = await Promise.all([
    getCommit(headSha),
    listIssueComments(issueNumber),
    listPullReviewComments(issueNumber),
    listPullReviews(issueNumber),
    listIssueReactions(issueNumber),
    listChangedFiles(issueNumber),
    getCheckState(headSha),
  ]);

  const headCommittedAt = getCommitTimestamp(commit);
  const warnings = detectWarnings(changedFiles);
  await applyWarningLabels(issueNumber, warnings);

  const markers = collectMarkers(issueComments, issueNumber, headSha);
  const codexReviewsForHead = reviews.filter(
    (review) => isCodexUser(review.user) && review.commit_id === headSha,
  );
  const currentHeadFindings = reviewComments.filter(
    (comment) =>
      isCodexUser(comment.user) &&
      (comment.commit_id === headSha || comment.original_commit_id === headSha),
  );
  const latestCodexActivityAt = getLatestCodexActivityAt({
    headSha,
    headCommittedAt,
    reviews,
    reviewComments,
    issueComments,
    reactions,
  });
  const approvalReaction = getApprovalReaction({
    reactions,
    headCommittedAt,
  });
  const quietWindow = getQuietWindowState(latestCodexActivityAt);

  if (currentHeadFindings.length > 0) {
    await handleFindings({
      issueNumber,
      headSha,
      isDraft: pr.draft,
      markers,
      findings: currentHeadFindings,
      warnings,
    });
    return;
  }

  if (codexReviewsForHead.length === 0) {
    if (!markers.reviewRequestForHead) {
      await createIssueComment(issueNumber, renderReviewRequest(issueNumber, headSha));
    }

    await setBlockedStatus({
      issueNumber,
      headSha,
      reason: "Waiting for Codex to review the current head SHA.",
      warnings,
    });
    return;
  }

  const readiness = getReadiness({
    checkState,
    approvalReaction,
    quietWindow,
  });

  if (readiness.ready) {
    if (pr.draft) {
      await setBlockedStatus({
        issueNumber,
        headSha,
        reason:
          "Draft PR: ready notifications and ready-to-merge labeling are skipped until the PR is ready for review.",
        warnings,
      });
      return;
    }

    await handleReady({
      issueNumber,
      headSha,
      approvalReaction,
      checkState,
      warnings,
      markers,
    });
    return;
  }

  await setBlockedStatus({
    issueNumber,
    headSha,
    reason: readiness.reason,
    warnings,
  });
}

async function handleFindings({
  issueNumber,
  headSha,
  isDraft,
  markers,
  findings,
  warnings,
}) {
  const findingReason = `${findings.length} unresolved current-head Codex review finding(s) remain.`;

  if (isDraft) {
    await setBlockedStatus({
      issueNumber,
      headSha,
      reason: `Draft PR: ${findingReason} Fix requests and ready notifications are skipped for draft PRs.`,
      warnings,
    });
    return;
  }

  if (!config.fixEnabled) {
    await setBlockedStatus({
      issueNumber,
      headSha,
      reason: `Codex fix requests are disabled and ${findingReason}`,
      warnings,
    });
    return;
  }

  const totalFixCycles = markers.allFixRequests.length;
  const fixCyclesForHead = markers.fixRequestsForHead.length;
  const maxCyclesReached =
    totalFixCycles >= config.maxFixCycles ||
    fixCyclesForHead >= config.maxFixCyclesPerSha;

  if (maxCyclesReached) {
    if (!markers.maxCyclesForHead) {
      await createIssueComment(issueNumber, renderMaxCycles(issueNumber, headSha));
    }

    await setBlockedStatus({
      issueNumber,
      headSha,
      reason: `Max fix cycles reached; ${findingReason}`,
      warnings,
    });
    return;
  }

  if (!markers.fixRequestForHead) {
    await createIssueComment(
      issueNumber,
      renderFixRequest(issueNumber, headSha, warnings),
    );
  }

  await setBlockedStatus({
    issueNumber,
    headSha,
    reason: `${findingReason} A Codex fix request has been posted for this head SHA.`,
    warnings,
  });
}

async function handleReady({
  issueNumber,
  headSha,
  approvalReaction,
  checkState,
  warnings,
  markers,
}) {
  if (config.readyNotifyEnabled && !markers.readyForHead) {
    await createIssueComment(
      issueNumber,
      renderReady(issueNumber, headSha, approvalReaction, checkState, warnings),
    );
  } else if (!config.readyNotifyEnabled) {
    log(`PR #${issueNumber} is ready, but CODEX_READY_NOTIFY_ENABLED is false.`);
  }

  await addLabels(issueNumber, [STATUS_LABEL_READY]);
  await removeLabel(issueNumber, STATUS_LABEL_BLOCKED);
}

function getReadiness({ checkState, approvalReaction, quietWindow }) {
  if (!approvalReaction) {
    return {
      ready: false,
      reason:
        "Waiting for a Codex +1 reaction on the parent PR after the current head commit.",
    };
  }

  if (!checkState.ready) {
    return {
      ready: false,
      reason: checkState.reason,
    };
  }

  if (!quietWindow.ready) {
    return {
      ready: false,
      reason: quietWindow.reason,
    };
  }

  return { ready: true, reason: "" };
}

async function setBlockedStatus({ issueNumber, headSha, reason, warnings }) {
  const comments = await listIssueComments(issueNumber);
  const trustedComments = comments.filter(isTrustedLoopComment);
  const marker = markerFor("blocked", issueNumber, headSha);
  const body = renderBlocked(issueNumber, headSha, reason, warnings);
  const existing = trustedComments.find((comment) =>
    comment.body?.includes(marker),
  );

  if (existing) {
    if (existing.body !== body) {
      await updateIssueComment(existing.id, body);
    }
  } else {
    await createIssueComment(issueNumber, body);
  }

  await addLabels(issueNumber, [STATUS_LABEL_BLOCKED]);
  await removeLabel(issueNumber, STATUS_LABEL_READY);
}

function renderReviewRequest(issueNumber, headSha) {
  return `@codex review

${markerFor("review-request", issueNumber, headSha)}`;
}

function renderFixRequest(issueNumber, headSha, warnings) {
  return `@codex fix the unresolved Codex review findings for the current head SHA.

Scope:
- Address only unresolved Codex review findings that apply to the current head SHA.
- Do not broaden scope.
- Do not refactor unrelated code.
- Preserve existing architecture and security rules.
- Run lint, typecheck, tests, and build if available.
- Push the smallest safe fix commit to this PR branch.

Current head SHA: ${headSha}
${renderWarnings(warnings)}
${markerFor("fix-request", issueNumber, headSha)}`;
}

function renderMaxCycles(issueNumber, headSha) {
  return `Codex review loop stopped for PR #${issueNumber}; max fix cycles reached.

${markerFor("max-cycles", issueNumber, headSha)}`;
}

function renderReady(issueNumber, headSha, approvalReaction, checkState, warnings) {
  const approvalTime = approvalReaction?.created_at
    ? ` at ${approvalReaction.created_at}`
    : "";

  return `@${config.readyNotifyLogin} ✅ Codex approved the latest commit. This PR appears ready to merge manually.

PR: #${issueNumber}
Head SHA: ${headSha}
Codex: approved via +1 reaction on the parent PR${approvalTime}
Checks: ${checkState.summary}
Open Codex threads: none
Quiet window: passed

Next step: manually review and click Merge.
${renderWarnings(warnings)}
${markerFor("ready", issueNumber, headSha)}`;
}

function renderBlocked(issueNumber, headSha, reason, warnings) {
  const warningLines = warnings.map((warning) => `- Warning: ${warning}`);
  const lines = [`- ${reason}`, ...warningLines];

  return `Codex review loop status for PR #${issueNumber} at ${headSha}:
${lines.join("\n")}

${markerFor("blocked", issueNumber, headSha)}`;
}

function renderWarnings(warnings) {
  if (warnings.length === 0) {
    return "\n";
  }

  return `
Warnings:
${warnings.map((warning) => `- ${warning}`).join("\n")}

`;
}

function markerFor(kind, issueNumber, headSha) {
  return `<!-- ${MARKER_PREFIX}:${kind}:${issueNumber}:${headSha} -->`;
}

function collectMarkers(issueComments, issueNumber, headSha) {
  const marker = (kind, sha = headSha) => markerFor(kind, issueNumber, sha);
  const allFixRequestPattern = `<!-- ${MARKER_PREFIX}:fix-request:${issueNumber}:`;
  const trustedIssueComments = issueComments.filter(isTrustedLoopComment);

  const allFixRequests = trustedIssueComments.filter((comment) =>
    comment.body?.includes(allFixRequestPattern),
  );
  const fixRequestsForHead = allFixRequests.filter((comment) =>
    comment.body?.includes(marker("fix-request")),
  );

  return {
    reviewRequestForHead: trustedIssueComments.find((comment) =>
      comment.body?.includes(marker("review-request")),
    ),
    fixRequestForHead: fixRequestsForHead[0],
    fixRequestsForHead,
    allFixRequests,
    maxCyclesForHead: trustedIssueComments.find((comment) =>
      comment.body?.includes(marker("max-cycles")),
    ),
    readyForHead: trustedIssueComments.find((comment) =>
      comment.body?.includes(marker("ready")),
    ),
  };
}

function getLatestCodexActivityAt({
  headSha,
  headCommittedAt,
  reviews,
  reviewComments,
  issueComments,
  reactions,
}) {
  const headTime = headCommittedAt.getTime();
  const times = [
    ...reviews
      .filter(
        (review) => isCodexUser(review.user) && review.commit_id === headSha,
      )
      .map((review) => review.submitted_at),
    ...reviewComments
      .filter(
        (comment) =>
          isCodexUser(comment.user) &&
          (comment.commit_id === headSha || comment.original_commit_id === headSha),
      )
      .map((comment) => comment.updated_at || comment.created_at),
    ...issueComments
      .filter(
        (comment) =>
          isCodexUser(comment.user) &&
          new Date(comment.updated_at || comment.created_at).getTime() > headTime,
      )
      .map((comment) => comment.updated_at || comment.created_at),
    ...reactions
      .filter(
        (reaction) =>
          isCodexUser(reaction.user) &&
          reaction.content === "+1" &&
          new Date(reaction.created_at).getTime() > headTime,
      )
      .map((reaction) => reaction.created_at),
  ]
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value));

  if (times.length === 0) {
    return null;
  }

  return new Date(Math.max(...times));
}

function getApprovalReaction({ reactions, headCommittedAt }) {
  const headTime = headCommittedAt.getTime();

  return reactions
    .filter(
      (reaction) =>
        reaction.content === "+1" &&
        isCodexUser(reaction.user) &&
        new Date(reaction.created_at).getTime() > headTime,
    )
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
}

function getQuietWindowState(latestCodexActivityAt) {
  if (!latestCodexActivityAt) {
    return {
      ready: false,
      reason: "Waiting for Codex activity before starting the quiet window.",
    };
  }

  const elapsedMs = Date.now() - latestCodexActivityAt.getTime();
  const requiredMs = config.quietWindowMinutes * 60 * 1000;
  if (elapsedMs >= requiredMs) {
    return { ready: true, reason: "" };
  }

  const remainingMs = requiredMs - elapsedMs;
  const remainingMinutes = Math.ceil(remainingMs / 60000);
  return {
    ready: false,
    reason: `Waiting for quiet window: ${remainingMinutes} minute(s) remaining after latest relevant Codex activity.`,
  };
}

async function getCheckState(ref) {
  const [checkRuns, statuses] = await Promise.all([
    listCheckRuns(ref),
    listCommitStatuses(ref),
  ]);
  const latestCheckRuns = latestByKey(checkRuns, (run) => `${run.app?.id || "none"}:${run.name}`);
  const latestStatuses = latestByKey(statuses, (status) => status.context);
  const totalSignals = latestCheckRuns.length + latestStatuses.length;

  if (totalSignals === 0) {
    return {
      ready: true,
      reason: "",
      summary: "none reported",
    };
  }

  const badCheck = latestCheckRuns.find(
    (run) =>
      run.status !== "completed" ||
      !SUCCESSFUL_CHECK_CONCLUSIONS.has(run.conclusion),
  );
  if (badCheck) {
    return {
      ready: false,
      reason: `Check "${badCheck.name}" is ${badCheck.status}/${badCheck.conclusion || "unknown"}.`,
      summary: "not passing",
    };
  }

  const badStatus = latestStatuses.find((status) => status.state !== "success");
  if (badStatus) {
    return {
      ready: false,
      reason: `Status "${badStatus.context}" is ${badStatus.state}.`,
      summary: "not passing",
    };
  }

  return { ready: true, reason: "", summary: "passing" };
}

function latestByKey(items, getKey) {
  const byKey = new Map();

  for (const item of items) {
    const key = getKey(item);
    const existing = byKey.get(key);
    if (!existing || getUpdatedTime(item) > getUpdatedTime(existing)) {
      byKey.set(key, item);
    }
  }

  return [...byKey.values()];
}

function getUpdatedTime(item) {
  const value =
    item.completed_at ||
    item.updated_at ||
    item.started_at ||
    item.created_at ||
    "1970-01-01T00:00:00Z";
  return new Date(value).getTime();
}

function isCodexUser(user) {
  const login = user?.login || "";
  if (!login) {
    return false;
  }

  if (config.codexActorLogin) {
    return login === config.codexActorLogin;
  }

  return DEFAULT_CODEX_ACTOR_LOGINS.has(login);
}

function isTrustedLoopComment(comment) {
  const login = comment.user?.login || "";
  return login === "github-actions[bot]";
}

function getCommitTimestamp(commit) {
  const timestamp =
    commit.commit?.committer?.date ||
    commit.commit?.author?.date ||
    commit.committer?.date ||
    commit.author?.date;
  if (!timestamp) {
    throw new Error(`Could not determine timestamp for commit ${commit.sha}`);
  }

  return new Date(timestamp);
}

function detectWarnings(files) {
  const warnings = new Set();

  for (const file of files) {
    const filename = file.filename || "";
    const lower = filename.toLowerCase();
    const basename = lower.split("/").pop() || lower;

    if (
      lower.includes("auth") ||
      lower.includes("security") ||
      lower.includes("secret") ||
      lower.includes("permission") ||
      basename.startsWith(".env")
    ) {
      warnings.add(WARNING_LABELS.security.label);
    }

    if (
      lower.includes("migration") ||
      lower.includes("/db/") ||
      lower.includes("/database/") ||
      lower.includes("/prisma/") ||
      lower.includes("/supabase/") ||
      basename === "schema.sql"
    ) {
      warnings.add(WARNING_LABELS.db.label);
    }

    if (
      lower.startsWith(".github/workflows/") ||
      lower.startsWith(".github/actions/") ||
      basename === "action.yml" ||
      basename === "action.yaml"
    ) {
      warnings.add(WARNING_LABELS.workflow.label);
    }

    if (
      [
        "package.json",
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "bun.lockb",
        "requirements.txt",
        "pyproject.toml",
        "poetry.lock",
        "pipfile",
        "pipfile.lock",
        "go.mod",
        "go.sum",
        "cargo.toml",
        "cargo.lock",
        "gemfile",
        "gemfile.lock",
        "composer.json",
        "composer.lock",
        "pom.xml",
        "build.gradle",
        "build.gradle.kts",
      ].includes(basename)
    ) {
      warnings.add(WARNING_LABELS.dependency.label);
    }
  }

  return [...warnings].sort();
}

async function applyWarningLabels(issueNumber, warnings) {
  await addLabels(issueNumber, warnings);

  const currentWarnings = new Set(warnings);
  const staleWarnings = Object.values(WARNING_LABELS)
    .map((definition) => definition.label)
    .filter((label) => !currentWarnings.has(label));

  for (const label of staleWarnings) {
    await removeLabel(issueNumber, label);
  }
}

async function addLabels(issueNumber, labels) {
  for (const label of labels) {
    await ensureLabel(label);
  }

  if (labels.length === 0) {
    return;
  }

  try {
    await api("POST", `/repos/${config.owner}/${config.repo}/issues/${issueNumber}/labels`, {
      body: { labels },
    });
  } catch (error) {
    console.warn(`Could not add label(s) ${labels.join(", ")}: ${error.message}`);
  }
}

async function removeLabel(issueNumber, label) {
  try {
    await api(
      "DELETE",
      `/repos/${config.owner}/${config.repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
      { allow404: true },
    );
  } catch (error) {
    console.warn(`Could not remove label ${label}: ${error.message}`);
  }
}

async function ensureLabel(label) {
  const warningDefinition = Object.values(WARNING_LABELS).find(
    (definition) => definition.label === label,
  );
  const labelDefinition =
    warningDefinition ||
    {
      label,
      color: label === STATUS_LABEL_READY ? "0e8a16" : "b60205",
      description: `Managed by the Codex review loop: ${label}.`,
    };

  try {
    await api(
      "POST",
      `/repos/${config.owner}/${config.repo}/labels`,
      {
        body: {
          name: labelDefinition.label,
          color: labelDefinition.color,
          description: labelDefinition.description,
        },
      },
    );
  } catch (error) {
    if (error.status !== 422) {
      console.warn(`Could not ensure label ${label}: ${error.message}`);
    }
  }
}

async function getSinglePullRequest(number) {
  const pr = await api("GET", `/repos/${config.owner}/${config.repo}/pulls/${number}`, {
    allow404: true,
  });

  if (!pr) {
    log(`No pull request found for #${number}; skipping event.`);
    return [];
  }

  if (pr.state !== "open") {
    log(`PR #${number} is ${pr.state}; skipping.`);
    return [];
  }

  return [pr];
}

async function getPullRequestsToProcess() {
  if (config.prNumber) {
    return getSinglePullRequest(config.prNumber);
  }

  if (config.headSha) {
    return listPullRequestsForCommit(config.headSha);
  }

  return listOpenPullRequests();
}

async function listOpenPullRequests() {
  return paginate(`/repos/${config.owner}/${config.repo}/pulls`, {
    state: "open",
    sort: "updated",
    direction: "desc",
  });
}

async function listPullRequestsForCommit(ref) {
  const prs = await paginate(
    `/repos/${config.owner}/${config.repo}/commits/${ref}/pulls`,
  );

  return prs.filter((pr) => pr.state === "open");
}

async function getCommit(ref) {
  return api("GET", `/repos/${config.owner}/${config.repo}/commits/${ref}`);
}

async function listIssueComments(issueNumber) {
  return paginate(`/repos/${config.owner}/${config.repo}/issues/${issueNumber}/comments`);
}

async function listPullReviewComments(issueNumber) {
  return paginate(`/repos/${config.owner}/${config.repo}/pulls/${issueNumber}/comments`);
}

async function listPullReviews(issueNumber) {
  return paginate(`/repos/${config.owner}/${config.repo}/pulls/${issueNumber}/reviews`);
}

async function listIssueReactions(issueNumber) {
  return paginate(`/repos/${config.owner}/${config.repo}/issues/${issueNumber}/reactions`);
}

async function listChangedFiles(issueNumber) {
  return paginate(`/repos/${config.owner}/${config.repo}/pulls/${issueNumber}/files`);
}

async function listCheckRuns(ref) {
  const runs = [];
  let page = 1;

  while (true) {
    const response = await api(
      "GET",
      `/repos/${config.owner}/${config.repo}/commits/${ref}/check-runs`,
      {
        query: { per_page: 100, page },
      },
    );
    const pageRuns = response.check_runs || [];
    runs.push(...pageRuns);

    if (pageRuns.length < 100) {
      break;
    }
    page += 1;
  }

  return runs;
}

async function listCommitStatuses(ref) {
  return paginate(`/repos/${config.owner}/${config.repo}/commits/${ref}/statuses`);
}

async function createIssueComment(issueNumber, body) {
  return api("POST", `/repos/${config.owner}/${config.repo}/issues/${issueNumber}/comments`, {
    body: { body },
  });
}

async function updateIssueComment(commentId, body) {
  return api("PATCH", `/repos/${config.owner}/${config.repo}/issues/comments/${commentId}`, {
    body: { body },
  });
}

async function paginate(path, query = {}) {
  const results = [];
  let page = 1;

  while (true) {
    const pageResults = await api("GET", path, {
      query: { ...query, per_page: 100, page },
    });

    if (!Array.isArray(pageResults)) {
      throw new Error(`Expected paginated array from ${path}`);
    }

    results.push(...pageResults);

    if (pageResults.length < 100) {
      break;
    }

    page += 1;
  }

  return results;
}

async function api(method, path, options = {}) {
  const url = new URL(`${API_ROOT}${path}`);
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const isMutation = !["GET", "HEAD"].includes(method);
  if (config.dryRun && isMutation) {
    log(`[dry-run] ${method} ${url.pathname}`);
    return {};
  }

  const response = await fetch(url, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${config.token}`,
      "User-Agent": "codex-review-loop",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (options.allow404 && response.status === 404) {
    return null;
  }

  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message = data?.message || response.statusText;
    const error = new Error(`${method} ${url.pathname} failed: ${message}`);
    error.status = response.status;
    throw error;
  }

  return data;
}

function requireEnv(name) {
  const value = env(name, "");
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined ? fallback : value;
}

function readBoolean(name, fallback) {
  const value = env(name, String(fallback)).trim().toLowerCase();
  if (["false", "0", "no", "off"].includes(value)) {
    return false;
  }
  if (["true", "1", "yes", "on"].includes(value)) {
    return true;
  }
  return fallback;
}

function parseOptionalInteger(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

function log(message) {
  console.log(`[codex-review-loop] ${message}`);
}
