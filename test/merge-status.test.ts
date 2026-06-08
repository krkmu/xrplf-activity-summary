import { test } from "node:test";
import assert from "node:assert/strict";
import { isMerged, mergeStatusLabel } from "../src/merge-status.js";

test("isMerged is false when mergedAt is null", () => {
  assert.equal(isMerged({ mergedAt: null }), false);
});

test("isMerged is false when mergedAt is undefined", () => {
  assert.equal(isMerged({ mergedAt: undefined as unknown as null }), false);
});

test("isMerged is true only when mergedAt is a timestamp", () => {
  assert.equal(isMerged({ mergedAt: "2026-06-04T20:25:52Z" }), true);
});

// Regression — PR #7350 (XLS-68 Sponsor / Sponsored Fees).
// An OPEN PR targeting develop, approved only by the AI reviewer bot, must be
// classified as NOT merged. Merge status depends ONLY on mergedAt — never on
// review approvals (human or bot), the "approved" decision, target branch,
// state, or code size.
test("AI-reviewer-approved open PR targeting develop is not merged (regression #7350)", () => {
  const pr7350 = {
    number: 7350,
    mergedAt: null,
    state: "OPEN",
    baseRefName: "develop",
    reviewDecision: "APPROVED",
    reviewContent: [{ author: "xrplf-ai-reviewer", state: "APPROVED" }],
    diffStats: { additions: 13883, deletions: 1098, changedFiles: 185 },
  };
  assert.equal(isMerged(pr7350), false);
});

test("mergeStatusLabel marks merged PRs with their timestamp", () => {
  const label = mergeStatusLabel({ mergedAt: "2026-06-04T20:25:52Z" });
  assert.match(label, /MERGED/);
  assert.match(label, /2026-06-04/);
  assert.doesNotMatch(label, /NOT MERGED/);
});

test("mergeStatusLabel marks open PRs as NOT MERGED (regression #7350)", () => {
  const label = mergeStatusLabel({ mergedAt: null });
  assert.match(label, /NOT MERGED/);
});
