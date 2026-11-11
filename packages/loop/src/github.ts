import { execFileSync } from 'node:child_process';

export interface RepoInfo {
  /** "owner/name" */
  nameWithOwner: string;
  defaultBranch: string;
  url: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
  state: 'OPEN' | 'CLOSED';
  url: string;
  /** OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE ... Only the first three are trusted to steer the agent. */
  authorAssociation?: string;
}

/** Associations whose text may reach the agent's prompt. Anyone else could be an attacker on a public repository. */
export const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export interface RawFeedback {
  reviews?: { author?: { login?: string }; authorAssociation?: string; state?: string; body?: string; submittedAt?: string }[];
  comments?: { author?: { login?: string }; authorAssociation?: string; body?: string; createdAt?: string }[];
}

/**
 * Feedback from trusted people only, oldest first. Untrusted comments are
 * dropped, not quoted. With `since`, only feedback from that moment on.
 */
export function trustedFeedback(raw: RawFeedback, since?: string): string {
  const after = since ? Date.parse(since) : NaN;
  const items = [
    ...(raw.reviews ?? []).map((r) => ({ at: r.submittedAt ?? '', who: r.author?.login ?? 'someone', assoc: r.authorAssociation, body: r.body ?? '', kind: `review, ${r.state ?? ''}` })),
    ...(raw.comments ?? []).map((c) => ({ at: c.createdAt ?? '', who: c.author?.login ?? 'someone', assoc: c.authorAssociation, body: c.body ?? '', kind: '' })),
  ]
    .filter((i) => i.body.trim() && i.assoc !== undefined && TRUSTED_ASSOCIATIONS.has(i.assoc))
    .filter((i) => Number.isNaN(after) || Date.parse(i.at) >= after);
  return items
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((i) => `- ${i.who}${i.kind ? ` (${i.kind})` : ''}: ${i.body}`)
    .join('\n');
}

export interface PullRequestRef {
  number: number;
  url: string;
  isDraft: boolean;
  labels?: string[];
  headRefName?: string;
}

/** The GitHub calls a local run needs. Injected so claim and publish logic can be tested offline. */
export interface GitHubOps {
  me(): string;
  getIssue(n: number): GitHubIssue;
  listOpenIssues(label: string): GitHubIssue[];
  assignMe(n: number): void;
  unassignMe(n: number): void;
  ensureLabels(labels: readonly { name: string; color: string; description: string }[]): void;
  editLabels(n: number, add: readonly string[], remove: readonly string[]): void;
  comment(n: number, bodyFile: string): void;
  findOpenPr(branch: string): PullRequestRef | null;
  /** Open pull requests carrying `label`, with their head branch. */
  listOpenPrs(label: string): PullRequestRef[];
  editPrLabels(pr: number, add: readonly string[], remove: readonly string[]): void;
  createPr(opts: { base: string; branch: string; title: string; bodyFile: string; draft: boolean }): string;
  updatePr(pr: PullRequestRef, opts: { title: string; bodyFile: string; draft: boolean }): void;
  /** Asks people to review a pull request. GitHub notifies them, unlike a comment posted as themselves. */
  requestReview(pr: number, logins: readonly string[]): void;
  /** People's reviews and comments on a pull request, oldest first, as plain text; with `since` (ISO time), only newer ones. */
  prFeedback(pr: PullRequestRef, since?: string): string;
  /** A pull request's description. */
  prBody(pr: PullRequestRef): string;
}

/** The REST API's issue shape (`gh api repos/<repo>/issues/<n>`), which includes the author's association. */
interface RawIssue {
  number: number;
  title?: string;
  body?: string | null;
  labels?: { name: string }[];
  assignees?: { login: string }[];
  state?: string;
  html_url?: string;
  author_association?: string;
  pull_request?: unknown;
}

const PR_FIELDS = 'number,url,isDraft,labels,headRefName,isCrossRepository';

interface RawPr {
  number: number;
  url: string;
  isDraft: boolean;
  labels?: { name: string }[];
  headRefName?: string;
  isCrossRepository?: boolean;
}

function toPr(raw: RawPr): PullRequestRef {
  return {
    number: raw.number,
    url: raw.url,
    isDraft: raw.isDraft,
    labels: (raw.labels ?? []).map((l) => l.name),
    ...(raw.headRefName ? { headRefName: raw.headRefName } : {}),
  };
}

export function toIssue(raw: RawIssue): GitHubIssue {
  return {
    number: raw.number,
    title: raw.title ?? '',
    body: raw.body ?? '',
    labels: (raw.labels ?? []).map((l) => l.name),
    assignees: (raw.assignees ?? []).map((a) => a.login),
    state: (raw.state ?? '').toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN',
    url: raw.html_url ?? '',
    ...(raw.author_association ? { authorAssociation: raw.author_association } : {}),
  };
}

function gh(args: string[], cwd?: string): string {
  return execFileSync('gh', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, ...(cwd ? { cwd } : {}) }).trim();
}

/** Reads the repository the current directory belongs to, or `repo` when given. */
export function repoInfo(repo?: string, cwd?: string): RepoInfo {
  const raw = JSON.parse(gh(['repo', 'view', ...(repo ? [repo] : []), '--json', 'nameWithOwner,defaultBranchRef,url'], cwd)) as {
    nameWithOwner: string;
    defaultBranchRef: { name: string };
    url: string;
  };
  return { nameWithOwner: raw.nameWithOwner, defaultBranch: raw.defaultBranchRef.name, url: raw.url };
}

/** GitHubOps backed by the `gh` CLI, using the user's own login. */
export function createGhOps(repo: string): GitHubOps {
  const R = ['--repo', repo];
  return {
    me: () => gh(['api', 'user', '--jq', '.login']),
    getIssue: (n) => toIssue(JSON.parse(gh(['api', `repos/${repo}/issues/${n}`])) as RawIssue),
    listOpenIssues: (label) =>
      (JSON.parse(gh(['api', '--method', 'GET', `repos/${repo}/issues`, '-f', 'state=open', '-f', `labels=${label}`, '-f', 'per_page=100'])) as RawIssue[])
        .filter((i) => !i.pull_request)
        .map(toIssue),
    assignMe: (n) => {
      gh(['issue', 'edit', String(n), ...R, '--add-assignee', '@me']);
    },
    unassignMe: (n) => {
      gh(['issue', 'edit', String(n), ...R, '--remove-assignee', '@me']);
    },
    ensureLabels: (labels) => {
      for (const l of labels) {
        try {
          gh(['label', 'create', l.name, ...R, '--color', l.color, '--description', l.description]);
        } catch {
          // Already exists.
        }
      }
    },
    editLabels: (n, add, remove) => {
      const args = ['issue', 'edit', String(n), ...R];
      if (add.length > 0) args.push('--add-label', add.join(','));
      if (remove.length > 0) args.push('--remove-label', remove.join(','));
      if (add.length > 0 || remove.length > 0) gh(args);
    },
    comment: (n, bodyFile) => {
      gh(['issue', 'comment', String(n), ...R, '--body-file', bodyFile]);
    },
    findOpenPr: (branch) => {
      // A fork can open a PR from a branch with the same name; only this repository's own branch counts.
      const list = (JSON.parse(gh(['pr', 'list', ...R, '--head', branch, '--state', 'open', '--json', PR_FIELDS])) as RawPr[]).filter((p) => !p.isCrossRepository);
      return list[0] ? toPr(list[0]) : null;
    },
    listOpenPrs: (label) =>
      (JSON.parse(gh(['pr', 'list', ...R, '--label', label, '--state', 'open', '--limit', '100', '--json', PR_FIELDS])) as RawPr[])
        .filter((p) => !p.isCrossRepository)
        .map(toPr),
    editPrLabels: (n, add, remove) => {
      const args = ['pr', 'edit', String(n), ...R];
      if (add.length > 0) args.push('--add-label', add.join(','));
      if (remove.length > 0) args.push('--remove-label', remove.join(','));
      if (add.length > 0 || remove.length > 0) gh(args);
    },
    createPr: ({ base, branch, title, bodyFile, draft }) =>
      gh(['pr', 'create', ...R, '--base', base, '--head', branch, '--title', title, '--body-file', bodyFile, ...(draft ? ['--draft'] : [])]),
    prFeedback: (pr, since) => trustedFeedback(JSON.parse(gh(['pr', 'view', String(pr.number), ...R, '--json', 'reviews,comments'])) as RawFeedback, since),
    prBody: (pr) => (JSON.parse(gh(['pr', 'view', String(pr.number), ...R, '--json', 'body'])) as { body?: string }).body ?? '',
    requestReview: (pr, logins) => {
      if (logins.length > 0) gh(['pr', 'edit', String(pr), ...R, '--add-reviewer', logins.join(',')]);
    },
    updatePr: (pr, { title, bodyFile, draft }) => {
      gh(['pr', 'edit', String(pr.number), ...R, '--title', title, '--body-file', bodyFile]);
      if (draft && !pr.isDraft) gh(['pr', 'ready', String(pr.number), ...R, '--undo']);
      if (!draft && pr.isDraft) gh(['pr', 'ready', String(pr.number), ...R]);
    },
  };
}
