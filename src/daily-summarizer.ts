import Anthropic from "@anthropic-ai/sdk";
import type { RepoActivity } from "./types.js";
import type { XlsSpec, AmendmentStatus, SecurityAdvisory } from "./collector.js";
import { buildXlsContext, buildAmendmentContext, redactSecurityItems } from "./summarizer.js";

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
    }
  }

  if (repo.openedPRs.length > 0) {
    parts.push("\n### Opened PRs");
    for (const pr of repo.openedPRs) {
      const diff = `+${pr.diffStats.additions}/-${pr.diffStats.deletions} in ${pr.diffStats.changedFiles} files`;
      const reviewSummary = pr.reviewContent.length > 0
        ? ` Reviews: ${pr.reviewContent.map((r) => `${r.state} by @${r.author}`).join(", ")}`
        : "";
      parts.push(
        `- #${pr.number}: ${pr.title} (by @${pr.author}, ${pr.authorAssociation}) ${pr.url} [${diff}]${reviewSummary} ${pr.labels.length ? `[${pr.labels.join(", ")}]` : ""}`
      );
      if (pr.body) parts.push(`  ${pr.body}`);
    }
  }

  if (repo.openedIssues.length > 0) {
    parts.push("\n### New Issues");
    for (const issue of repo.openedIssues) {
      parts.push(
        `- #${issue.number}: ${issue.title} (by @${issue.author}, ${issue.authorAssociation}) ${issue.url} ${issue.labels.length ? `[${issue.labels.join(", ")}]` : ""}`
      );
      if (issue.body) parts.push(`  ${issue.body}`);
    }
  }

  if (repo.discussions.length > 0) {
    parts.push("\n### Discussions");
    for (const d of repo.discussions) {
      parts.push(
        `- #${d.number}: ${d.title} [${d.category}] (by @${d.author}, ${d.authorAssociation}, ${d.comments} comments) ${d.url}`
      );
      if (d.body) parts.push(`  ${d.body}`);
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

  const hasActivity =
    repo.mergedPRs.length +
      repo.openedPRs.length +
      repo.openedIssues.length +
      repo.closedIssues.length +
      repo.discussions.length +
      repo.releases.length +
      repo.activeBranches.length >
    0;

  return hasActivity ? parts.join("\n") : "";
}

const DAILY_SYSTEM_PROMPT = `You are a DevRel / technical writer for the XRP Ledger community. Transform raw GitHub activity data into a concise daily development digest.

Audience: XRPL validators, developers, and community members who want a quick daily catch-up.

# Rules

**URLs — CRITICAL:**
- ONLY use URLs that appear explicitly in the provided data. Every PR, issue, discussion, release has a URL in the data.
- NEVER construct, guess, or infer URLs. If you don't see a URL in the data, do not link to it.
- For PRs/issues, the URL is in the data line (e.g., "https://github.com/XRPLF/rippled/pull/1234"). Use it directly.
- The only external URLs you may use without them appearing in the data are: https://x.com/XRPLF and https://x.com/RippleXDev (official accounts).

**Content:**
- This is a quick daily espresso, not a deep weekly analysis. Be concise and scannable.
- Always name the repo in each item (e.g., "in rippled", "in xrpl-py", "on the developer portal").
- **Documentation is first-class.** Activity on documentation repos (xrpl-dev-portal, XRPL-Standards, opensource.ripple.com) must always be surfaced — these repos publish to xrpl.org. A new XLS spec, an amendment doc, or a dev portal update is as newsworthy as a code change. Always mention doc PRs (merged or opened) in the relevant sections.
- Merging to the develop branch does NOT mean the change is live on the network. Only tagged releases count as shipped. Say "merged to develop" or "merged to main" depending on the target branch. For rippled specifically, develop is the active development branch and main tracks releases.
- Do NOT overstate severity. Use the actual labels (Bug, Security, Critical) to gauge importance. NEVER use "Critical", "Urgent", "Emergency", or "Security" in headings unless the item has the corresponding label. A bug fix is a bug fix, not a "Critical Fix".
- Only facts from the data. No speculation, no assumptions, no filler.
- If it's a quiet day with only minor changes (refactors, typos, CI bumps), say so briefly. Do not inflate.
- Reference XLS spec numbers when mentioning amendments (e.g., "Batch (XLS-56)"). The XLS index is in the data.
- Unconfirmed bugs and unmerged PRs are not headline material. Preserve caveats and qualifiers from the original text. An unconfirmed bug is not a confirmed vulnerability.
- Do not repeat the same PR/issue across multiple sections.
- Use PR review states (APPROVED, CHANGES_REQUESTED) to contextualize readiness when relevant.
- Do not mention Ripple or XRP unless directly relevant. No marketing or price talk.
- Use labels to flag important items: "bug", "breaking change", "API Change" labels deserve mention.

**Responsible Disclosure — CRITICAL:**
- Security-related items (PRs/issues with labels containing "security" or "vulnerability", or titles/bodies mentioning CVEs, exploits, or vulnerabilities) require extreme caution.
- If a security fix has been MERGED but there is NO corresponding tagged release in the data, do NOT highlight it. Mention it only as a routine merge with minimal detail (e.g., "a fix was merged to develop in rippled"). Do not describe the vulnerability, attack vector, or affected component.
- If a security fix has a tagged release AND an official advisory or blog post in the data, you may describe it — but only using the language from the official advisory. Do not add interpretation or severity beyond what the advisory states.
- Never put unpatched or unreleased security items in TL;DR or headings.
- When in doubt, understate. A missed highlight is harmless; amplifying an unpatched vulnerability is dangerous.

- If a "Previous Day's Espresso" is provided, use it for continuity: note items that were "Opened" yesterday and merged today, and flag any amendment status changes compared to yesterday's context. Do not repeat yesterday's content — only reference it when there is a meaningful update.

**Contributors:**
- Only flag someone as a new contributor if their authorAssociation is exactly FIRST_TIME_CONTRIBUTOR. Never guess.
- Never expose raw authorAssociation values (NONE, MEMBER, CONTRIBUTOR, etc.) in the output. Use natural language: "community member", "external contributor", "core team".

**Formatting:**
- Link PRs/issues as markdown links: [rippled#1234](url) — use the exact URL from the data
- Use diff stats (+additions/-deletions) when they help convey significance
- "Quick Stats" must use exact integers — never use "~", "about", or "approximately"
- Target length: ~200-400 words. Shorter if quiet, slightly longer if eventful.

# Output format

# Daily Espresso ☕ — {date}

## TL;DR
2-3 sentences covering today's highlights across all repos. Name the repos. Only mention merged PRs and releases. If nothing significant merged, say so.

End the TL;DR with a separate line: "Follow [@XRPLF](https://x.com/XRPLF) and [@RippleXDev](https://x.com/RippleXDev) for latest XRPL news."

## What Merged
Concise list. Each item: repo, what changed, link. No thematic grouping needed (too few items for a daily). If nothing merged, omit this section.

## Opened
Notable new PRs, issues, or discussions opened today. Include repo name and link. Skip trivial items (typo fixes, minor CI bumps). If nothing notable, omit this section.

## Discussions
New or active discussions. Include repo, topic, and link. If none, omit this section.

## Quick Stats
One-liner: X PRs merged, Y opened, Z issues across N repos.

---
*Daily digest AI-generated from GitHub activity data. This digest covers PRs, issues, and discussions captured via the GitHub API — activity on development and test branches without associated PRs may not be reflected. Check the [XRPLF repos](https://github.com/XRPLF) directly for full activity.*`;


export function buildDailyPrompt(
  repos: RepoActivity[],
  date: string,
  xlsSpecs: XlsSpec[] = [],
  amendments: AmendmentStatus[] = [],
  previousEspresso?: string,
  advisories: SecurityAdvisory[] = []
): { userMessage: string; systemPrompt: string } {
  // Redact security-sensitive content before building prompt
  const safeRepos = redactSecurityItems(repos, { advisories });

  const repoSections = safeRepos
    .map(buildRepoSection)
    .filter(Boolean);

  const xlsContext = buildXlsContext(xlsSpecs);
  const amendmentContext = buildAmendmentContext(amendments);

  const prevSection = previousEspresso
    ? `## Previous Day's Espresso (for context)\n\n${previousEspresso}`
    : "";

  const fullData = repoSections.join("\n\n---\n\n") +
    (prevSection ? `\n\n---\n\n${prevSection}` : "") +
    (xlsContext ? `\n\n---\n\n${xlsContext}` : "") +
    (amendmentContext ? `\n\n---\n\n${amendmentContext}` : "");

  const userMessage = `Here is the raw GitHub activity data for the XRPLF organization for ${date}. Please produce the daily espresso digest.\n\n${fullData}`;

  return { userMessage, systemPrompt: DAILY_SYSTEM_PROMPT };
}

export interface DailySummarizeResult {
  summary: string;
  input: string;
  systemPrompt: string;
  model: string;
  generatedAt: string;
}

export async function summarizeDaily(
  apiKey: string,
  repos: RepoActivity[],
  date: string,
  xlsSpecs: XlsSpec[] = [],
  amendments: AmendmentStatus[] = [],
  previousEspresso?: string,
  advisories: SecurityAdvisory[] = []
): Promise<DailySummarizeResult> {
  const { userMessage, systemPrompt } = buildDailyPrompt(repos, date, xlsSpecs, amendments, previousEspresso, advisories);

  console.log(`\nSending to Claude for daily espresso (${userMessage.length} chars)...`);

  const client = new Anthropic({ apiKey });
  const model = process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6";
  console.log(`  Using model: ${model}`);

  const message = await client.messages.create({
    model,
    max_tokens: 4000,
    messages: [{ role: "user", content: userMessage }],
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
  });

  const usage = message.usage as any;
  const cacheInfo = usage.cache_read_input_tokens
    ? ` (${usage.cache_read_input_tokens} cached)`
    : "";
  console.log(`  Tokens: ${usage.input_tokens} in / ${usage.output_tokens} out${cacheInfo}`);

  const summary = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  return { summary, input: userMessage, systemPrompt, model, generatedAt: new Date().toISOString() };
}
