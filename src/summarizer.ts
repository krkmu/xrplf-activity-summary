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
      const branchUrl = `https://github.com/XRPLF/${repo.repo}/tree/${encodeURIComponent(b.name)}`;
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

**URLs — CRITICAL:**
- ONLY use URLs that appear explicitly in the provided data. Every PR, issue, discussion, release, and blog post has a URL in the data.
- NEVER construct, guess, or infer URLs. If you don't see a URL in the data, do not link to it.
- For PRs/issues, the URL is in the data line (e.g., "https://github.com/XRPLF/rippled/pull/1234"). Use it directly.
- The only external URLs you may use without them appearing in the data are: https://x.com/XRPLF and https://x.com/RippleXDev (official accounts).

**Content:**
- Unconfirmed bugs, open issues, and unmerged PRs are never headline material — they belong in "What to Watch" or "Community".
- Group by theme (protocol, performance, security, SDKs, docs, infra) — not by repo
- For protocol/amendment changes: explain network impact in plain terms, flag action needed by validators/operators
- Reference XLS spec numbers when mentioning amendments (e.g., "Batch (XLS-56)"). The XLS index is in the data.
- Use the Amendment Lifecycle Status to report accurate statuses. Don't present already-known statuses as news unless they changed THIS week.
- Use PR review states (APPROVED, CHANGES_REQUESTED) to contextualize readiness — e.g., "approved by 3 reviewers" or "has outstanding change requests"
- Use labels to flag important items: "security", "bug", "breaking change", "API Change" labels deserve prominent mention. Other labels can provide thematic context.
- Use discussion data to surface community conversations, feature proposals, and governance topics
- If "Week-over-Week Changes" data is present, you MUST include it in "By the Numbers" — show commit velocity changes (↑/↓/flat) and note PRs that were opened last week and merged this week
- Only facts from the data. No speculation, no assumptions, no filler on quiet weeks.
- Do NOT overstate severity. Use the actual labels (Bug, Security, Critical) to gauge importance — do not infer severity beyond what the labels and body state. Preserve caveats and qualifiers from the original text. An unconfirmed bug is not a confirmed vulnerability. NEVER use words like "Critical", "Urgent", "Emergency", or "Security" in section titles or headings unless the PR/issue has the corresponding label. A bug fix is a bug fix, not a "Critical Fix".
- Do not mention Ripple or XRP unless directly relevant. No marketing or price talk.
- Do not repeat the same PR/issue across multiple sections. Each item belongs in ONE section: shipped (merged), in progress (open), or what to watch. Reference by link if needed elsewhere.

**Contributors:**
- Only flag someone as a new contributor if their authorAssociation is exactly FIRST_TIME_CONTRIBUTOR. Never guess.
- Never expose raw authorAssociation values (NONE, MEMBER, CONTRIBUTOR, etc.) in the output. Use natural language instead: "community member", "external contributor", "core team".

**Formatting:**
- Link PRs/issues as markdown links: [rippled#1234](url) — use the exact URL from the data
- Use diff stats (+additions/-deletions) to convey change significance
- Use linked issues (Closes: #N) to explain WHY, not just what
- "By the Numbers" must use exact integers — never use "~", "about", or "approximately"
- Target length: ~800-1200 words for a normal week. Shorter if quiet, longer if major.

# Output format

# XRPL Developments Weekly Summary: {date_range}

## Headline
1-2 sentences summarizing the week's key shipped developments. Cover the 2-3 most significant merged items across all repos. Do not focus on a single item. ONLY mention merged PRs and releases here — no open bugs, no open issues, no unmerged work.

## What Shipped
Grouped by theme. Each item: what changed, why it matters, link.

## In Progress
Notable open PRs and active branches. Mention review status (approved, changes requested, draft) when available.

## What to Watch Next Week
2-4 bullet points of items likely to land, need attention, or worth following. Based only on open PRs nearing merge, active branches with significant work, ongoing discussions, or announced timelines from the data. No speculation.

## Community & Discussions
Issues, discussions, external contributors.

## By the Numbers
| Metric | Count |
Exact integer counts for repos, PRs merged, PRs opened, releases, contributors, commits. No approximations.

## TL;DR for X (Twitter)
A thread of 2-4 short posts (each max 280 chars). First post hooks the reader with the headline. Following posts cover the other key developments of the week. No hashtags. Informative, not hype. End the thread with a call to action — link to a relevant repo, PR, release, or doc page ONLY if the URL is in the data. You can also reference @XRPLF (foundation) and @RippleXDev (developer updates).

## Plain English Summary
2-3 paragraphs for non-developers. Conversational tone, no jargon. For each key change, explain:
1. What changed (translate technical terms)
2. What it concretely means for users, validators, or the network (e.g., "Batch disabled means users cannot bundle transactions until a future release re-enables it", "memory optimization means nodes use less RAM over time, reducing hosting costs")
3. Stay factual — only state implications that are directly derivable from the change itself, never speculate on timeline, intent, or future plans
End with links from the data only (release pages, blog posts, relevant PRs). You may also mention @XRPLF and @RippleXDev on X for ongoing updates.

---
*Summary AI-generated from GitHub activity data. All links sourced from GitHub and xrpl.org.*`;

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

export function buildPrompt(
  data: WeeklyData,
  xlsSpecs: XlsSpec[] = [],
  amendments: AmendmentStatus[] = [],
  blogPosts: BlogPost[] = []
): { userMessage: string; systemPrompt: string; fullDataLength: number } {
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

  const userMessage = `Here is the raw GitHub activity data for the XRPLF organization for the week of ${data.weekStart} to ${data.weekEnd}. Please produce the weekly summary.\n\n${fullData}`;

  return { userMessage, systemPrompt: SYSTEM_PROMPT, fullDataLength: fullData.length };
}

export async function summarize(
  apiKey: string,
  data: WeeklyData,
  xlsSpecs: XlsSpec[] = [],
  amendments: AmendmentStatus[] = [],
  blogPosts: BlogPost[] = []
): Promise<SummarizeResult> {
  const { userMessage, systemPrompt, fullDataLength } = buildPrompt(data, xlsSpecs, amendments, blogPosts);

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

  return { summary, input: userMessage, systemPrompt };
}
