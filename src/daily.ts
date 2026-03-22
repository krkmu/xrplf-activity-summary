import { config } from "dotenv";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  collectRepoActivity,
  fetchXlsSpecs,
  fetchAmendmentStatuses,
  fetchSecurityAdvisories,
} from "./collector.js";
import { summarizeDaily, buildDailyPrompt } from "./daily-summarizer.js";
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
    for (let i = 0; i < REPOS.length; i += CONCURRENCY) {
      const batch = REPOS.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((r) => collectRepoActivity(gql, githubToken, r.owner, r.name, since, until))
      );
      for (const result of results) {
        if (result.status === "fulfilled") {
          repos.push(result.value);
        } else {
          console.error(`  Failed to collect repo:`, result.reason);
        }
      }
    }

    writeFileSync(cachePath, JSON.stringify(repos, null, 2), "utf-8");
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

  // Fetch context (lighter than weekly — skip blogs, just specs, amendments, and advisories)
  const xlsSpecs = await fetchXlsSpecs(githubToken);
  const amendments = await fetchAmendmentStatuses(githubToken);
  const advisories = await fetchSecurityAdvisories(githubToken);

  // Load previous day's espresso for continuity
  const prevDate = new Date(`${date}T00:00:00Z`);
  prevDate.setUTCDate(prevDate.getUTCDate() - 1);
  const prevDateStr = prevDate.toISOString().slice(0, 10);
  const prevPath = join(outputDir, `${prevDateStr}.md`);
  let previousEspresso: string | undefined;
  if (existsSync(prevPath)) {
    previousEspresso = readFileSync(prevPath, "utf-8");
    console.log(`Loaded previous espresso (${prevDateStr}.md) for context`);
  } else {
    console.log(`No previous espresso found (${prevPath}) — skipping day-over-day context`);
  }

  const base = date;
  const inputPath = join(outputDir, `${base}_input.md`);

  if (promptOnly) {
    const { userMessage, systemPrompt } = buildDailyPrompt(repos, date, xlsSpecs, amendments, previousEspresso, advisories);
    writeFileSync(inputPath, `# System Prompt\n\n${systemPrompt}\n\n---\n\n# User Message\n\n${userMessage}`, "utf-8");
    console.log(`\nPrompt saved to ${inputPath}`);
    return;
  }

  if (!anthropicKey) {
    console.error("Missing ANTHROPIC_API_KEY in .env (use --prompt-only to skip API call)");
    process.exit(1);
  }

  const result = await summarizeDaily(anthropicKey, repos, date, xlsSpecs, amendments, previousEspresso, advisories);

  const outputPath = join(outputDir, `${base}.md`);
  const metadata = `\n<!-- generated: ${result.generatedAt} | model: ${result.model} -->\n`;
  writeFileSync(outputPath, result.summary + metadata, "utf-8");
  writeFileSync(inputPath, `# System Prompt\n\n${result.systemPrompt}\n\n---\n\n# User Message\n\n${result.input}`, "utf-8");
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
