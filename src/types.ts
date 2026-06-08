export interface Comment {
  author: string;
  body: string;
  createdAt: string;
}

export interface ReviewComment {
  author: string;
  body: string;
  state: string; // APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED
  createdAt: string;
}

// FIRST_TIME_CONTRIBUTOR, CONTRIBUTOR, MEMBER, COLLABORATOR, OWNER, NONE
export type AuthorAssociation = string;

export interface LinkedIssue {
  number: number;
  title: string;
  url: string;
}

export interface DiffStats {
  additions: number;
  deletions: number;
  changedFiles: number;
}

export interface PullRequest {
  title: string;
  number: number;
  url: string;
  isDraft: boolean;
  baseRefName: string;
  author: string;
  authorAssociation: AuthorAssociation;
  mergedAt: string | null;
  /** Single source of truth for merge status: true iff mergedAt != null. */
  merged: boolean;
  createdAt: string;
  updatedAt: string;
  state: string;
  labels: string[];
  body: string;
  reviewComments: number;
  reviews: number;
  reviewContent: ReviewComment[];
  commentContent: Comment[];
  diffStats: DiffStats;
  linkedIssues: LinkedIssue[];
}

export interface ActiveBranch {
  name: string;
  lastCommitDate: string;
  lastCommitMessage: string;
  author: string;
  aheadBy: number;
}

export interface Issue {
  title: string;
  number: number;
  url: string;
  author: string;
  authorAssociation: AuthorAssociation;
  createdAt: string;
  closedAt: string | null;
  state: string;
  labels: string[];
  comments: number;
  body: string;
  commentContent: Comment[];
}

export interface Discussion {
  title: string;
  number: number;
  url: string;
  author: string;
  authorAssociation: AuthorAssociation;
  createdAt: string;
  category: string;
  comments: number;
  body: string;
  commentContent: Comment[];
}

export interface Release {
  tagName: string;
  name: string;
  url: string;
  publishedAt: string;
  body: string;
}

export interface CommitSummary {
  totalCount: number;
  authors: string[];
}

export interface RepoActivity {
  owner: string;
  repo: string;
  mergedPRs: PullRequest[];
  openedPRs: PullRequest[];
  openedIssues: Issue[];
  closedIssues: Issue[];
  discussions: Discussion[];
  releases: Release[];
  commits: CommitSummary;
  activeBranches: ActiveBranch[];
}

export interface WeeklyData {
  weekStart: string;
  weekEnd: string;
  repos: RepoActivity[];
  previousReport?: string;
}
