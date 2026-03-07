# XRPLF Weekly Activity Summary

Collects GitHub activity across the [XRPLF](https://github.com/XRPLF) organization and generates a weekly markdown summary using Claude.

## Repos Tracked

rippled, xrpl.js, xrpl-py, xrpl-dev-portal, clio, XRPL-Standards, xrpl4j

## Data Sources

**GitHub activity (per repo):**
- Merged and open PRs (with diff stats, reviews, first + last comments, linked issues, author association)
- New and closed issues (with comments)
- Discussions
- Releases
- Commit activity on default branch
- Active branches without a PR

**Context sources (always fetched fresh):**
- Amendment lifecycle status from two sources:
  - rippled's `features.macro` (supported/unsupported, vote behavior)
  - xrpl.org's `known-amendments.md` (Enabled, Open for Voting, In Development, Obsolete)
- XLS spec index from XRPL-Standards
- Blog posts from `xrpl.org/blog` published during the week (release announcements, vulnerability disclosures, etc.)

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
# Current week
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
```

### Output

Each run produces two files in `output/`:

```
output/
  2026-02-21_2026-02-28.md          # Summary (markdown)
  2026-02-21_2026-02-28_input.md    # Full prompt sent to Claude (system + user message)
```

The input file lets you compare exactly what Claude received vs what it produced.

## Caching

All cache files live in `.cache/`:

```
.cache/
  2026-02-21_2026-02-28.json   # Weekly activity data (PRs, issues, discussions, etc.)
  amendments.json               # Last fetched amendment statuses (debug only)
  xls-specs.json                # Last fetched XLS specs (debug only)
```

- **Weekly activity data** is cached by date range. Safe to reuse since past activity is immutable. Use `--no-cache` to force a re-fetch.
- **XLS specs, amendment statuses, and blog posts** are always fetched fresh — they can change between runs.
- **Previous week data** is loaded from cache automatically for week-over-week comparison.

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

Edit the `REPOS` array in `src/collector.ts`:

```typescript
const REPOS = [
  "rippled",
  "xrpl.js",
  "xrpl-py",
  // Add or remove repo names here (all under the XRPLF org)
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
- **Concurrency** — Set to 2 parallel repo fetches to avoid 502 errors from GitHub. Configurable via the `CONCURRENCY` constant in `collector.ts`.
- **Anthropic output limit** — `max_tokens` is set to 10000. Summaries for unusually active weeks may be truncated (a warning is logged if this happens).
- **Anthropic context window** — Very large weeks with many PRs/issues could approach the model's input limit. The prompt is optimized to minimize token usage (compact amendment context, truncated blog bodies).

## Disclaimer

Summaries are AI-generated. LLMs can hallucinate, misrepresent severity, or amplify facts beyond what the source data supports. Always verify claims against the linked PRs, issues, and official sources before acting on them.

## License

[CC BY-NC 4.0](LICENSE) — Free to use and modify for non-commercial purposes with attribution.

## Project Structure

```
src/
  types.ts       — Data interfaces (PR, Issue, Discussion, etc.)
  collector.ts   — GitHub API data collection (GraphQL + REST), amendment/XLS/blog fetching
  summarizer.ts  — Formats data for Claude, manages prompt and API call
  main.ts        — CLI entry point, caching orchestration
```
