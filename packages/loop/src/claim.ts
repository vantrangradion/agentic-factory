import type { GitHubOps } from './github.js';

export interface ClaimResult {
  claimed: boolean;
  reason: string;
}

function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Claims an issue through its assignees, the only field GitHub lets two
 * watchers race on safely. Assigning is additive, so after assigning
 * themselves both racers see the same assignee set and agree on one winner:
 * the login that sorts first. The loser removes itself.
 *
 * `settleMs`: after winning, wait and check again, because a watcher that
 * assigns itself slightly later can still sort first. Two watchers logged in
 * as the same user cannot be told apart: run one watcher per GitHub account.
 */
export function claimIssue(gh: GitHubOps, n: number, me: string, takeUnassigned: boolean, settleMs = 3000): ClaimResult {
  const before = gh.getIssue(n);
  if (before.state !== 'OPEN') return { claimed: false, reason: 'the issue is closed' };
  if (before.assignees.length > 0 && !before.assignees.includes(me)) {
    return { claimed: false, reason: `assigned to ${before.assignees.join(', ')}` };
  }

  let selfAssigned = false;
  if (before.assignees.length === 0) {
    if (!takeUnassigned) return { claimed: false, reason: 'unassigned (pass --take-unassigned to pick these up)' };
    gh.assignMe(n);
    selfAssigned = true;
  }

  const after = gh.getIssue(n);
  if (!after.assignees.includes(me)) return { claimed: false, reason: 'assignment did not stick' };
  const winner = [...after.assignees].sort()[0];
  if (after.assignees.length > 1 && winner !== me) {
    if (selfAssigned) gh.unassignMe(n);
    return { claimed: false, reason: `${winner} claimed it first` };
  }
  if (selfAssigned) {
    sleepSync(settleMs);
    const settled = gh.getIssue(n);
    const settledWinner = [...settled.assignees].sort()[0];
    if (!settled.assignees.includes(me) || settledWinner !== me) {
      gh.unassignMe(n);
      return { claimed: false, reason: `${settledWinner ?? 'someone else'} claimed it first` };
    }
  }
  return { claimed: true, reason: after.assignees.length > 1 ? 'claimed (first of several assignees)' : 'claimed' };
}
