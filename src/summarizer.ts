import Anthropic from "@anthropic-ai/sdk";
import type { WeeklyData, RepoActivity } from "./types.js";
import type { XlsSpec, AmendmentStatus, BlogPost } from "./collector.js";

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
        ? ` Closes: ${pr.linkedIssues.map((i) => `#${i.number} (${i.title})`).join(", ")}`
        : "";
      parts.push(
        `- #${pr.number}: ${pr.title} (by @${pr.author}, ${pr.authorAssociation}) [${diff}]${linkedStr} ${pr.labels.length ? `[${pr.labels.join(", ")}]` : ""}`
      );
      if (pr.body) parts.push(`  ${pr.body}`);
      for (const review of pr.reviewContent) {
        parts.push(`  > Review (${review.state}) by @${review.author}: ${review.body}`);
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
        ? ` Closes: ${pr.linkedIssues.map((i) => `#${i.number} (${i.title})`).join(", ")}`
        : "";
      parts.push(
        `- #${pr.number}: ${pr.title} (by @${pr.author}, ${pr.authorAssociation}) [${diff}]${reviewInfo}${linkedStr} ${pr.labels.length ? `[${pr.labels.join(", ")}]` : ""}`
      );
      if (pr.body) parts.push(`  ${pr.body}`);
      for (const review of pr.reviewContent) {
        parts.push(`  > Review (${review.state}) by @${review.author}: ${review.body}`);
      }
      for (const comment of pr.commentContent) {
        parts.push(`  > Comment by @${comment.author}: ${comment.body}`);
      }
    }
  }

  if (repo.activeBranches.length > 0) {
    parts.push("\n### Active Branches (no PR yet)");
    for (const b of repo.activeBranches) {
      parts.push(
        `- **${b.name}** by @${b.author} — "${b.lastCommitMessage}" (${b.lastCommitDate.slice(0, 10)}, ${b.aheadBy} commits ahead)`
      );
    }
  }

  if (repo.closedIssues.length > 0) {
    parts.push("\n### Closed Issues");
    for (const issue of repo.closedIssues) {
      parts.push(
        `- #${issue.number}: ${issue.title} (by @${issue.author}, ${issue.authorAssociation}, ${issue.comments} comments)`
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
        `- #${issue.number}: ${issue.title} (by @${issue.author}, ${issue.authorAssociation}) ${issue.labels.length ? `[${issue.labels.join(", ")}]` : ""}`
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
        `- #${d.number}: ${d.title} [${d.category}] (by @${d.author}, ${d.authorAssociation}, ${d.comments} comments)`
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

function buildWeekDiffSection(current: WeeklyData, previous: WeeklyData): string {
  const lines: string[] = ["## Week-over-Week Changes"];

  for (const repo of current.repos) {
    const prevRepo = previous.repos.find((r) => r.repo === repo.repo);
    if (!prevRepo) continue;

    const notes: string[] = [];

    // PRs that were open last week and merged this week
    const prevOpenNumbers = new Set(prevRepo.openedPRs.map((p) => p.number));
    const newlyMerged = repo.mergedPRs.filter((p) => prevOpenNumbers.has(p.number));
    if (newlyMerged.length > 0) {
      notes.push(
        `Opened last week, now merged: ${newlyMerged.map((p) => `#${p.number} (${p.title})`).join(", ")}`
      );
    }

    // Issues that were open last week and closed this week
    const prevOpenIssueNumbers = new Set(prevRepo.openedIssues.map((i) => i.number));
    const newlyClosed = repo.closedIssues.filter((i) => prevOpenIssueNumbers.has(i.number));
    if (newlyClosed.length > 0) {
      notes.push(
        `Opened last week, now closed: ${newlyClosed.map((i) => `#${i.number} (${i.title})`).join(", ")}`
      );
    }

    // PRs still open from last week (long-running)
    const currentOpenNumbers = new Set(repo.openedPRs.map((p) => p.number));
    const stillOpen = prevRepo.openedPRs.filter((p) => currentOpenNumbers.has(p.number));
    if (stillOpen.length > 0) {
      notes.push(
        `Still in progress from last week: ${stillOpen.map((p) => `#${p.number} (${p.title})`).join(", ")}`
      );
    }

    // Commit velocity comparison
    const prevCommits = prevRepo.commits.totalCount;
    const currCommits = repo.commits.totalCount;
    if (prevCommits > 0 || currCommits > 0) {
      const delta = currCommits - prevCommits;
      const direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
      notes.push(`Commit velocity: ${currCommits} (${direction} from ${prevCommits} last week)`);
    }

    if (notes.length > 0) {
      lines.push(`\n### ${repo.repo}`);
      for (const note of notes) {
        lines.push(`- ${note}`);
      }
    }
  }

  return lines.length > 1 ? lines.join("\n") : "";
}

const SYSTEM_PROMPT = `You are a DevRel / technical writer for the XRP Ledger community. Transform raw GitHub activity data into an engaging weekly summary.

Audience: XRPL validators, developers, and non-technical community members.

# Rules

**Content:**
- Lead with the single most impactful development as headline
- Group by theme (protocol, performance, security, SDKs, docs, infra) — not by repo
- For protocol/amendment changes: explain network impact in plain terms, flag action needed by validators/operators
- Reference XLS spec numbers when mentioning amendments (e.g., "Batch (XLS-56)"). The XLS index is in the data.
- Use the Amendment Lifecycle Status to report accurate statuses. Don't present already-known statuses as news unless they changed THIS week.
- Use week-over-week diff data to show momentum when available
- Only facts from the data. No speculation, no assumptions, no filler on quiet weeks.
- Do not mention Ripple or XRP unless directly relevant. No marketing or price talk.

**Contributors:**
- Only flag someone as a new contributor if their authorAssociation is exactly FIRST_TIME_CONTRIBUTOR. Never guess.

**Formatting:**
- Link PRs/issues as markdown links: [rippled#1234](url) — URLs are in the data
- Use diff stats (+additions/-deletions) to convey change significance
- Use linked issues (Closes: #N) to explain WHY, not just what
- Use exact numbers in "By the Numbers" — no approximations
- Target length: ~800-1200 words for a normal week. Shorter if quiet, longer if major.

# Output format

# XRPL Developments Weekly Summary: {date_range}

## Headline
One sentence — biggest impact on the network or community.

## What Shipped
Grouped by theme. Each item: what changed, why it matters, link.

## In Progress
Notable open PRs and active branches.

## Community & Discussions
Issues, discussions, external contributors.

## By the Numbers
| Metric | Count |
Exact counts for repos, PRs merged, PRs opened, releases, contributors, commits.

## TL;DR for X (Twitter)
A thread of 2-4 short posts (each max 280 chars). First post hooks the reader with the headline. Following posts cover the other key developments of the week. No hashtags. Informative, not hype. End the thread with a call to action — link to a relevant repo, PR, release, or https://xrpl.org docs page. You can also reference these official accounts when relevant: @XRPLF (foundation), @RippleXDev (developer updates).

## Plain English Summary
2-3 paragraphs for non-developers. Conversational tone, no jargon. For each key change, explain:
1. What changed (translate technical terms)
2. What it concretely means for users, validators, or the network (e.g., "Batch disabled means users cannot bundle transactions until a future release re-enables it", "memory optimization means nodes use less RAM over time, reducing hosting costs")
3. Stay factual — only state implications that are directly derivable from the change itself, never speculate on timeline, intent, or future plans
End with links to where readers can learn more (release pages, xrpl.org docs, relevant PRs, @XRPLF and @RippleXDev on X for ongoing updates).

---
*Summary AI-generated from GitHub activity data.*`;

async function callClaudeWithRetry(
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

function buildAmendmentContext(amendments: AmendmentStatus[]): string {
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

function buildXlsContext(specs: XlsSpec[]): string {
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

function buildBlogContext(posts: BlogPost[]): string {
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
}

export async function summarize(
  apiKey: string,
  data: WeeklyData,
  xlsSpecs: XlsSpec[] = [],
  amendments: AmendmentStatus[] = [],
  blogPosts: BlogPost[] = []
): Promise<SummarizeResult> {
  const client = new Anthropic({ apiKey });

  // Build per-repo sections
  const repoSections = data.repos
    .map(buildRepoSection)
    .filter(Boolean);

  // Build week-over-week diff if previous week data is available
  let diffSection = "";
  if (data.previousWeek) {
    diffSection = buildWeekDiffSection(data, data.previousWeek);
  }

  // Build XLS specs context
  const xlsContext = buildXlsContext(xlsSpecs);

  // Build amendment lifecycle context
  const amendmentContext = buildAmendmentContext(amendments);

  // Build blog posts context
  const blogContext = buildBlogContext(blogPosts);

  const fullData = repoSections.join("\n\n---\n\n") +
    (diffSection ? `\n\n---\n\n${diffSection}` : "") +
    (blogContext ? `\n\n---\n\n${blogContext}` : "") +
    (xlsContext ? `\n\n---\n\n${xlsContext}` : "") +
    (amendmentContext ? `\n\n---\n\n${amendmentContext}` : "");

  console.log(`\nSending to Claude for summarization (${fullData.length} chars of activity data)...`);

  const userMessage = `Here is the raw GitHub activity data for the XRPLF organization for the week of ${data.weekStart} to ${data.weekEnd}. Please produce the weekly summary.\n\n${fullData}`;

  const model = process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6";
  console.log(`  Using model: ${model}`);

  const summary = await callClaudeWithRetry(
    client,
    model,
    SYSTEM_PROMPT,
    userMessage,
    10000
  );

  return { summary, input: userMessage, systemPrompt: SYSTEM_PROMPT };
}
