import { config } from "dotenv";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  collectRepoActivity,
  fetchXlsSpecs,
  fetchAmendmentStatuses,
  fetchSecurityAdvisories,
  fetchBlogPosts,
} from "./collector.js";
import { summarizeDaily, buildDailyPrompt } from "./daily-summarizer.js";
import { validateReport, fetchMergedStatusFromGitHub, refKey, findMissingRepos } from "./validator.js";
import { graphql } from "@octokit/graphql";
import type { RepoActivity } from "./types.js";
import { REPOS, CONCURRENCY } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

config({ path: join(PROJECT_ROOT, ".env") });

function getDayRange(daysAgo = 0): { since: string; until: string; date: string } {
  const d = new Date();
  // Default: collect YESTERDAY's activity (the workflow runs after midnight UTC)
  d.setUTCDate(d.getUTCDate() - 1 - daysAgo);
  const date = d.toISOString().slice(0, 10);
  const start = new Date(`${date}T00:00:00.000Z`);
  const end = new Date(`${date}T23:59:59.999Z`);
  return { since: start.toISOString(), until: end.toISOString(), date };
}

async function main() {
  const githubToken = process.env.GITHUB_TOKEN;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!githubToken) {
    console.error("Missing GITHUB_TOKEN in .env");
    process.exit(1);
  }

  const daysAgoArg = process.argv.find((a) => a.startsWith("--days-ago="));
  const daysAgo = daysAgoArg ? parseInt(daysAgoArg.split("=")[1], 10) : 0;
  const noCache = process.argv.includes("--no-cache");
  const promptOnly = process.argv.includes("--prompt-only");

  const outputDir = join(PROJECT_ROOT, "output", "daily");
  const cacheDir = join(PROJECT_ROOT, ".cache", "daily");
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  const { since, until, date } = getDayRange(daysAgo);
  console.log(`Collecting daily activity for ${date}`);

  // Check cache
  const cachePath = join(cacheDir, `${date}.json`);
  let repos: RepoActivity[] | null = null;

  if (!noCache && existsSync(cachePath)) {
    const { readFileSync } = await import("fs");
    repos = JSON.parse(readFileSync(cachePath, "utf-8"));
    console.log(`Loaded from cache: ${cachePath}`);
  }

  if (!repos) {
    const gql = graphql.defaults({
      headers: { authorization: `token ${githubToken}` },
    });

    repos = [];
    const failed: string[] = [];
    for (let i = 0; i < REPOS.length; i += CONCURRENCY) {
      const batch = REPOS.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((r) => collectRepoActivity(gql, githubToken, r.owner, r.name, since, until, r))
      );
      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status === "fulfilled") {
          repos.push(result.value);
        } else {
          const { owner, name } = batch[j];
          console.error(`  Failed to collect ${owner}/${name}:`, (result.reason as any)?.message ?? result.reason);
          failed.push(`${owner}/${name}`);
        }
      }
    }

    // Fail closed: don't cache or publish an incomplete dataset.
    if (failed.length > 0) {
      throw new Error(
        `Collection failed for ${failed.length} repo(s): ${failed.join(", ")}. Refusing to produce an incomplete espresso — re-run to retry.`
      );
    }

    writeFileSync(cachePath, JSON.stringify(repos, null, 2), "utf-8");
  }

  // Fail closed on incomplete collection (also catches a stale partial cache):
  // a missing repo would silently appear as "0 merged / 0 activity".
  const missingRepos = findMissingRepos(REPOS.map((r) => r.name), repos.map((r) => r.repo));
  if (missingRepos.length > 0) {
    throw new Error(
      `INCOMPLETE COLLECTION — these repos are missing from the data: ${missingRepos.join(", ")}. Refusing to publish — re-run to retry.`
    );
  }

  // Check if there's any activity
  const totalActivity = repos.reduce(
    (sum, r) =>
      sum +
      r.mergedPRs.length +
      r.openedPRs.length +
      r.openedIssues.length +
      r.closedIssues.length +
      r.discussions.length +
      r.releases.length +
      r.activeBranches.length,
    0
  );

  if (totalActivity === 0) {
    console.log(`\nNo activity found for ${date}. Skipping espresso generation.`);
    // Write a "no activity" file so the site knows
    writeFileSync(
      join(outputDir, `${date}.md`),
      `# Daily Espresso ☕ — ${formatDate(date)}\n\nNo significant activity today. Check back tomorrow!\n\n<!-- generated: ${new Date().toISOString()} | model: none -->\n`,
      "utf-8"
    );
    return;
  }

  // Fetch context sources
  const xlsSpecs = await fetchXlsSpecs(githubToken);
  const amendments = await fetchAmendmentStatuses(githubToken);
  const advisories = await fetchSecurityAdvisories(githubToken);
  // Use a 7-day window for blog posts — a post may have been published a day
  // or two before and still be relevant context for today's activity
  const blogWindowStart = new Date(`${date}T00:00:00Z`);
  blogWindowStart.setUTCDate(blogWindowStart.getUTCDate() - 6);
  const blogPosts = await fetchBlogPosts(githubToken, blogWindowStart.toISOString().slice(0, 10), date);

  // Load recent espressos (up to 3 days back) for continuity context
  // This prevents re-mentioning items (e.g., blog posts, disclosures) already covered
  const previousEspressos: string[] = [];
  for (let daysBack = 1; daysBack <= 3; daysBack++) {
    const prev = new Date(`${date}T00:00:00Z`);
    prev.setUTCDate(prev.getUTCDate() - daysBack);
    const prevStr = prev.toISOString().slice(0, 10);
    const prevPath = join(outputDir, `${prevStr}.md`);
    if (existsSync(prevPath)) {
      previousEspressos.push(readFileSync(prevPath, "utf-8"));
      console.log(`Loaded previous espresso (${prevStr}.md) for context`);
    }
  }
  if (previousEspressos.length === 0) {
    console.log(`No previous espressos found — skipping day-over-day context`);
  }

  const base = date;
  const inputPath = join(outputDir, `${base}_input.md`);

  if (promptOnly) {
    const { userMessage, systemPrompt } = buildDailyPrompt(repos, date, xlsSpecs, amendments, previousEspressos, advisories, blogPosts);
    writeFileSync(inputPath, `# System Prompt\n\n${systemPrompt}\n\n---\n\n# User Message\n\n${userMessage}`, "utf-8");
    console.log(`\nPrompt saved to ${inputPath}`);
    return;
  }

  if (!anthropicKey) {
    console.error("Missing ANTHROPIC_API_KEY in .env (use --prompt-only to skip API call)");
    process.exit(1);
  }

  const result = await summarizeDaily(anthropicKey, repos, date, xlsSpecs, amendments, previousEspressos, advisories, blogPosts);

  const outputPath = join(outputDir, `${base}.md`);
  const metadata = `\n<!-- generated: ${result.generatedAt} | model: ${result.model} -->\n`;

  // Always save the prompt input for debugging, even if validation fails.
  writeFileSync(inputPath, `# System Prompt\n\n${result.systemPrompt}\n\n---\n\n# User Message\n\n${result.input}`, "utf-8");

  // Validate merged claims against the live GitHub API before publishing.
  console.log("\nValidating merge claims against the GitHub API...");
  const verifiedCounts = new Map<string, number>(
    repos.map((r) => [r.repo.toLowerCase(), r.mergedPRs.length])
  );
  const validation = await validateReport(
    result.summary,
    verifiedCounts,
    (refs) => fetchMergedStatusFromGitHub(githubToken, refs)
  );

  // Non-fatal: open PRs cross-referenced inside "What Merged".
  if (validation.crossReferences.length > 0) {
    console.warn("\n⚠ Open PRs cross-referenced inside \"What Merged\" (mentions, not merge claims):");
    for (const r of validation.crossReferences) {
      console.warn(`    - ${refKey(r)} (https://github.com/${r.owner}/${r.repo}/pull/${r.number})`);
    }
  }

  // Non-fatal: count drift is a warning; publish anyway.
  if (validation.countViolations.length > 0) {
    console.warn("\n⚠ Merged counts differ from verified data (publishing anyway):");
    for (const c of validation.countViolations) {
      console.warn(`    - ${c.repo}: claims ${c.claimed} merged, verified ${c.actual}`);
    }
  }

  // Fatal: an open PR presented as merged. Do not publish.
  if (!validation.ok) {
    const rejectedPath = join(outputDir, `${base}.rejected.md`);
    writeFileSync(rejectedPath, result.summary + metadata, "utf-8");
    console.error("\n❌ Espresso FAILED merge-status validation — NOT publishing.");
    for (const r of validation.unmergedClaims) {
      console.error(`    - ${refKey(r)} listed as merged but is NOT merged (https://github.com/${r.owner}/${r.repo}/pull/${r.number})`);
    }
    console.error(`  Rejected espresso saved to ${rejectedPath} for inspection.`);
    throw new Error(
      `Merge-status validation failed: ${validation.unmergedClaims.length} unmerged PR claim(s).`
    );
  }

  console.log("✓ Merge-status validation passed (no open PR claimed as merged).");
  writeFileSync(outputPath, result.summary + metadata, "utf-8");
  console.log(`\nEspresso written to ${outputPath}`);
}

function formatDate(dateStr: string): string {
  return new Date(dateStr + "T00:00:00Z").toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
