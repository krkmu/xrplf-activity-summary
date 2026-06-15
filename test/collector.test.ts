import { test } from "node:test";
import assert from "node:assert/strict";
import { mapPR, buildMergedSearchQ } from "../src/collector.js";

const baseNode = {
  title: "X",
  number: 1,
  url: "https://github.com/XRPLF/rippled/pull/1",
  baseRefName: "develop",
  author: { login: "a" },
  authorAssociation: "MEMBER",
  createdAt: "2026-06-01T00:00:00Z",
  updatedAt: "2026-06-02T00:00:00Z",
  state: "OPEN",
};

test("mapPR sets merged=false when mergedAt is null", () => {
  const pr = mapPR({ ...baseNode, mergedAt: null });
  assert.equal(pr.merged, false);
});

test("mapPR sets merged=true only when mergedAt is present", () => {
  const pr = mapPR({ ...baseNode, mergedAt: "2026-06-04T20:25:52Z", state: "MERGED" });
  assert.equal(pr.merged, true);
});

// Merged PRs are fetched by merge date via Search (no deep UPDATED_AT
// pagination), which is correct for any week and avoids the rippled 502s.
test("buildMergedSearchQ targets merged PRs in the window by merge date", () => {
  const q = buildMergedSearchQ("XRPLF", "rippled", "2026-06-08T00:00:00.000Z", "2026-06-14T23:59:59.999Z");
  assert.equal(q, "repo:XRPLF/rippled is:pr is:merged merged:2026-06-08..2026-06-14");
});

// Regression #7350: open PR targeting develop, approved by the AI reviewer bot.
test("mapPR classifies an AI-approved open develop PR as not merged (#7350)", () => {
  const pr = mapPR({
    ...baseNode,
    number: 7350,
    mergedAt: null,
    state: "OPEN",
    baseRefName: "develop",
    reviewDecision: "APPROVED",
    reviews: { totalCount: 1, nodes: [{ author: { login: "xrplf-ai-reviewer" }, state: "APPROVED", body: "LGTM", createdAt: "2026-06-06T00:00:00Z" }] },
  });
  assert.equal(pr.merged, false);
});
