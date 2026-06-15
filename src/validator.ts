/**
 * Post-generation validation guard.
 *
 * The weekly/daily reports are free-text markdown produced by the model. Even
 * with deterministic input labels, the model can still misplace an open PR into
 * "What Merged" (see PR #7350, XLS-68). This module re-checks the generated
 * report against ground truth and FAILS LOUDLY when a claim cannot be backed by
 * a real merge:
 *
 *   1. Every PR referenced in the "What Merged" section must have merged_at != null
 *      per the GitHub API. Unknown/unverifiable status is treated as a violation
 *      (fail-closed).
 *   2. Every "<repo> PRs merged" count in the "By the Numbers" table must equal
 *      the verified merged-PR count for that repo.
 */

export interface PRRef {
  owner: string;
  repo: string;
  number: number;
}

export interface CountViolation {
  repo: string;
  claimed: number;
  actual: number;
}

export interface ValidationResult {
  /** True iff there are no integrity violations (open PRs claimed as merged).
   *  Count drift does NOT clear this flag — it is surfaced as a warning. */
  ok: boolean;
  unmergedClaims: PRRef[];
  countViolations: CountViolation[];
  /** Open PRs mentioned in "What Merged" only as cross-references (e.g. "fix in
   *  progress at #N"). Non-fatal, surfaced for visibility. */
  crossReferences: PRRef[];
}

export function refKey(ref: PRRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

/**
 * Repos that were expected but are absent from the collected set — i.e. their
 * collection failed (e.g. GitHub 502s exhausting retries). A missing repo means
 * the report is INCOMPLETE: it would silently show "0 merged" for that repo.
 */
export function findMissingRepos(expected: string[], collected: string[]): string[] {
  const have = new Set(collected);
  return expected.filter((r) => !have.has(r));
}

/** Return the body of an H2 section (`## {heading}`) up to the next H2, or "". */
export function extractSection(report: string, heading: string): string {
  const lines = report.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

const PR_URL = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g;

/** Extract unique PR references (owner/repo#number) from any text. */
export function extractPRReferences(text: string): PRRef[] {
  const seen = new Set<string>();
  const refs: PRRef[] = [];
  let m: RegExpExecArray | null;
  PR_URL.lastIndex = 0;
  while ((m = PR_URL.exec(text)) !== null) {
    const ref: PRRef = { owner: m[1], repo: m[2], number: parseInt(m[3], 10) };
    const k = refKey(ref);
    if (!seen.has(k)) {
      seen.add(k);
      refs.push(ref);
    }
  }
  return refs;
}

/**
 * Classify the PR references in the "What Merged" section using VERIFIED merge
 * status (not prose), line by line:
 *
 * - An OPEN PR whose line contains NO verified-merged PR is a false merge claim
 *   (the #7350 bug: an open PR presented as a merged item) → unmergedClaims.
 * - An OPEN PR that shares its line with a verified-merged PR is a
 *   cross-reference (e.g. a merged bullet for #7409 mentioning the open
 *   follow-up #7404) → crossReferences, non-fatal.
 *
 * This is robust to phrasing: it does not try to parse "in progress"/"follow-up"
 * wording, only which PRs are really merged and which share a bullet.
 */
export function classifyMergedSection(
  report: string,
  isMerged: (ref: PRRef) => boolean
): { unmergedClaims: PRRef[]; crossReferences: PRRef[] } {
  const section = extractSection(report, "What Merged");
  const unmergedClaims: PRRef[] = [];
  const crossReferences: PRRef[] = [];
  const seen = new Set<string>();
  for (const line of section.split("\n")) {
    const refs = extractPRReferences(line);
    if (refs.length === 0) continue;
    const lineHasMerged = refs.some((r) => isMerged(r));
    for (const r of refs) {
      if (isMerged(r)) continue;
      const k = refKey(r);
      if (seen.has(k)) continue;
      seen.add(k);
      (lineHasMerged ? crossReferences : unmergedClaims).push(r);
    }
  }
  return { unmergedClaims, crossReferences };
}

/**
 * Return every open PR in "What Merged" that is genuinely presented as a merged
 * item (its line has no verified-merged PR). `isVerifiedMerged` returns true
 * only when merged is confirmed; anything else (false / unknown) counts as open.
 */
export function findUnmergedClaims(
  report: string,
  isVerifiedMerged: (ref: PRRef) => boolean
): PRRef[] {
  return classifyMergedSection(report, isVerifiedMerged).unmergedClaims;
}

const MERGED_COUNT_ROW = /\|\s*([A-Za-z0-9_.\-/ ]+?)\s+PRs merged\s*\|\s*(\d+)\s*\|/g;

/** Parse "<repo> PRs merged | N |" rows from the "By the Numbers" table. */
export function extractMergedCountClaims(report: string): Map<string, number> {
  const section = extractSection(report, "By the Numbers") || report;
  const map = new Map<string, number>();
  let m: RegExpExecArray | null;
  MERGED_COUNT_ROW.lastIndex = 0;
  while ((m = MERGED_COUNT_ROW.exec(section)) !== null) {
    map.set(m[1].trim().toLowerCase(), parseInt(m[2], 10));
  }
  return map;
}

/**
 * Rewrite "<repo> PRs merged" rows in the "By the Numbers" table so the
 * This-Week cell equals the verified count, recomputing the ↑/↓/flat change vs
 * the Last-Week cell. The model recurrently under-counts; the verified count is
 * a deterministic fact we own, so we set it rather than asking the model to
 * reproduce it. Pure text transform — never throws; malformed rows are skipped.
 */
export function reconcileMergedCounts(
  report: string,
  verifiedCounts: Map<string, number>
): { report: string; corrections: { repo: string; from: number; to: number }[] } {
  const corrections: { repo: string; from: number; to: number }[] = [];
  const lines = report.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("PRs merged") || !line.trimStart().startsWith("|")) continue;
    const cells = line.split("|"); // ["", " label ", " thisWeek ", " lastWeek ", " change ", ""]
    if (cells.length < 6) continue;
    const labelMatch = cells[1].match(/^\s*(.+?)\s+PRs merged\s*$/);
    if (!labelMatch) continue;
    const repo = labelMatch[1].trim().toLowerCase();
    const verified = verifiedCounts.get(repo);
    if (verified === undefined) continue;
    const claimed = parseInt(cells[2].trim(), 10);
    if (Number.isNaN(claimed) || claimed === verified) continue;
    cells[2] = ` ${verified} `;
    const lastWeek = parseInt(cells[3].trim(), 10);
    if (!Number.isNaN(lastWeek)) {
      const diff = verified - lastWeek;
      cells[4] = ` ${diff > 0 ? "↑" + diff : diff < 0 ? "↓" + Math.abs(diff) : "flat"} `;
    }
    lines[i] = cells.join("|");
    corrections.push({ repo, from: claimed, to: verified });
  }
  return { report: lines.join("\n"), corrections };
}

/**
 * Compare claimed "PRs merged" counts against verified counts. Repos without a
 * verified count are skipped (the PR-level check still guards their claims).
 */
export function findCountViolations(
  report: string,
  verifiedCounts: Map<string, number>
): CountViolation[] {
  const claims = extractMergedCountClaims(report);
  const violations: CountViolation[] = [];
  for (const [repo, claimed] of claims) {
    const actual = verifiedCounts.get(repo);
    if (actual === undefined) continue;
    if (claimed !== actual) violations.push({ repo, claimed, actual });
  }
  return violations;
}

/**
 * "Reclassify, never drop": PRs that were in the previous edition's "What
 * Merged", are now NOT merged, and have vanished from the current report
 * entirely. Merge status controls the section a PR appears in, never whether it
 * appears at all — such PRs should have been reassigned to "In Progress" /
 * "What to Watch" (or noted as closed), not deleted.
 *
 * `isMergedNow` returns true only when the PR is confirmed merged; a PR that
 * merged since the previous edition may legitimately leave the report.
 */
export function findDroppedPRs(
  previousReport: string,
  currentReport: string,
  isMergedNow: (ref: PRRef) => boolean
): PRRef[] {
  const previouslyMerged = extractPRReferences(extractSection(previousReport, "What Merged"));
  const present = new Set(extractPRReferences(currentReport).map(refKey));
  return previouslyMerged.filter((r) => !present.has(refKey(r)) && !isMergedNow(r));
}

/**
 * Validate a generated report. `fetchStatus` resolves PR refs to a map of
 * refKey -> merged(boolean); a missing key is treated as "not verified merged".
 */
export async function validateReport(
  report: string,
  verifiedCounts: Map<string, number>,
  fetchStatus: (refs: PRRef[]) => Promise<Map<string, boolean>>
): Promise<ValidationResult> {
  const section = extractSection(report, "What Merged");
  const refs = extractPRReferences(section);
  const status = await fetchStatus(refs);
  const isMergedNow = (r: PRRef) => status.get(refKey(r)) === true;
  const { unmergedClaims, crossReferences } = classifyMergedSection(report, isMergedNow);
  const countViolations = findCountViolations(report, verifiedCounts);
  // Only an integrity violation (an open PR presented as merged) is fatal.
  // Count drift and cross-references are reported as non-fatal warnings.
  return {
    ok: unmergedClaims.length === 0,
    unmergedClaims,
    countViolations,
    crossReferences,
  };
}

/**
 * Live GitHub status fetcher: returns refKey -> (merged_at != null). Refs that
 * cannot be fetched are omitted, so they fail closed as unverified.
 */
export async function fetchMergedStatusFromGitHub(
  token: string,
  refs: PRRef[],
  concurrency = 8
): Promise<Map<string, boolean>> {
  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github.v3+json",
  };
  const status = new Map<string, boolean>();

  for (let i = 0; i < refs.length; i += concurrency) {
    const batch = refs.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (ref) => {
        try {
          const res = await fetch(
            `https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`,
            { headers }
          );
          if (!res.ok) return; // omit → fail closed
          const data: any = await res.json();
          status.set(refKey(ref), data.merged_at != null);
        } catch {
          // omit → fail closed
        }
      })
    );
  }

  return status;
}
