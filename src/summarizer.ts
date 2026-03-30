import Anthropic from "@anthropic-ai/sdk";
import type { WeeklyData, RepoActivity, PullRequest, Issue, Discussion } from "./types.js";
import type { XlsSpec, AmendmentStatus, BlogPost, SecurityAdvisory } from "./collector.js";

// Rough estimate: 1 token ≈ 4 chars for English text
const CHARS_PER_TOKEN = 4;
const MAX_INPUT_TOKENS = 180_000; // Leave room for system prompt + output

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function buildRepoSection(repo: RepoActivity): string {
  const parts: string[] = [`## ${repo.repo}`];

  if (repo.releases.length > 0) {
    parts.push("\n### Releases");
    for (const r of repo.releases) {
      parts.push(`- **${r.name}** (${r.tagName}) - ${r.url}`);
      if (r.body) parts.push(`  ${r.body}`);
    }
  }

  if (repo.mergedPRs.length > 0) {
    parts.push("\n### Merged PRs");
    for (const pr of repo.mergedPRs) {
      const diff = `+${pr.diffStats.additions}/-${pr.diffStats.deletions} in ${pr.diffStats.changedFiles} files`;
      const linkedStr = pr.linkedIssues.length > 0
        ? ` Closes: ${pr.linkedIssues.map((i) => `#${i.number} (${i.title}, ${i.url})`).join(", ")}`
        : "";
      const reviewSummary = pr.reviewContent.length > 0
        ? ` Reviews: ${pr.reviewContent.map((r) => `${r.state} by @${r.author}`).join(", ")}`
        : "";
      parts.push(
        `- #${pr.number}: ${pr.title} (by @${pr.author}, ${pr.authorAssociation}) ${pr.url} [${diff}]${linkedStr}${reviewSummary} ${pr.labels.length ? `[${pr.labels.join(", ")}]` : ""}`
      );
      if (pr.body) parts.push(`  ${pr.body}`);
      for (const review of pr.reviewContent) {
        if (review.body) parts.push(`  > Review (${review.state}) by @${review.author}: ${review.body}`);
      }
      for (const comment of pr.commentContent) {
        parts.push(`  > Comment by @${comment.author}: ${comment.body}`);
      }
    }
  }

  if (repo.openedPRs.length > 0) {
    parts.push("\n### Opened PRs (in progress)");
    for (const pr of repo.openedPRs) {
      const diff = `+${pr.diffStats.additions}/-${pr.diffStats.deletions} in ${pr.diffStats.changedFiles} files`;
      const reviewInfo = pr.reviews > 0 ? ` (${pr.reviews} reviews, ${pr.reviewComments} comments)` : "";
      const linkedStr = pr.linkedIssues.length > 0
        ? ` Closes: ${pr.linkedIssues.map((i) => `#${i.number} (${i.title}, ${i.url})`).join(", ")}`
        : "";
      const reviewSummary = pr.reviewContent.length > 0
        ? ` Reviews: ${pr.reviewContent.map((r) => `${r.state} by @${r.author}`).join(", ")}`
        : "";
      parts.push(
        `- #${pr.number}: ${pr.title} (by @${pr.author}, ${pr.authorAssociation}) ${pr.url} [${diff}]${reviewInfo}${linkedStr}${reviewSummary} ${pr.labels.length ? `[${pr.labels.join(", ")}]` : ""}`
      );
      if (pr.body) parts.push(`  ${pr.body}`);
      for (const review of pr.reviewContent) {
        if (review.body) parts.push(`  > Review (${review.state}) by @${review.author}: ${review.body}`);
      }
      for (const comment of pr.commentContent) {
        parts.push(`  > Comment by @${comment.author}: ${comment.body}`);
      }
    }
  }

  if (repo.activeBranches.length > 0) {
    parts.push("\n### Active Branches (no PR yet)");
    for (const b of repo.activeBranches) {
      const branchUrl = `https://github.com/${repo.owner}/${repo.repo}/tree/${encodeURIComponent(b.name)}`;
      parts.push(
        `- **${b.name}** by @${b.author} — "${b.lastCommitMessage}" (${b.lastCommitDate.slice(0, 10)}, ${b.aheadBy} commits ahead) ${branchUrl}`
      );
    }
  }

  if (repo.closedIssues.length > 0) {
    parts.push("\n### Closed Issues");
    for (const issue of repo.closedIssues) {
      parts.push(
        `- #${issue.number}: ${issue.title} (by @${issue.author}, ${issue.authorAssociation}, ${issue.comments} comments) ${issue.url}`
      );
      for (const comment of issue.commentContent) {
        parts.push(`  > @${comment.author}: ${comment.body}`);
      }
    }
  }

  if (repo.openedIssues.length > 0) {
    parts.push("\n### New Issues");
    for (const issue of repo.openedIssues) {
      parts.push(
        `- #${issue.number}: ${issue.title} (by @${issue.author}, ${issue.authorAssociation}) ${issue.url} ${issue.labels.length ? `[${issue.labels.join(", ")}]` : ""}`
      );
      if (issue.body) parts.push(`  ${issue.body}`);
      for (const comment of issue.commentContent) {
        parts.push(`  > @${comment.author}: ${comment.body}`);
      }
    }
  }

  if (repo.discussions.length > 0) {
    parts.push("\n### Discussions");
    for (const d of repo.discussions) {
      parts.push(
        `- #${d.number}: ${d.title} [${d.category}] (by @${d.author}, ${d.authorAssociation}, ${d.comments} comments) ${d.url}`
      );
      if (d.body) parts.push(`  ${d.body}`);
      for (const comment of d.commentContent) {
        parts.push(`  > @${comment.author}: ${comment.body}`);
      }
    }
  }

  if (repo.commits.totalCount > 0) {
    parts.push(
      `\n### Commit Activity: ${repo.commits.totalCount} commits by ${repo.commits.authors.join(", ")}`
    );
  }

  const hasActivity =
    repo.mergedPRs.length +
      repo.openedPRs.length +
      repo.openedIssues.length +
      repo.closedIssues.length +
      repo.discussions.length +
      repo.releases.length +
      repo.commits.totalCount +
      repo.activeBranches.length >
    0;

  return hasActivity ? parts.join("\n") : "";
}


const SYSTEM_PROMPT = `You are a DevRel / technical writer for the XRP Ledger community. Transform raw GitHub activity data into an engaging weekly summary.

Audience: XRPL validators, developers, and non-technical community members.

# Rules

**URLs — CRITICAL:**
- ONLY use URLs that appear explicitly in the provided data. Every PR, issue, discussion, release, and blog post has a URL in the data.
- NEVER construct, guess, or infer URLs. If you don't see a URL in the data, do not link to it.
- For PRs/issues, the URL is in the data line (e.g., "https://github.com/XRPLF/rippled/pull/1234"). Use it directly.
- The only external URLs you may use without them appearing in the data are: https://x.com/XRPLF and https://x.com/RippleXDev (official accounts).

**Content:**
- Unconfirmed bugs, open issues, and unmerged PRs are never headline material — they belong in "What to Watch" or "Community".
- Group by theme (protocol, performance, security, SDKs, docs, infra) — not by repo. Always name the repo in each item so the reader knows which codebase is affected.
- **Documentation is first-class.** Activity on documentation repos (xrpl-dev-portal, XRPL-Standards, opensource.ripple.com) must always be surfaced — these repos publish to xrpl.org and are how developers learn about new features. A new XLS spec, an amendment doc, or a dev portal restructure is as newsworthy as a code change. Include doc PRs (merged or in-progress) in their relevant sections, and mention significant doc work in TL;DR when it is merged.
- For protocol/amendment changes: explain network impact in plain terms, flag action needed by validators/operators
- Reference XLS spec numbers when mentioning amendments (e.g., "Batch (XLS-56)"). The XLS index is in the data.
- Use the Amendment Lifecycle Status to report accurate statuses. Don't present already-known statuses as news unless they changed THIS week.
- Use PR review states (APPROVED, CHANGES_REQUESTED) to contextualize readiness — e.g., "approved by 3 reviewers" or "has outstanding change requests"
- Use labels to flag important items: "bug", "breaking change", "API Change" labels deserve prominent mention. Other labels can provide thematic context.

**Responsible Disclosure — CRITICAL:**
- Security-related items (PRs/issues with labels containing "security" or "vulnerability", or titles/bodies mentioning CVEs, exploits, or vulnerabilities) require extreme caution.
- If a security fix has been MERGED but there is NO corresponding tagged release in the data, do NOT highlight it. Mention it only as a routine merge with minimal detail (e.g., "a fix was merged to develop in rippled"). Do not describe the vulnerability, attack vector, or affected component.
- If a security fix has a tagged release AND an official advisory or blog post in the data, you may describe it — but only using the language from the official advisory. Do not add interpretation or severity beyond what the advisory states.
- Never put unpatched or unreleased security items in TL;DR, headings, or the Twitter thread.
- When in doubt, understate. A missed highlight is harmless; amplifying an unpatched vulnerability is dangerous.

- Use discussion data to surface community conversations, feature proposals, and governance topics
- If a "Previous Week Report" is provided, you MUST compare it with the current week in "By the Numbers" — show changes in PR/commit counts (↑/↓/flat), note items that were "In Progress" last week and merged this week, and highlight new trends
- Only facts from the data. No speculation, no assumptions, no filler on quiet weeks. Do not label or categorize PRs beyond what their title and body explicitly state. For example, do not add "Hooks" or any other feature name to a description unless the PR title or body literally contains that word. "host functions" does NOT imply "Hooks". Hooks are NOT a feature of the XRPL — never mention Hooks in the output. Use the exact wording from the PR. This applies to all repos, especially XRPL-Standards where PRs touch individual specs.
- Do NOT overstate severity. Use the actual labels (Bug, Security, Critical) to gauge importance — do not infer severity beyond what the labels and body state. Preserve caveats and qualifiers from the original text. An unconfirmed bug is not a confirmed vulnerability. NEVER use words like "Critical", "Urgent", "Emergency", or "Security" in section titles or headings unless the PR/issue has the corresponding label. A bug fix is a bug fix, not a "Critical Fix".
- Do not mention Ripple or XRP unless directly relevant. No marketing or price talk.
- Do not repeat the same PR/issue across multiple sections. Each item belongs in ONE section: merged, in progress (open), or what to watch. Reference by link if needed elsewhere.

**Contributors:**
- Only flag someone as a new contributor if their authorAssociation is exactly FIRST_TIME_CONTRIBUTOR. Never guess.
- Never expose raw authorAssociation values (NONE, MEMBER, CONTRIBUTOR, etc.) in the output. Use natural language instead: "community member", "contributor", "core team".

**Formatting:**
- Link PRs/issues as markdown links: [rippled#1234](url) — use the exact URL from the data
- Use diff stats (+additions/-deletions) to convey change significance
- Use linked issues (Closes: #N) to explain WHY, not just what
- "By the Numbers" must use exact integers — never use "~", "about", or "approximately"
- Target length: ~800-1200 words for a normal week. Shorter if quiet, longer if major.

# Output format

You MUST follow this exact structure. Use the exact heading levels shown. Use \`---\` horizontal rules between each major section. Do not add or remove sections. Do not change heading levels.

# XRPL Developments Weekly Summary: {date_range}

## TL;DR
1-3 sentences summarizing the week's key developments. Cover the 2-4 most significant merged items and releases across all repos — not just rippled. Actively look for major changes in every repo (client libraries, docs/portal, Clio, standards) and include them if they are significant. A large docs restructure or a new SDK feature matters as much as a protocol change. Do not focus on a single repo. ONLY mention merged PRs and releases here — no open bugs, no open issues, no unmerged work. Always name the repo (e.g., "in rippled", "in xrpl-py", "on the developer portal") so readers know which codebase is affected.

---

## What Merged

Start with: *Note: All rippled changes below were merged to the \`develop\` branch and are not yet live on the network. A tagged release is required for any change to reach production.*

Group rippled PRs by theme using \`### \` sub-headings. Use these exact categories (omit any that have no items):

### Protocol & Feature Work (rippled — merged to develop)
### Bug Fixes & Stability (rippled — merged to develop)
### Refactoring & Architecture (rippled — merged to develop)
### Dependencies & Build (rippled — merged to develop)
### CI & Docs (rippled — merged to develop)

Then list other repos, each with its own \`### \` sub-heading:

### Clio (API Server)
### Developer Portal (xrpl-dev-portal)
### XRPL-Standards
### Java SDK (xrpl4j)
### JavaScript SDK (xrpl.js)
### Python SDK (xrpl-py)
### opensource.ripple.com

Omit any repo sub-heading that has no merged PRs. Each item: what changed, why it matters, link.
IMPORTANT: Merging to the develop branch does NOT mean the change is live on the network. Only tagged releases (e.g., rippled 3.1.1) represent code that has actually shipped to production. Make this distinction clear — say "merged to develop" or "merged to main" depending on the target branch, and only say "released" or "shipped" when there is an actual release in the data.

---

## In Progress
Notable open PRs and active branches. Always name the repo. Mention review status (approved, changes requested, draft) when available. Distinguish draft PRs (early/exploratory) from PRs in active review (closer to landing). If a reviewer is from the core team vs. an external contributor, note it when it signals readiness.

---

## What to Watch Next Week
2-4 bullet points of items likely to land, need attention, or worth following. For each item, explain WHY it's worth watching: is it close to merging (approved, no outstanding changes)? Does it have operator/validator impact? Is it blocking other work? Based only on open PRs nearing merge, active branches with significant work, ongoing discussions, or announced timelines from the data. No speculation.

---

## Community & Discussions
Issues, discussions, external contributors.

---

## By the Numbers

Compared to last week ({previous_date_range}):

| Metric | This Week | Last Week | Change |
|---|---|---|---|

Exact integer counts for repos, PRs merged, PRs opened, releases, commits. Use ↑/↓/flat for changes. No approximations. After the table, add a short paragraph noting carryovers (items that were "In Progress" last week and merged this week) and notable trends.

---

## TL;DR for X (Twitter)
A thread of 2-4 short posts (each max 280 chars). First post hooks the reader with the headline. Following posts cover the other key developments of the week. No hashtags. Informative, not hype. End the thread with a call to action — link to a relevant repo, PR, release, or doc page ONLY if the URL is in the data. You can also reference @XRPLF (foundation) and @RippleXDev (developer updates).

---

## Plain English Summary
2-3 paragraphs for non-developers. Conversational tone, no jargon. When mentioning a project, always give the full name first then the repo (e.g., "the Python SDK (xrpl-py)", "the API server Clio"). For each key change, explain:
1. What changed (translate technical terms)
2. What it concretely means for users, validators, or the network (e.g., "Batch disabled means users cannot bundle transactions until a future release re-enables it", "memory optimization means nodes use less RAM over time, reducing hosting costs")
3. For new features and releases: what new use cases or capabilities does this unlock? Only mention use cases that are directly and obviously enabled by the change — do not speculate or extrapolate. (e.g., "wallets can now auto-detect new transaction types without manual updates", "developers can build lending products on XRPL for the first time")
4. Stay factual — only state implications that are directly derivable from the change itself, never speculate on timeline, intent, or future plans
End with a separate closing line (its own paragraph) linking to relevant sources from the data and/or mentioning @XRPLF and @RippleXDev on X for ongoing updates. This line must be separated from the previous paragraph by a blank line.

---
*Summary AI-generated from GitHub activity data. This report covers PRs, issues, and discussions captured via the GitHub API — activity on development and test branches without associated PRs may not be reflected. Check the [XRPLF repos](https://github.com/XRPLF) directly for full activity. All links sourced from GitHub and xrpl.org.*`;

export async function callClaudeWithRetry(
  client: Anthropic,
  model: string,
  system: string,
  userMessage: string,
  maxTokens: number,
  maxRetries = 3
): Promise<string> {
  const inputTokens = estimateTokens(system + userMessage);
  console.log(`  Estimated input: ~${inputTokens} tokens`);

  if (inputTokens > MAX_INPUT_TOKENS) {
    console.warn(`  ⚠ Input (~${inputTokens} tokens) may exceed context window. Summary quality might degrade.`);
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const message = await client.messages.create({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: userMessage }],
        // Use prompt caching for the system prompt (identical every run)
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      });

      const usage = message.usage as any;
      const cacheInfo = usage.cache_read_input_tokens
        ? ` (${usage.cache_read_input_tokens} cached, ${usage.cache_creation_input_tokens ?? 0} cache-written)`
        : "";
      console.log(`  Tokens used: ${usage.input_tokens} in / ${usage.output_tokens} out${cacheInfo} (stop: ${message.stop_reason})`);

      if (message.stop_reason === "max_tokens") {
        console.warn(`  ⚠ Output was truncated at ${maxTokens} tokens. Consider increasing max_tokens.`);
      }

      return message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
    } catch (err: any) {
      const isRetryable =
        err?.status === 429 ||
        err?.status === 529 ||
        err?.status >= 500;

      if (isRetryable && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`  Attempt ${attempt} failed (${err?.status}), retrying in ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }

  throw new Error("Exhausted retries");
}

const SECURITY_LABELS = /\b(security|vulnerability|cve)\b/i;
const SECURITY_TITLE = /\b(CVE-\d{4}-\d+|security|vulnerability|exploit)\b/i;

export interface DisclosureSources {
  advisories?: SecurityAdvisory[];
  blogPosts?: BlogPost[];
}

/** Strip bodies and comments from security-sensitive items so the LLM never sees exploit details.
 *  Items are NOT redacted if official disclosure exists (release, advisory, or blog post). */
export function redactSecurityItems(repos: RepoActivity[], sources: DisclosureSources = {}): RepoActivity[] {
  const REDACTED = "[Content redacted for responsible disclosure]";
  const { advisories = [], blogPosts = [] } = sources;

  // Build set of repos with official public disclosure
  const disclosedRepos = new Set<string>();
  for (const a of advisories) disclosedRepos.add(a.repo);
  for (const p of blogPosts) {
    if (SECURITY_TITLE.test(p.title) || SECURITY_TITLE.test(p.body)) {
      // Blog posts are org-wide, mark all repos as disclosed
      for (const repo of repos) disclosedRepos.add(`${repo.owner}/${repo.repo}`);
    }
  }

  function isSecurityItem(labels: string[], title: string): boolean {
    return labels.some((l) => SECURITY_LABELS.test(l)) || SECURITY_TITLE.test(title);
  }

  return repos.map((repo) => {
    const repoKey = `${repo.owner}/${repo.repo}`;

    // Check if any release in this repo covers a security fix (indicates public disclosure)
    const hasSecurityRelease = repo.releases.some(
      (r) => SECURITY_TITLE.test(r.name) || SECURITY_TITLE.test(r.body)
    );

    // If there's an official disclosure source, don't redact — it's public
    if (hasSecurityRelease || disclosedRepos.has(repoKey)) return repo;

    const redactPR = (pr: PullRequest): PullRequest =>
      isSecurityItem(pr.labels, pr.title)
        ? { ...pr, body: REDACTED, commentContent: [], reviewContent: [] }
        : pr;

    const redactIssue = (issue: Issue): Issue =>
      isSecurityItem(issue.labels, issue.title)
        ? { ...issue, body: REDACTED, commentContent: [] }
        : issue;

    const redactDiscussion = (d: Discussion): Discussion =>
      isSecurityItem([], d.title)
        ? { ...d, body: REDACTED, commentContent: [] }
        : d;

    return {
      ...repo,
      mergedPRs: repo.mergedPRs.map(redactPR),
      openedPRs: repo.openedPRs.map(redactPR),
      openedIssues: repo.openedIssues.map(redactIssue),
      closedIssues: repo.closedIssues.map(redactIssue),
      discussions: repo.discussions.map(redactDiscussion),
    };
  });
}

export function buildAmendmentContext(amendments: AmendmentStatus[]): string {
  if (amendments.length === 0) return "";

  const enabled = amendments.filter((a) => a.networkStatus === "Enabled");
  const voting = amendments.filter((a) => a.networkStatus === "Open for Voting");
  const inDev = amendments.filter((a) => a.networkStatus === "In Development" || (a.networkStatus === "Unknown" && !a.supported && !a.type.startsWith("RETIRE")));
  const obsolete = amendments.filter((a) => a.networkStatus === "Obsolete" || a.type.startsWith("RETIRE"));

  const lines = [
    "## Amendment Lifecycle Status",
    "Source: rippled features.macro + xrpl.org known-amendments. Use this to accurately contextualize protocol changes.\n",
  ];

  if (voting.length > 0) {
    lines.push("### Open for Voting (not yet enabled on mainnet)");
    for (const a of voting) lines.push(`- ${a.name} (${a.type}, Supported::${a.supported ? "yes" : "no"})`);
  }
  if (inDev.length > 0) {
    lines.push("\n### In Development / Not Yet Voting");
    for (const a of inDev) lines.push(`- ${a.name} (${a.type}, Supported::${a.supported ? "yes" : "no"})`);
  }
  // Skip listing obsolete/retired and enabled individually — too many, just counts
  if (enabled.length > 0) {
    lines.push(`\n${enabled.length} amendments already enabled on mainnet. ${obsolete.length} obsolete/retired.`);
  }

  return lines.join("\n");
}

export function buildXlsContext(specs: XlsSpec[]): string {
  if (specs.length === 0) return "";
  const lines = [
    "## XRPL Standards Reference (XLS Specs)",
    "Use this to map amendment names to their formal specifications when discussing protocol changes.\n",
  ];
  for (const s of specs) {
    lines.push(`- **XLS-${s.xls}**: ${s.title} [${s.status}] (${s.category})`);
  }
  return lines.join("\n");
}

export function buildBlogContext(posts: BlogPost[]): string {
  if (posts.length === 0) return "";
  const lines = [
    "## Official Blog Posts (xrpl.org/blog)",
    "These were published during the week. Use them for additional context on announcements, releases, and disclosures. Link to them when relevant.\n",
  ];
  for (const p of posts) {
    lines.push(`### ${p.title}`);
    lines.push(`Date: ${p.date} | URL: ${p.url}`);
    if (p.description) lines.push(`> ${p.description}`);
    lines.push(p.body);
    lines.push("");
  }
  return lines.join("\n");
}

export interface SummarizeResult {
  summary: string;
  input: string;
  systemPrompt: string;
  model: string;
  generatedAt: string;
}

export function buildPrompt(
  data: WeeklyData,
  xlsSpecs: XlsSpec[] = [],
  amendments: AmendmentStatus[] = [],
  blogPosts: BlogPost[] = [],
  advisories: SecurityAdvisory[] = [],
  dailyEspressos: string[] = []
): { userMessage: string; systemPrompt: string; fullDataLength: number } {
  // Redact security-sensitive content before building prompt
  const safeRepos = redactSecurityItems(data.repos, { advisories, blogPosts });

  // Build per-repo sections
  const repoSections = safeRepos
    .map(buildRepoSection)
    .filter(Boolean);

  // Previous week report for week-over-week comparison
  const prevReportSection = data.previousReport
    ? `## Previous Week Report (for comparison)\n\n${data.previousReport}`
    : "";

  // Build XLS specs context
  const xlsContext = buildXlsContext(xlsSpecs);

  // Build amendment lifecycle context
  const amendmentContext = buildAmendmentContext(amendments);

  // Build blog posts context
  const blogContext = buildBlogContext(blogPosts);

  // Daily espressos from this week for continuity
  const dailyContext = dailyEspressos.length > 0
    ? `## Daily Espressos This Week (for context and continuity)\nThese daily digests were published earlier this week. Use them for continuity — avoid contradicting what was already published, and build on their narrative where relevant.\n\n${dailyEspressos.join("\n\n---\n\n")}`
    : "";

  const fullData = repoSections.join("\n\n---\n\n") +
    (prevReportSection ? `\n\n---\n\n${prevReportSection}` : "") +
    (dailyContext ? `\n\n---\n\n${dailyContext}` : "") +
    (blogContext ? `\n\n---\n\n${blogContext}` : "") +
    (xlsContext ? `\n\n---\n\n${xlsContext}` : "") +
    (amendmentContext ? `\n\n---\n\n${amendmentContext}` : "");

  const userMessage = `Here is the raw GitHub activity data for the XRPLF organization for the week of ${data.weekStart} to ${data.weekEnd}. Please produce the weekly summary.\n\n${fullData}`;

  return { userMessage, systemPrompt: SYSTEM_PROMPT, fullDataLength: fullData.length };
}

export async function summarize(
  apiKey: string,
  data: WeeklyData,
  xlsSpecs: XlsSpec[] = [],
  amendments: AmendmentStatus[] = [],
  blogPosts: BlogPost[] = [],
  advisories: SecurityAdvisory[] = [],
  dailyEspressos: string[] = []
): Promise<SummarizeResult> {
  const { userMessage, systemPrompt, fullDataLength } = buildPrompt(data, xlsSpecs, amendments, blogPosts, advisories, dailyEspressos);

  console.log(`\nSending to Claude for summarization (${fullDataLength} chars of activity data)...`);

  const client = new Anthropic({ apiKey });
  const model = process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6";
  console.log(`  Using model: ${model}`);

  const summary = await callClaudeWithRetry(
    client,
    model,
    systemPrompt,
    userMessage,
    10000
  );

  return { summary, input: userMessage, systemPrompt, model, generatedAt: new Date().toISOString() };
}
