import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractSection,
  extractPRReferences,
  findUnmergedClaims,
  extractMergedCountClaims,
  findCountViolations,
  validateReport,
  refKey,
  type PRRef,
} from "../src/validator.js";

// A trimmed fixture modeled on the real Jun 1-7 2026 report, where open PR
// #7350 leaked into "What Merged" while genuinely-merged #7346 belongs there.
const REPORT = `# Weekly Summary

## TL;DR
Some merged things in rippled.

---

## What Merged

### Protocol & Feature Work (rippled — merged to develop)
- **Sponsor implementation (XLS-68)**: ... [rippled#7350](https://github.com/XRPLF/rippled/pull/7350)
- **Fee vote hard-cap maxes** [rippled#7346](https://github.com/XRPLF/rippled/pull/7346)

---

## In Progress

**rippled — perf** ([rippled#7421](https://github.com/XRPLF/rippled/pull/7421), approved). Approved by the AI reviewer.

---

## By the Numbers

| Metric | This Week | Last Week | Change |
|---|---|---|---|
| rippled PRs merged | 30 | 27 | ↑3 |
| Clio PRs merged | 7 | 10 | ↓3 |
`;

test("extractSection returns only the named H2 section body", () => {
  const merged = extractSection(REPORT, "What Merged");
  assert.ok(merged.includes("7350"));
  assert.ok(merged.includes("7346"));
  // must stop at the next H2 — In Progress content excluded
  assert.ok(!merged.includes("7421"));
});

test("extractSection returns empty string for a missing section", () => {
  assert.equal(extractSection(REPORT, "Nonexistent Section"), "");
});

test("extractPRReferences parses owner/repo/number from PR URLs and dedupes", () => {
  const refs = extractPRReferences(
    "[a](https://github.com/XRPLF/rippled/pull/7350) [b](https://github.com/XRPLF/rippled/pull/7350) [c](https://github.com/XRPLF/clio/pull/3095)"
  );
  assert.deepEqual(
    refs.map(refKey).sort(),
    ["XRPLF/clio#3095", "XRPLF/rippled#7350"]
  );
});

test("extractPRReferences ignores issue URLs (only /pull/)", () => {
  const refs = extractPRReferences("[i](https://github.com/XRPLF/rippled/issues/7395)");
  assert.equal(refs.length, 0);
});

test("findUnmergedClaims flags PRs in What Merged that are not verified-merged", () => {
  const verified = new Map<string, boolean>([
    ["XRPLF/rippled#7350", false],
    ["XRPLF/rippled#7346", true],
  ]);
  const violations = findUnmergedClaims(REPORT, (r) => verified.get(refKey(r)) === true);
  assert.deepEqual(violations.map(refKey), ["XRPLF/rippled#7350"]);
});

test("findUnmergedClaims flags PRs whose status is unknown (fail-closed)", () => {
  // If we cannot confirm merged==true, treat the claim as a violation.
  const violations = findUnmergedClaims(REPORT, () => false);
  assert.deepEqual(violations.map(refKey).sort(), [
    "XRPLF/rippled#7346",
    "XRPLF/rippled#7350",
  ]);
});

test("findUnmergedClaims passes when every claimed PR is verified merged", () => {
  const violations = findUnmergedClaims(REPORT, () => true);
  assert.equal(violations.length, 0);
});

test("extractMergedCountClaims parses 'X PRs merged' rows from By the Numbers", () => {
  const claims = extractMergedCountClaims(REPORT);
  assert.equal(claims.get("rippled"), 30);
  assert.equal(claims.get("clio"), 7);
});

test("findCountViolations reports rows where the claimed merged count != verified", () => {
  const verified = new Map<string, number>([
    ["rippled", 23],
    ["clio", 7],
  ]);
  const violations = findCountViolations(REPORT, verified);
  assert.deepEqual(violations, [{ repo: "rippled", claimed: 30, actual: 23 }]);
});

test("validateReport fails loudly with the offending PRs and counts", async () => {
  const verifiedCounts = new Map<string, number>([
    ["rippled", 1],
    ["clio", 7],
  ]);
  const fetchStatus = async (refs: PRRef[]) => {
    const m = new Map<string, boolean>();
    for (const r of refs) m.set(refKey(r), r.number === 7346); // only 7346 merged
    return m;
  };
  const result = await validateReport(REPORT, verifiedCounts, fetchStatus);
  assert.equal(result.ok, false);
  assert.deepEqual(result.unmergedClaims.map(refKey), ["XRPLF/rippled#7350"]);
  assert.deepEqual(result.countViolations, [{ repo: "rippled", claimed: 30, actual: 1 }]);
});

test("validateReport treats a count-only mismatch as a non-fatal warning (ok=true)", async () => {
  const report = `## What Merged
- [rippled#7346](https://github.com/XRPLF/rippled/pull/7346)

## By the Numbers
| rippled PRs merged | 22 | 27 | flat |
`;
  const result = await validateReport(
    report,
    new Map([["rippled", 24]]),
    async (refs) => new Map(refs.map((r) => [refKey(r), true]))
  );
  // Integrity is clean -> publishable, even though the count drifted.
  assert.equal(result.ok, true);
  assert.equal(result.unmergedClaims.length, 0);
  assert.deepEqual(result.countViolations, [{ repo: "rippled", claimed: 22, actual: 24 }]);
});

test("validateReport stays fatal (ok=false) when an open PR is claimed merged", async () => {
  // Counts are fine here; the only problem is the integrity violation.
  const report = `## What Merged
- [rippled#7350](https://github.com/XRPLF/rippled/pull/7350)

## By the Numbers
| rippled PRs merged | 1 | 0 | ↑1 |
`;
  const result = await validateReport(
    report,
    new Map([["rippled", 1]]),
    async () => new Map([["XRPLF/rippled#7350", false]])
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.unmergedClaims.map(refKey), ["XRPLF/rippled#7350"]);
});

test("validateReport passes a clean report", async () => {
  const clean = `## What Merged
- [rippled#7346](https://github.com/XRPLF/rippled/pull/7346)

## By the Numbers
| rippled PRs merged | 1 | 0 | ↑1 |
`;
  const result = await validateReport(
    clean,
    new Map([["rippled", 1]]),
    async (refs) => new Map(refs.map((r) => [refKey(r), true]))
  );
  assert.equal(result.ok, true);
  assert.equal(result.unmergedClaims.length, 0);
  assert.equal(result.countViolations.length, 0);
});
