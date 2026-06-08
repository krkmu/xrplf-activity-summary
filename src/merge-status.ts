/**
 * Single source of truth for PR merge status.
 *
 * A pull request is "merged" if and only if the GitHub API reports a non-null
 * merge timestamp (GraphQL `mergedAt`, equivalently REST `merged_at`). Merge
 * status must NEVER be inferred from anything else — not code completeness, line
 * counts, an approving review (human OR bot/AI reviewer), the "approved" review
 * decision, recent commit activity, or the fact that the PR targets `develop`.
 *
 * See test/merge-status.test.ts (regression fixture: open PR #7350, XLS-68).
 */
export function isMerged(pr: { mergedAt: string | null | undefined }): boolean {
  return pr.mergedAt != null;
}

/**
 * A machine-checkable status tag embedded in each PR line of the prompt, so the
 * model is handed the verified status rather than asked to judge it. The model
 * is instructed (see system prompts) to place a PR in "What Merged" if and only
 * if its line carries `STATUS: MERGED`, and never to recategorize a
 * `STATUS: OPEN — NOT MERGED` PR as merged.
 */
export function mergeStatusLabel(pr: { mergedAt: string | null | undefined }): string {
  return isMerged(pr)
    ? `STATUS: MERGED on ${pr.mergedAt!.slice(0, 10)}`
    : "STATUS: OPEN — NOT MERGED";
}
