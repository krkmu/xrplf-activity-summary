import { graphql } from "@octokit/graphql";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type {
  ActiveBranch,
  Comment,
  RepoActivity,
  PullRequest,
  Issue,
  Discussion,
  Release,
  ReviewComment,
  CommitSummary,
  WeeklyData,
} from "./types.js";
import { DEFAULT_ORG, REPOS, CONCURRENCY, type RepoConfig } from "./config.js";
import { isMerged } from "./merge-status.js";

function getWeekRange(weeksAgo = 0): { since: string; until: string } {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon, ...
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(now);
  monday.setUTCDate(monday.getUTCDate() - daysSinceMonday - 7 * weeksAgo);
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  // Set to start/end of day for GitHub API filtering
  monday.setUTCHours(0, 0, 0, 0);
  sunday.setUTCHours(23, 59, 59, 999);
  return {
    since: monday.toISOString(),
    until: sunday.toISOString(),
  };
}

// PR fields shared between merged and open queries
const PR_FIELDS = `
  title
  number
  url
  isDraft
  headRefName
  baseRefName
  author { login }
  authorAssociation
  mergedAt
  createdAt
  updatedAt
  state
  labels(first: 10) { nodes { name } }
  body
  additions
  deletions
  changedFiles
  closingIssuesReferences(first: 5) {
    nodes {
      number
      title
      url
    }
  }
  reviewDecision
  reviews(last: 5) {
    totalCount
    nodes {
      author { login }
      body
      state
      createdAt
    }
  }
  firstComments: comments(first: 3) {
    totalCount
    nodes {
      author { login }
      body
      createdAt
    }
  }
  lastComments: comments(last: 7) {
    nodes {
      author { login }
      body
      createdAt
    }
  }
`;

const ISSUE_FIELDS = `
  title
  number
  url
  author { login }
  authorAssociation
  createdAt
  closedAt
  state
  labels(first: 10) { nodes { name } }
  firstComments: comments(first: 3) {
    totalCount
    nodes {
      author { login }
      body
      createdAt
    }
  }
  lastComments: comments(last: 7) {
    nodes {
      author { login }
      body
      createdAt
    }
  }
  body
`;

function buildRepoQuery(issueCursor: string | null): string {
  const issueAfter = issueCursor ? `, after: "${issueCursor}"` : "";

  return `
query($org: String!, $repo: String!, $since: GitTimestamp!, $until: GitTimestamp!) {
  repository(owner: $org, name: $repo) {
    openedPRs: pullRequests(
      first: 30
      states: OPEN
      orderBy: { field: CREATED_AT, direction: DESC }
    ) {
      nodes { ${PR_FIELDS} }
    }

    updatedPRs: pullRequests(
      first: 30
      states: OPEN
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      nodes { ${PR_FIELDS} }
    }

    openIssues: issues(
      first: 30
      states: OPEN
      orderBy: { field: CREATED_AT, direction: DESC }
      ${issueAfter}
    ) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ISSUE_FIELDS} }
    }

    closedIssues: issues(
      first: 30
      states: CLOSED
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      nodes { ${ISSUE_FIELDS} }
    }

    releases(first: 10, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes {
        tagName
        name
        url
        publishedAt
        description
      }
    }

    defaultBranchRef {
      target {
        ... on Commit {
          history(since: $since, until: $until) {
            totalCount
            nodes {
              author { user { login } }
            }
          }
        }
      }
    }
  }
}
`;
}

/**
 * Search query string for PRs merged within the week window, by MERGE DATE.
 *
 * The repository `pullRequests` connection can only be ordered by CREATED_AT or
 * UPDATED_AT, never by merge date. Paginating it to find a past week's merges
 * meant walking deep into a large repo's UPDATED_AT-ordered history — many heavy
 * page queries that triggered GraphQL 502 "Resource limits" on rippled and could
 * drop the repo entirely. The Search API returns exactly the window's merged PRs
 * directly, with no deep pagination, and is correct for any week.
 */
export function buildMergedSearchQ(owner: string, repo: string, since: string, until: string): string {
  return `repo:${owner}/${repo} is:pr is:merged merged:${since.slice(0, 10)}..${until.slice(0, 10)}`;
}

const MERGED_SEARCH_QUERY = `
query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { ${PR_FIELDS} } }
  }
}
`;

const DISCUSSIONS_QUERY = `
query($org: String!, $repo: String!) {
  repository(owner: $org, name: $repo) {
    discussions(
      first: 30
      orderBy: { field: CREATED_AT, direction: DESC }
    ) {
      nodes {
        title
        number
        url
        author { login }
        authorAssociation
        createdAt
        category { name }
        firstComments: comments(first: 3) {
          totalCount
          nodes {
            author { login }
            body
            createdAt
          }
        }
        lastComments: comments(last: 7) {
          nodes {
            author { login }
            body
            createdAt
          }
        }
        body
      }
    }
  }
}
`;

function filterByDateRange<T>(
  items: T[],
  since: string,
  until: string,
  dateField: string = "createdAt"
): T[] {
  return items.filter((item) => {
    const date = (item as any)[dateField];
    if (!date) return false;
    return date >= since && date <= until;
  });
}

function mapCommentNodes(nodes: any[]): Comment[] {
  return (nodes ?? []).map((c: any) => ({
    author: c.author?.login ?? "unknown",
    body: (c.body ?? "").slice(0, 300),
    createdAt: c.createdAt,
  }));
}

// Merge first (context) + last (recent) comments, deduplicate by createdAt+author
function mergeComments(firstNodes: any[], lastNodes: any[]): Comment[] {
  const first = mapCommentNodes(firstNodes);
  const last = mapCommentNodes(lastNodes);
  const seen = new Set(first.map((c) => `${c.createdAt}|${c.author}`));
  const merged = [...first];
  for (const c of last) {
    if (!seen.has(`${c.createdAt}|${c.author}`)) {
      merged.push(c);
    }
  }
  return merged;
}

function mapReviews(nodes: any[]): ReviewComment[] {
  return (nodes ?? [])
    .filter((r: any) => r.body?.trim())
    .map((r: any) => ({
      author: r.author?.login ?? "unknown",
      body: (r.body ?? "").slice(0, 300),
      state: r.state,
      createdAt: r.createdAt,
    }));
}

export function mapPR(node: any): PullRequest {
  const mergedAt = node.mergedAt ?? null;
  return {
    title: node.title,
    number: node.number,
    url: node.url,
    isDraft: node.isDraft ?? false,
    baseRefName: node.baseRefName ?? "",
    author: node.author?.login ?? "unknown",
    authorAssociation: node.authorAssociation ?? "NONE",
    mergedAt,
    merged: isMerged({ mergedAt }),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt ?? node.createdAt,
    state: node.state,
    labels: node.labels?.nodes?.map((l: any) => l.name) ?? [],
    body: (node.body ?? "").slice(0, 500),
    reviewComments: node.firstComments?.totalCount ?? 0,
    reviews: node.reviews?.totalCount ?? 0,
    reviewContent: mapReviews(node.reviews?.nodes),
    commentContent: mergeComments(node.firstComments?.nodes, node.lastComments?.nodes),
    diffStats: {
      additions: node.additions ?? 0,
      deletions: node.deletions ?? 0,
      changedFiles: node.changedFiles ?? 0,
    },
    linkedIssues: (node.closingIssuesReferences?.nodes ?? []).map((i: any) => ({
      number: i.number,
      title: i.title,
      url: i.url,
    })),
  };
}

function mapIssue(node: any): Issue {
  return {
    title: node.title,
    number: node.number,
    url: node.url,
    author: node.author?.login ?? "unknown",
    authorAssociation: node.authorAssociation ?? "NONE",
    createdAt: node.createdAt,
    closedAt: node.closedAt ?? null,
    state: node.state,
    labels: node.labels?.nodes?.map((l: any) => l.name) ?? [],
    comments: node.firstComments?.totalCount ?? 0,
    body: (node.body ?? "").slice(0, 500),
    commentContent: mergeComments(node.firstComments?.nodes, node.lastComments?.nodes),
  };
}

function mapDiscussion(node: any): Discussion {
  return {
    title: node.title,
    number: node.number,
    url: node.url,
    author: node.author?.login ?? "unknown",
    authorAssociation: node.authorAssociation ?? "NONE",
    createdAt: node.createdAt,
    category: node.category?.name ?? "General",
    comments: node.firstComments?.totalCount ?? 0,
    body: (node.body ?? "").slice(0, 500),
    commentContent: mergeComments(node.firstComments?.nodes, node.lastComments?.nodes),
  };
}

async function fetchActiveBranches(
  token: string,
  owner: string,
  repo: string,
  since: string,
  until: string,
  openPRBranchNames: Set<string>
): Promise<ActiveBranch[]> {
  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github.v3+json",
  };

  const branchesRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/branches?per_page=100`,
    { headers }
  );
  if (!branchesRes.ok) return [];
  const branches: any[] = await branchesRes.json();

  const repoRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}`,
    { headers }
  );
  if (!repoRes.ok) return [];
  const repoData: any = await repoRes.json();
  const defaultBranch = repoData.default_branch;

  const activeBranches: ActiveBranch[] = [];

  const branchChecks = branches.filter(
    (b) => b.name !== defaultBranch && !openPRBranchNames.has(b.name)
  );

  for (let i = 0; i < branchChecks.length; i += 5) {
    const batch = branchChecks.slice(i, i + 5);
    await Promise.all(
      batch.map(async (branch) => {
        try {
          const compareRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/compare/${encodeURIComponent(defaultBranch)}...${encodeURIComponent(branch.name)}`,
            { headers }
          );
          if (!compareRes.ok) return;
          const compare: any = await compareRes.json();

          if (compare.ahead_by === 0) return;

          const recentCommits = (compare.commits ?? []).filter(
            (c: any) =>
              c.commit?.committer?.date &&
              c.commit.committer.date >= since &&
              c.commit.committer.date <= until
          );

          if (recentCommits.length === 0) return;

          const latest = recentCommits[recentCommits.length - 1];
          activeBranches.push({
            name: branch.name,
            lastCommitDate: latest.commit.committer.date,
            lastCommitMessage: (latest.commit.message ?? "").split("\n")[0].slice(0, 200),
            author: latest.author?.login ?? latest.commit.author?.name ?? "unknown",
            aheadBy: compare.ahead_by,
          });
        } catch {
          // skip branches we can't compare
        }
      })
    );
  }

  return activeBranches.sort(
    (a, b) => b.lastCommitDate.localeCompare(a.lastCommitDate)
  );
}

async function retryGql<T>(fn: () => Promise<T>, label: string, maxRetries = 5): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status;
      const msg = err?.message ?? "";
      const isRetryable = status === 502 || status === 503 || status === 429 || msg.includes("Resource limits");
      if (isRetryable && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 2000; // longer backoff for rate limits
        console.log(`    ${label}: attempt ${attempt} failed (${status ?? msg.slice(0, 50)}), retrying in ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`${label}: exhausted retries`);
}

export async function collectRepoActivity(
  gql: typeof graphql,
  token: string,
  owner: string,
  repo: string,
  since: string,
  until: string,
  repoConfig?: RepoConfig
): Promise<RepoActivity> {
  console.log(`  Collecting ${owner}/${repo}...`);

  // First page (open PRs, issues, releases, commits — NOT merged PRs)
  let data: any = await retryGql(
    () => gql(buildRepoQuery(null), { org: owner, repo, since, until }),
    `${repo} main query`
  );

  let r = data.repository;
  let allOpenIssueNodes = [...(r.openIssues?.nodes ?? [])];

  // Merged PRs are fetched by MERGE DATE via the Search API (see buildMergedSearchQ).
  const mergedSearchNodes: any[] = [];
  let mergedCursor: string | null = null;
  let mergedRounds = 0;
  do {
    const sData: any = await retryGql(
      () => gql(MERGED_SEARCH_QUERY, { q: buildMergedSearchQ(owner, repo, since, until), cursor: mergedCursor }),
      `${repo} merged search${mergedCursor ? " (next page)" : ""}`
    );
    const s = sData.search;
    mergedSearchNodes.push(...(s?.nodes ?? []).filter((n: any) => n && n.number));
    mergedCursor = s?.pageInfo?.hasNextPage ? s.pageInfo.endCursor : null;
    mergedRounds++;
  } while (mergedCursor && mergedRounds < 20);

  // Paginate open issues if needed
  let issuePageInfo = r.openIssues?.pageInfo;
  let paginationRounds = 0;
  while (issuePageInfo?.hasNextPage && paginationRounds < 2) {
    const lastNode = allOpenIssueNodes[allOpenIssueNodes.length - 1];
    const lastDate = lastNode?.createdAt;
    if (lastDate && lastDate < since) break;

    console.log(`    Paginating open issues (page ${paginationRounds + 2})...`);
    const nextData: any = await retryGql(
      () => gql(buildRepoQuery(issuePageInfo.endCursor), { org: owner, repo, since, until }),
      `${repo} open issues page ${paginationRounds + 2}`
    );
    const nextNodes = nextData.repository.openIssues?.nodes ?? [];
    allOpenIssueNodes.push(...nextNodes);
    issuePageInfo = nextData.repository.openIssues?.pageInfo;
    paginationRounds++;
  }

  // Fetch discussions separately
  let discussions: Discussion[] = [];
  try {
    const discData: any = await retryGql(
      () => gql(DISCUSSIONS_QUERY, { org: owner, repo }),
      `${repo} discussions`
    );
    discussions = filterByDateRange(
      (discData.repository.discussions?.nodes ?? []).map(mapDiscussion),
      since,
      until
    );
  } catch (err) {
    console.log(`    Discussions not available for ${repo}: ${err instanceof Error ? err.message : err}`);
  }

  // Defensive: only genuinely-merged PRs (mergedAt != null) may enter mergedPRs.
  // Search already constrains by merge date; filterByDateRange re-checks the
  // exact UTC window boundaries.
  const mergedPRs = filterByDateRange<PullRequest>(
    mergedSearchNodes.map(mapPR).filter((pr) => pr.merged),
    since,
    until,
    "mergedAt"
  );

  // Combine PRs created this period + PRs updated this period, deduplicate by number
  const createdPRs = filterByDateRange<PullRequest>(
    (r.openedPRs?.nodes ?? []).map(mapPR),
    since,
    until
  );
  const recentlyUpdatedPRs = filterByDateRange<PullRequest>(
    (r.updatedPRs?.nodes ?? []).map(mapPR),
    since,
    until,
    "updatedAt"
  );
  const seenPRNumbers = new Set(createdPRs.map((pr) => pr.number));
  let openedPRs = [
    ...createdPRs,
    ...recentlyUpdatedPRs.filter((pr) => !seenPRNumbers.has(pr.number)),
  ];

  // Apply per-repo open PR filters from config
  if (repoConfig?.excludeDraftPRs) {
    openedPRs = openedPRs.filter((pr) => !pr.isDraft);
  }
  if (repoConfig?.openPRBaseBranch) {
    openedPRs = openedPRs.filter((pr) => pr.baseRefName === repoConfig.openPRBaseBranch);
  }

  const openedIssues = filterByDateRange<Issue>(
    allOpenIssueNodes.map(mapIssue),
    since,
    until
  );

  const closedIssues = filterByDateRange<Issue>(
    (r.closedIssues?.nodes ?? []).map(mapIssue),
    since,
    until,
    "closedAt"
  );

  const releases: Release[] = (r.releases?.nodes ?? [])
    .filter(
      (rel: any) => rel.publishedAt && rel.publishedAt >= since && rel.publishedAt <= until
    )
    .map((rel: any) => ({
      tagName: rel.tagName,
      name: rel.name ?? rel.tagName,
      url: rel.url,
      publishedAt: rel.publishedAt,
      body: (rel.description ?? "").slice(0, 500),
    }));

  const commitHistory = r.defaultBranchRef?.target?.history;
  const commits: CommitSummary = {
    totalCount: commitHistory?.totalCount ?? 0,
    authors: [
      ...new Set(
        (commitHistory?.nodes ?? [])
          .map((c: any) => c.author?.user?.login)
          .filter(Boolean)
      ),
    ] as string[],
  };

  // Fetch active branches
  const openPRBranchNames = new Set<string>(
    [...(r.openedPRs?.nodes ?? []), ...(r.updatedPRs?.nodes ?? [])].map((pr: any) => pr.headRefName as string).filter(Boolean)
  );
  let activeBranches: ActiveBranch[] = [];
  try {
    activeBranches = await fetchActiveBranches(token, owner, repo, since, until, openPRBranchNames);
  } catch (err) {
    console.log(`    Could not fetch branches for ${repo}: ${err instanceof Error ? err.message : err}`);
  }

  console.log(
    `    ${mergedPRs.length} merged PRs, ${openedPRs.length} opened PRs, ` +
      `${openedIssues.length} new issues, ${closedIssues.length} closed issues, ` +
      `${discussions.length} discussions, ${releases.length} releases, ` +
      `${commits.totalCount} commits, ${activeBranches.length} active branches`
  );

  return {
    owner,
    repo,
    mergedPRs,
    openedPRs,
    openedIssues,
    closedIssues,
    discussions,
    releases,
    commits,
    activeBranches,
  };
}

// Cache raw data to avoid re-fetching when iterating on prompts
function getCachePath(cacheDir: string, weekStart: string, weekEnd: string): string {
  return join(cacheDir, `${weekStart}_${weekEnd}.json`);
}

export function loadCachedData(cacheDir: string, weekStart: string, weekEnd: string): WeeklyData | null {
  const path = getCachePath(cacheDir, weekStart, weekEnd);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    console.log(`Loaded cached data from ${path}`);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveCachedData(cacheDir: string, data: WeeklyData): void {
  mkdirSync(cacheDir, { recursive: true });
  const path = getCachePath(cacheDir, data.weekStart, data.weekEnd);
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
  console.log(`Cached raw data to ${path}`);
}

export type NetworkStatus = "Enabled" | "Open for Voting" | "Obsolete" | "In Development" | "Unknown";

export interface AmendmentStatus {
  name: string;
  type: "FEATURE" | "FIX" | "RETIRE_FEATURE" | "RETIRE_FIX";
  supported: boolean;
  voteBehavior: string;
  networkStatus: NetworkStatus;
}

async function fetchNetworkStatuses(token: string): Promise<Map<string, NetworkStatus>> {
  console.log("Fetching amendment network statuses from known-amendments.md...");
  const res = await fetch(
    `https://raw.githubusercontent.com/${DEFAULT_ORG}/xrpl-dev-portal/master/resources/known-amendments.md`
  );
  if (!res.ok) {
    console.log("  Could not fetch known-amendments.md");
    return new Map();
  }

  const content = await res.text();
  const statuses = new Map<string, NetworkStatus>();

  // Parse "### AmendmentName" followed by a table with "| Status | value |"
  const sectionRegex = /^### (\w+)/gm;
  let sectionMatch;
  while ((sectionMatch = sectionRegex.exec(content)) !== null) {
    const name = sectionMatch[1];
    // Find the Status row in the table after this header
    const afterHeader = content.slice(sectionMatch.index, sectionMatch.index + 500);
    const statusMatch = afterHeader.match(/\|\s*Status\s*\|\s*([^|]+)\|/);
    if (statusMatch) {
      const raw = statusMatch[1].trim();
      if (raw === "Enabled") statuses.set(name, "Enabled");
      else if (raw === "Open for Voting") statuses.set(name, "Open for Voting");
      else if (raw.startsWith("Obsolete")) statuses.set(name, "Obsolete");
      else if (raw.startsWith("In Development")) statuses.set(name, "In Development");
    }
  }

  console.log(`  Loaded ${statuses.size} amendment network statuses`);
  return statuses;
}

export async function fetchAmendmentStatuses(token: string): Promise<AmendmentStatus[]> {
  console.log("Fetching amendment statuses from rippled features.macro...");
  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github.v3+json",
  };

  // Fetch both sources in parallel
  const [macroRes, networkStatuses] = await Promise.all([
    fetch(
      `https://api.github.com/repos/${DEFAULT_ORG}/rippled/contents/include/xrpl/protocol/detail/features.macro`,
      { headers }
    ),
    fetchNetworkStatuses(token),
  ]);

  if (!macroRes.ok) {
    console.log("  Could not fetch features.macro");
    return [];
  }

  const data: any = await macroRes.json();
  const content = Buffer.from(data.content, "base64").toString("utf-8");

  const amendments: AmendmentStatus[] = [];

  // Lookup helper: XRPL_FIX(Foo) → "fixFoo" in the doc, XRPL_FEATURE(Foo) → "Foo"
  function lookupNetworkStatus(type: string, name: string): NetworkStatus {
    // Try exact name first, then with "fix" prefix for FIX types
    return networkStatuses.get(name)
      ?? (type === "FIX" ? networkStatuses.get("fix" + name) : undefined)
      ?? "Unknown";
  }

  // Active amendments: XRPL_FEATURE(..., Supported::yes, VoteBehavior::DefaultNo)
  const activeRegex = /XRPL_(FEATURE|FIX)\s*\(\s*(\w+)\s*,\s*Supported::(\w+)\s*,\s*VoteBehavior::(\w+)\s*\)/g;
  let match;
  while ((match = activeRegex.exec(content)) !== null) {
    const name = match[2];
    const type = match[1];
    amendments.push({
      name,
      type: type as AmendmentStatus["type"],
      supported: match[3] === "yes",
      voteBehavior: match[4],
      networkStatus: lookupNetworkStatus(type, name),
    });
  }

  // Retired amendments: XRPL_RETIRE_FEATURE(name) or XRPL_RETIRE_FIX(name)
  const retireRegex = /XRPL_(RETIRE_FEATURE|RETIRE_FIX)\s*\(\s*(\w+)\s*\)/g;
  while ((match = retireRegex.exec(content)) !== null) {
    const name = match[2];
    const type = match[1];
    const netStatus = lookupNetworkStatus(type, name);
    amendments.push({
      name,
      type: type as AmendmentStatus["type"],
      supported: false,
      voteBehavior: "Obsolete",
      networkStatus: netStatus === "Unknown" ? "Obsolete" : netStatus,
    });
  }

  console.log(`  Loaded ${amendments.length} amendments from features.macro`);
  return amendments;
}

export function saveCachedAmendments(cacheDir: string, amendments: AmendmentStatus[]): void {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, "amendments.json"), JSON.stringify(amendments, null, 2), "utf-8");
}

export interface SecurityAdvisory {
  ghsaId: string;
  summary: string;
  severity: string;
  publishedAt: string;
  url: string;
  repo: string;
}

/** Fetch published GitHub Security Advisories for all tracked repos. */
export async function fetchSecurityAdvisories(token: string): Promise<SecurityAdvisory[]> {
  console.log("Fetching GitHub Security Advisories...");
  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github.v3+json",
  };

  const advisories: SecurityAdvisory[] = [];

  for (const repo of REPOS) {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${repo.owner}/${repo.name}/security-advisories?state=published&per_page=20`,
        { headers }
      );
      if (!res.ok) continue; // 404 if advisories not enabled
      const data: any[] = await res.json();
      for (const a of data) {
        advisories.push({
          ghsaId: a.ghsa_id,
          summary: a.summary ?? "",
          severity: a.severity ?? "unknown",
          publishedAt: a.published_at ?? "",
          url: a.html_url ?? "",
          repo: `${repo.owner}/${repo.name}`,
        });
      }
    } catch {
      // Skip repos where advisories API fails
    }
  }

  console.log(`  Found ${advisories.length} published advisories`);
  return advisories;
}

export interface BlogPost {
  filename: string;
  date: string;
  title: string;
  description: string;
  url: string;
  body: string;
}

export async function fetchBlogPosts(token: string, since: string, until: string): Promise<BlogPost[]> {
  console.log("Fetching xrpl.org blog posts...");
  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github.v3+json",
  };

  // Determine which year folders to check based on the date range
  const years = new Set([since.slice(0, 4), until.slice(0, 4)]);
  const posts: BlogPost[] = [];

  for (const year of years) {
    const res = await fetch(
      `https://api.github.com/repos/${DEFAULT_ORG}/xrpl-dev-portal/contents/blog/${year}`,
      { headers }
    );
    if (!res.ok) continue;
    const entries: any[] = await res.json();
    const mdFiles = entries.filter((e: any) => e.type === "file" && e.name.endsWith(".md"));

    // Fetch files in batches of 5
    for (let i = 0; i < mdFiles.length; i += 5) {
      const batch = mdFiles.slice(i, i + 5);
      await Promise.all(
        batch.map(async (file: any) => {
          try {
            const raw = await fetch(
              `https://raw.githubusercontent.com/${DEFAULT_ORG}/xrpl-dev-portal/master/blog/${year}/${file.name}`
            );
            if (!raw.ok) return;
            const content = await raw.text();

            // Parse frontmatter
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
            if (!fmMatch) return;
            const fm = fmMatch[1];

            const dateMatch = fm.match(/date:\s*["']?(\d{4}-\d{2}-\d{2})["']?/);
            if (!dateMatch) return;
            const date = dateMatch[1];

            // Filter by date range
            if (date < since || date > until) return;

            const titleMatch = content.match(/^#\s+(.+)$/m);
            const descMatch = fm.match(/description:\s*(.+)/);

            // Get body after frontmatter, truncate
            const bodyStart = content.indexOf("---", 4);
            const body = bodyStart > 0 ? content.slice(bodyStart + 3).trim().slice(0, 1500) : "";

            posts.push({
              filename: file.name,
              date,
              title: titleMatch?.[1]?.trim() ?? file.name.replace(".md", ""),
              description: descMatch?.[1]?.trim() ?? "",
              url: `https://xrpl.org/blog/${year}/${file.name.replace(".md", "")}`,
              body,
            });
          } catch {
            // skip unparseable posts
          }
        })
      );
    }
  }

  posts.sort((a, b) => a.date.localeCompare(b.date));
  console.log(`  Found ${posts.length} blog posts in date range`);
  return posts;
}

export interface XlsSpec {
  xls: number;
  title: string;
  status: string;
  category: string;
}

export async function fetchXlsSpecs(token: string): Promise<XlsSpec[]> {
  console.log("Fetching XRPL-Standards index...");
  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github.v3+json",
  };

  // List all XLS directories
  const res = await fetch(
    `https://api.github.com/repos/${DEFAULT_ORG}/XRPL-Standards/contents`,
    { headers }
  );
  if (!res.ok) {
    console.log("  Could not fetch XRPL-Standards index");
    return [];
  }
  const entries: any[] = await res.json();
  const xlsDirs = entries
    .filter((e: any) => e.type === "dir" && e.name.startsWith("XLS-"))
    .map((e: any) => e.name);

  // Fetch README frontmatter from each in batches
  const specs: XlsSpec[] = [];

  for (let i = 0; i < xlsDirs.length; i += 10) {
    const batch = xlsDirs.slice(i, i + 10);
    await Promise.all(
      batch.map(async (dir: string) => {
        try {
          const readmeRes = await fetch(
            `https://api.github.com/repos/${DEFAULT_ORG}/XRPL-Standards/contents/${dir}/README.md`,
            { headers }
          );
          if (!readmeRes.ok) return;
          const readmeData: any = await readmeRes.json();
          const content = Buffer.from(readmeData.content, "base64").toString("utf-8");

          // Parse YAML frontmatter between <pre> tags
          const preMatch = content.match(/<pre>([\s\S]*?)<\/pre>/);
          if (!preMatch) return;

          const frontmatter = preMatch[1];
          const xlsMatch = frontmatter.match(/xls:\s*(\d+)/);
          const titleMatch = frontmatter.match(/title:\s*(.+)/);
          const statusMatch = frontmatter.match(/status:\s*(.+)/);
          const categoryMatch = frontmatter.match(/category:\s*(.+)/);

          if (xlsMatch && titleMatch) {
            specs.push({
              xls: parseInt(xlsMatch[1], 10),
              title: titleMatch[1].trim(),
              status: statusMatch?.[1]?.trim() ?? "Unknown",
              category: categoryMatch?.[1]?.trim() ?? "Unknown",
            });
          }
        } catch {
          // skip unparseable specs
        }
      })
    );
  }

  specs.sort((a, b) => a.xls - b.xls);
  console.log(`  Loaded ${specs.length} XLS specs`);
  return specs;
}

export function saveCachedSpecs(cacheDir: string, specs: XlsSpec[]): void {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, "xls-specs.json"), JSON.stringify(specs, null, 2), "utf-8");
}

export async function collectWeeklyData(
  token: string,
  weeksAgo = 0
): Promise<WeeklyData> {
  const { since, until } = getWeekRange(weeksAgo);

  console.log(`Collecting activity from ${since.slice(0, 10)} to ${until.slice(0, 10)}`);

  const gql = graphql.defaults({
    headers: { authorization: `token ${token}` },
  });

  // Collect repos in parallel, limited to stay within GitHub GraphQL node limits
  const repos: RepoActivity[] = [];
  const failed: string[] = [];
  for (let i = 0; i < REPOS.length; i += CONCURRENCY) {
    const batch = REPOS.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((r) => collectRepoActivity(gql, token, r.owner, r.name, since, until, r))
    );
    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status === "fulfilled") {
        repos.push(result.value);
      } else {
        const { owner, name } = batch[j];
        console.error(`  Failed to collect ${owner}/${name}:`, result.reason?.message ?? result.reason);
        failed.push(`${owner}/${name}`);
      }
    }
  }

  // Fail closed: never produce an incomplete dataset. A dropped repo would
  // silently appear as "0 merged / 0 activity" in the report, which is worse
  // than failing and re-running.
  if (failed.length > 0) {
    throw new Error(
      `Collection failed for ${failed.length} repo(s): ${failed.join(", ")}. Refusing to produce an incomplete report — re-run to retry.`
    );
  }

  return {
    weekStart: since.slice(0, 10),
    weekEnd: until.slice(0, 10),
    repos,
  };
}
