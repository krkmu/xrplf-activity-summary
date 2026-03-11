# XRPLF Weekly Activity Summary

Collects GitHub activity across the [XRPLF](https://github.com/XRPLF) organization and generates a weekly markdown summary using Claude.

Published as [XRPL Monday Brew ☕](https://xrplbrew.com) — weekly brews on Mondays, daily espressos Tuesday through Friday.

## Repos Tracked

rippled, xrpl.js, xrpl-py, xrpl-dev-portal, clio, XRPL-Standards, xrpl4j (all under XRPLF), and [opensource.ripple.com](https://github.com/ripple/opensource.ripple.com) (under ripple — upcoming amendment docs)

## Data Sources

**GitHub activity (per repo):**
- Merged and open PRs targeting any branch (with diff stats, reviews, first + last comments, linked issues, author association)
- New and closed issues (with comments)
- Discussions
- Releases
- Commit activity on the default branch only (e.g., `develop` for rippled, `main` for most others)
- Active branches without an associated PR (detected via REST API comparison against the default branch)

> **Scope note:** PRs are collected regardless of their target branch (develop, main, release, feature branches). Commit counts only reflect the default branch. Branch activity without PRs is surfaced separately. This means work happening on long-lived feature branches without PRs may not appear in the report — the daily espresso disclaimer mentions this explicitly.

**Context sources (always fetched fresh):**
- Amendment lifecycle status from two sources:
  - rippled's `features.macro` (supported/unsupported, vote behavior)
  - xrpl.org's `known-amendments.md` (Enabled, Open for Voting, In Development, Obsolete)
- XLS spec index from XRPL-Standards
- Blog posts from `xrpl.org/blog` published during the week (release announcements, vulnerability disclosures, etc.)
- Previous week's report (from `output/`) for week-over-week comparison

## Setup

```bash
npm install
```

Create a `.env` file:

```
GITHUB_TOKEN=ghp_...
ANTHROPIC_API_KEY=sk-ant-...
```

The GitHub token needs read access to public repos. The Anthropic key is used for Claude summarization.

### Optional env vars

| Variable | Default | Description |
|---|---|---|
| `CLAUDE_MODEL` | `claude-sonnet-4-6` | Model for summarization. Set to `claude-opus-4-6` for higher quality at ~5x the cost. |

## Usage

```bash
# Current week (Monday to Sunday)
npm run dev

# Specific past week
npm run dev -- --weeks-ago=1

# Force re-fetch all activity data
npm run dev -- --no-cache

# Combine flags
npm run dev -- --no-cache --weeks-ago=1

# Generate prompt only (no Claude API call)
npm run dev -- --prompt-only

# Use Opus for a single run
CLAUDE_MODEL=claude-opus-4-6 npm run dev

# --- Daily Espresso ---

# Yesterday's espresso (default — collects the previous day's activity)
npm run daily

# Two days ago
npm run daily -- --days-ago=1

# Force re-fetch
npm run daily -- --no-cache

# Prompt only (no Claude API call)
npm run daily -- --prompt-only

# --- Site ---

# Build HTML pages from all reports (weekly + daily)
node scripts/build-pages.js
# Open locally
open site/index.html
```

### Output

Each weekly run produces two files in `output/`:

```
output/
  2026-03-02_2026-03-08.md          # Weekly summary (markdown, Monday–Sunday)
  2026-03-02_2026-03-08_input.md    # Full prompt sent to Claude (system + user message)
```

Each daily run produces files in `output/daily/`, named after the day being covered (yesterday by default):

```
output/daily/
  2026-03-10.md                     # Daily espresso covering March 10 activity
  2026-03-10_input.md               # Full prompt sent to Claude
```

Daily espressos are automatically cleaned up when the weekly report is generated.

The input files let you compare exactly what Claude received vs what it produced.

The `build-pages` script generates styled HTML pages in `site/` from all reports (weekly + daily). The Twitter/X thread section is excluded from the HTML output.

### GitHub Pages (automated)

Three GitHub Actions workflows handle deployment:

- **`weekly-report.yml`** — Runs every Sunday at midnight UTC (and manually via workflow_dispatch). Generates the weekly report, cleans previous daily espressos, commits to the repo, builds HTML pages, and deploys to GitHub Pages.
- **`daily-espresso.yml`** — Runs Tuesday through Friday at 1:00 UTC (and manually via workflow_dispatch). Generates the espresso for the **previous day's** activity (e.g., runs Wednesday 1:00 UTC → covers Tuesday), commits, and deploys.
- **`deploy-pages.yml`** — Triggers automatically on push to `main` when `output/*.md`, `scripts/build-pages.js`, or `static/` change. Rebuilds and redeploys HTML pages without regenerating reports.

**Setup:**
1. Add repo secrets: `GH_PAT` (GitHub Personal Access Token) and `ANTHROPIC_API_KEY`
2. Enable GitHub Pages: Settings → Pages → Source → "GitHub Actions"
3. (Optional) Configure custom domain in Settings → Pages → Custom domain

## Caching

All cache files live in `.cache/`:

```
.cache/
  2026-03-02_2026-03-08.json   # Weekly activity data (PRs, issues, discussions, etc.)
  daily/2026-03-10.json        # Daily activity data
  amendments.json               # Last fetched amendment statuses (debug only)
  xls-specs.json                # Last fetched XLS specs (debug only)
```

- **Weekly activity data** is cached by date range (Monday–Sunday). Safe to reuse since past activity is immutable. Use `--no-cache` to force a re-fetch.
- **XLS specs, amendment statuses, and blog posts** are always fetched fresh — they can change between runs.
- **Previous week's report** is loaded from `output/` (the committed `.md` file) for week-over-week comparison. No extra API calls needed.

## Cost Optimization

- **Sonnet by default** — Claude Sonnet is used instead of Opus (~5x cheaper). Override with `CLAUDE_MODEL` when needed.
- **Prompt caching** — The system prompt is cached via the Anthropic API, reducing cost by ~90% on the system prompt tokens when running multiple times within 5 minutes.
- **Minimal amendment context** — Only "Open for Voting" and "In Development" amendments are sent individually. Enabled and obsolete are summarized as counts.

## Build

```bash
npm run build   # compile to dist/
npm start       # run compiled version
```

## Configuration

### Tracked repos

Edit the `REPOS` array in `src/config.ts` (shared by both weekly and daily):

```typescript
const REPOS = [
  "rippled",
  "xrpl.js",
  "xrpl-py",
  // Add or remove repo names here (all under the XRPLF org)
  "ripple/opensource.ripple.com", // cross-org: "owner/repo" format
];
```

Discussions are fetched for all repos automatically. If a repo doesn't have Discussions enabled, the query silently skips it.

### Collection limits

These values are in `src/collector.ts` and control how much data is fetched per repo per query page:

| Item | Limit | Notes |
|---|---|---|
| Merged PRs | 30 per page | Paginated until all in-range PRs are collected |
| Open PRs | 30 per page | Same pagination |
| Issues (opened/closed) | 30 per page | Same pagination |
| Discussions | 30 per page | Same pagination |
| Releases | 10 | Single page, most recent only |
| Branches (without PR) | 100 | All non-default, non-PR branches checked via REST API |
| PR/issue comments | first: 3 + last: 7 | First 3 for context, last 7 for recency, deduplicated |
| PR reviews | last: 5 | Most recent reviews only |

To adjust, search for the relevant `first:` or `last:` values in the GraphQL queries in `collector.ts`.

## Limitations

- **GitHub GraphQL node budget** — GitHub limits each GraphQL query to ~500,000 nodes. Queries that request too many nested objects (e.g., 50 PRs × 15 comments × 10 reviews) will fail with "Resource limits for this query exceeded". The current page sizes are tuned to stay within this budget. If you add repos with very high activity, you may need to reduce page sizes.
- **GitHub REST rate limit** — 5,000 requests/hour for authenticated tokens. Branch comparison uses the REST API (one call per active branch per repo).
- **Concurrency** — Set to 2 parallel repo fetches to avoid 502 errors from GitHub. Configurable via `CONCURRENCY` in `src/config.ts`.
- **Anthropic output limit** — `max_tokens` is set to 10000. Summaries for unusually active weeks may be truncated (a warning is logged if this happens).
- **Anthropic context window** — Very large weeks with many PRs/issues could approach the model's input limit. The prompt is optimized to minimize token usage (compact amendment context, truncated blog bodies).

## How the Reports are Structured

### Weekly Brew

Each weekly report follows a fixed structure enforced by the prompt:

| Section | What it covers |
|---|---|
| **TL;DR** | 1-2 sentences on the week's most significant merged PRs and releases only |
| **What Merged** | PRs merged during the week, grouped by theme (protocol, SDKs, infra, docs…) |
| **In Progress** | Notable open PRs and active branches, with review status |
| **What to Watch Next Week** | Items likely to land or needing attention soon |
| **Community & Discussions** | Bug reports, feature requests, governance topics |
| **By the Numbers** | Exact counts (PRs, commits, releases) with week-over-week comparison |
| **TL;DR for X** | 2-4 short posts (≤280 chars each) for Twitter/X |
| **Plain English Summary** | 2-3 paragraphs for non-developers, jargon-free |

### Key editorial rules

- **Merged ≠ shipped.** Merging to `develop` does not mean the change is live on the network. Only tagged releases (e.g., rippled 2.4.0) count as "shipped". The prompt enforces this distinction explicitly.
- **No severity inflation.** Words like "Critical", "Urgent", or "Security" are only used in headings when the PR/issue carries the corresponding label.
- **No hallucinated URLs.** Claude may only use URLs present in the source data. No constructed or guessed links.
- **One section per item.** Each PR/issue appears in exactly one section (merged, in progress, or what to watch) to avoid repetition.

### Daily Espresso

A lighter, faster digest published Tuesday through Friday:

| Section | What it covers |
|---|---|
| **TL;DR** | 2-3 sentences on the day's highlights, with follow links to @XRPLF and @RippleXDev |
| **What Merged** | Concise list of PRs merged that day |
| **Opened** | Notable new PRs, issues opened |
| **Discussions** | New or active discussions |
| **Quick Stats** | One-liner with exact counts |

Daily espressos share the same editorial rules as the weekly (no hallucinated URLs, no severity inflation, merged ≠ shipped). They are automatically cleaned up when the next weekly brew is published.

## Disclaimer

Summaries are AI-generated. LLMs can hallucinate, misrepresent severity, or amplify facts beyond what the source data supports. Always verify claims against the linked PRs, issues, and official sources before acting on them.

## License

[CC BY-NC 4.0](LICENSE) — Free to use and modify for non-commercial purposes with attribution.

## Project Structure

```
src/
  config.ts             — Shared configuration (tracked repos, org, concurrency)
  types.ts              — Data interfaces (PR, Issue, Discussion, etc.)
  collector.ts          — GitHub API data collection (GraphQL + REST), amendment/XLS/blog fetching
  summarizer.ts         — Weekly prompt and Claude API call
  daily-summarizer.ts   — Daily espresso prompt and Claude API call
  main.ts               — Weekly CLI entry point
  daily.ts              — Daily CLI entry point
scripts/
  build-pages.js        — Generates styled HTML pages from weekly + daily reports
static/
  og-image.png          — Open Graph image for social media previews
```
