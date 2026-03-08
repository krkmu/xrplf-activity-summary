import { config } from "dotenv";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  collectWeeklyData,
  loadCachedData,
  saveCachedData,
  fetchXlsSpecs,
  saveCachedSpecs,
  fetchAmendmentStatuses,
  saveCachedAmendments,
  fetchBlogPosts,
} from "./collector.js";
import { summarize, buildPrompt } from "./summarizer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

config({ path: join(PROJECT_ROOT, ".env") });

function getWeekDates(weeksAgo: number): { start: string; end: string } {
  const now = new Date();
  // Find the most recent Monday (or today if Monday)
  const day = now.getUTCDay(); // 0=Sun, 1=Mon, ...
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(now);
  monday.setUTCDate(monday.getUTCDate() - daysSinceMonday - 7 * weeksAgo);
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  return {
    start: monday.toISOString().slice(0, 10),
    end: sunday.toISOString().slice(0, 10),
  };
}

async function main() {
  const githubToken = process.env.GITHUB_TOKEN;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!githubToken) {
    console.error("Missing GITHUB_TOKEN in .env");
    process.exit(1);
  }
  // Parse flags
  const weeksAgoArg = process.argv.find((a) => a.startsWith("--weeks-ago="));
  const weeksAgo = weeksAgoArg ? parseInt(weeksAgoArg.split("=")[1], 10) : 0;
  const noCache = process.argv.includes("--no-cache");
  const promptOnly = process.argv.includes("--prompt-only");

  const cacheDir = join(PROJECT_ROOT, ".cache");
  const outputDir = join(PROJECT_ROOT, "output");
  mkdirSync(outputDir, { recursive: true });

  // Always fetch fresh specs and amendments — they evolve week to week
  // and stale data would mislead the summary (e.g., amendment status changes)
  const xlsSpecs = await fetchXlsSpecs(githubToken);
  saveCachedSpecs(cacheDir, xlsSpecs);

  const amendments = await fetchAmendmentStatuses(githubToken);
  saveCachedAmendments(cacheDir, amendments);

  // Try loading from cache first
  const { start: weekStart, end: weekEnd } = getWeekDates(weeksAgo);

  // Fetch blog posts for the week
  const blogPosts = await fetchBlogPosts(githubToken, weekStart, weekEnd);
  let data = noCache ? null : loadCachedData(cacheDir, weekStart, weekEnd);

  if (!data) {
    data = await collectWeeklyData(githubToken, weeksAgo);
    saveCachedData(cacheDir, data);
  }

  // Load previous week's report for week-over-week comparison
  const { start: prevStart, end: prevEnd } = getWeekDates(weeksAgo + 1);
  const prevReportPath = join(outputDir, `${prevStart}_${prevEnd}.md`);
  if (existsSync(prevReportPath)) {
    data.previousReport = readFileSync(prevReportPath, "utf-8");
    console.log(`Loaded previous week report (${prevStart}_${prevEnd}.md) for comparison`);
  } else {
    console.log(`No previous week report found (${prevReportPath}) — skipping week-over-week comparison`);
  }

  // Check if there's any activity
  const totalActivity = data.repos.reduce(
    (sum, r) =>
      sum +
      r.mergedPRs.length +
      r.openedPRs.length +
      r.openedIssues.length +
      r.closedIssues.length +
      r.discussions.length +
      r.releases.length +
      r.commits.totalCount,
    0
  );

  if (totalActivity === 0) {
    console.log("\nNo activity found for this period. Skipping summary generation.");
    return;
  }

  const base = `${data.weekStart}_${data.weekEnd}`;
  const inputPath = join(outputDir, `${base}_input.md`);

  if (promptOnly) {
    // Build prompt without calling Claude API
    const { userMessage, systemPrompt } = buildPrompt(data, xlsSpecs, amendments, blogPosts);
    writeFileSync(inputPath, `# System Prompt\n\n${systemPrompt}\n\n---\n\n# User Message\n\n${userMessage}`, "utf-8");
    console.log(`\nPrompt saved to ${inputPath}`);
    console.log("Use this file with Claude Code or paste into a conversation.");
    return;
  }

  if (!anthropicKey) {
    console.error("Missing ANTHROPIC_API_KEY in .env (use --prompt-only to skip API call)");
    process.exit(1);
  }

  // Summarize with Claude API
  const result = await summarize(anthropicKey, data, xlsSpecs, amendments, blogPosts);

  const outputPath = join(outputDir, `${base}.md`);
  const metadata = `\n<!-- generated: ${result.generatedAt} | model: ${result.model} -->\n`;
  writeFileSync(outputPath, result.summary + metadata, "utf-8");
  writeFileSync(inputPath, `# System Prompt\n\n${result.systemPrompt}\n\n---\n\n# User Message\n\n${result.input}`, "utf-8");
  console.log(`\nSummary written to ${outputPath}`);
  console.log(`Input saved to ${inputPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
