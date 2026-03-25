import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(__dirname, "..", "config.json"), "utf-8"));

export const DEFAULT_ORG: string = raw.org;
export const CONCURRENCY: number = raw.concurrency;

export interface RepoConfig {
  owner: string;
  name: string;
  /** Only include open PRs targeting this branch (e.g. "develop"). All branches if unset. */
  openPRBaseBranch?: string;
  /** Exclude draft PRs from open PR list. Default: false. */
  excludeDraftPRs?: boolean;
}

export const REPOS: RepoConfig[] = raw.repos.map((r: any) => {
  const parts = r.name.split("/");
  return {
    owner: parts.length === 2 ? parts[0] : DEFAULT_ORG,
    name: parts.length === 2 ? parts[1] : r.name,
    openPRBaseBranch: r.openPRBaseBranch,
    excludeDraftPRs: r.excludeDraftPRs,
  };
});
