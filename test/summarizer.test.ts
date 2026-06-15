import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVerifiedCountsContext } from "../src/summarizer.js";

function repo(name: string, counts: Partial<{ merged: number; opened: number; issues: number; closed: number; releases: number; commits: number }>): any {
  const n = (k: number | undefined) => new Array(k ?? 0).fill({});
  return {
    owner: "XRPLF",
    repo: name,
    mergedPRs: n(counts.merged),
    openedPRs: n(counts.opened),
    openedIssues: n(counts.issues),
    closedIssues: n(counts.closed),
    discussions: [],
    releases: n(counts.releases),
    commits: { totalCount: counts.commits ?? 0, authors: [] },
    activeBranches: [],
  };
}

test("buildVerifiedCountsContext lists exact per-repo counts and marks them authoritative", () => {
  const ctx = buildVerifiedCountsContext([
    repo("rippled", { merged: 26, opened: 17, issues: 2, commits: 22 }),
    repo("xrpl-dev-portal", { merged: 29, opened: 5, commits: 31 }),
  ]);
  assert.match(ctx, /AUTHORITATIVE/i);
  assert.match(ctx, /rippled: 26 PRs merged, 17 PRs opened/);
  assert.match(ctx, /xrpl-dev-portal: 29 PRs merged/);
});

test("buildVerifiedCountsContext omits repos with no activity", () => {
  const ctx = buildVerifiedCountsContext([
    repo("rippled", { merged: 26 }),
    repo("quiet-repo", {}),
  ]);
  assert.doesNotMatch(ctx, /quiet-repo/);
});
