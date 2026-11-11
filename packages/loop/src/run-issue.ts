import * as fs from 'node:fs';
import * as path from 'node:path';
import { decideBudget } from './budget.js';
import { claimIssue } from './claim.js';
import type { ResolvedAgentConfig } from './config.js';
import { TRUSTED_ASSOCIATIONS, type GitHubIssue, type GitHubOps, type RepoInfo } from './github.js';
import { matchesAny } from './glob.js';
import type { Issue } from './issue.js';
import { costUsd, readRecords, writeRecord, type RunRecord, type Stage } from './ledger.js';
import { extractPlan } from './plan.js';
import type { LedgerStore } from './ledger-store.js';
import type { LoopDeps, LoopOptions, LoopResult } from './loop.js';
import { addUsage, ZERO_USAGE, type TokenUsage } from './runner.js';
import { renderFailureComment, renderPlanPrBody, renderPrBody } from './render.js';

export type RunIssueOutcome = 'skipped' | 'over-budget' | 'plan-ready' | 'passed' | 'needs-human' | 'crashed';

export interface RunIssueResult {
  outcome: RunIssueOutcome;
  reason: string;
  stage?: Stage;
  prUrl?: string;
}

export interface PreparedWorkspace {
  /** Commit the work starts from on the default branch. */
  diffBase: string;
  /** Files the checked-out branch changes relative to `diffBase`. Empty for a fresh branch. */
  changedFiles: string[];
  /** When the checked-out branch last got a commit (ISO time), before any rebase. Comments after it are new. */
  branchUpdatedAt?: string;
  /** Files that conflicted when rebasing the checked-out branch onto the default branch. Setup did not run. */
  rebaseConflicts?: string[];
}

export interface RunIssueDeps {
  gh: GitHubOps;
  repo: RepoInfo;
  me: string;
  ledger: LedgerStore;
  /** Folder for this repository's clones and outputs. Never inside the user's own checkout. */
  workRoot: string;
  /**
   * Makes a clean clone of the default branch in `dir`, checks out `branch`
   * from the remote when given (to build an approved plan), and runs setup.
   */
  prepare: (dir: string, setup: string | null, branch: string | null) => PreparedWorkspace;
  /** Reads the agent config from the clean clone, so a run uses the default branch's rules. */
  loadConfig: (dir: string) => ResolvedAgentConfig;
  loop: (issue: Issue, config: ResolvedAgentConfig, dir: string, opts: LoopOptions, onUsage: LoopDeps['onUsage']) => LoopResult;
  push: (dir: string, branch: string) => void;
  now: () => Date;
  log: (m: string) => void;
  /** Wait before confirming a claim on an issue this watcher assigned itself to. Default 3 s. */
  claimSettleMs?: number;
}

export interface RunIssueOptions {
  /** Claim issues nobody is assigned to. */
  takeUnassigned: boolean;
  /** Started by a person for this one issue: run without the ready label and explain budget stops on the issue. */
  explicit: boolean;
}

export const LABEL_COLORS = {
  ready: ['0E8A16', 'Ready for the agent loop'],
  working: ['FBCA04', 'The agent loop is working on this'],
  planReview: ['5319E7', 'A plan and failing tests wait for approval'],
  planApproved: ['0E8A16', 'Plan approved: the agent loop implements it next'],
  prOpen: ['1D76DB', 'The agent loop opened a pull request'],
  needsHuman: ['D93F0B', 'The agent loop stopped and needs a person'],
} as const;

function allLabels(config: ResolvedAgentConfig): { name: string; color: string; description: string }[] {
  return (Object.keys(LABEL_COLORS) as (keyof typeof LABEL_COLORS)[]).map((k) => ({
    name: config.labels[k],
    color: LABEL_COLORS[k][0],
    description: LABEL_COLORS[k][1],
  }));
}

function toLoopIssue(i: GitHubIssue): Issue {
  return { number: i.number, title: i.title, body: i.body, labels: i.labels, url: i.url };
}

function writeFile(dir: string, name: string, text: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

/** Which stage an issue is ready for, or why it is not ready. */
export function stageFor(
  issue: GitHubIssue,
  config: ResolvedAgentConfig,
  explicit: boolean,
  planPrLabels: readonly string[] = [],
): { stage: Stage } | { skip: string } {
  const L = config.labels;
  if (issue.state !== 'OPEN') return { skip: 'the issue is closed' };
  if (issue.labels.includes(L.working)) return { skip: `already labelled ${L.working}` };
  if (config.plan.approval === 'none') {
    return issue.labels.includes(L.ready) || explicit ? { stage: 'full' } : { skip: `not labelled ${L.ready}` };
  }
  // People approve where they read the plan, so the label counts on the issue or on its plan pull request.
  if (issue.labels.includes(L.planApproved) || planPrLabels.includes(L.planApproved)) return { stage: 'build' };
  if (issue.labels.includes(L.ready)) return { stage: 'plan' };
  if (issue.labels.includes(L.planReview)) return { skip: `the plan waits for approval: add ${L.planApproved}, or comment and add ${L.ready} to re-plan` };
  return explicit ? { stage: 'plan' } : { skip: `not labelled ${L.ready} or ${L.planApproved}` };
}

/**
 * Runs one issue on this machine. With plan approval on, a run is either the
 * plan stage (failing tests and a plan in a draft PR, then stop) or the build
 * stage (implement the approved plan on its branch). `labelConfig` comes from
 * the user's checkout and is only used before the clean clone exists.
 */
export function runIssue(n: number, labelConfig: ResolvedAgentConfig, deps: RunIssueDeps, opts: RunIssueOptions): RunIssueResult {
  const { gh, log } = deps;
  const L = labelConfig.labels;
  const outDir = path.join(deps.workRoot, 'out', `issue-${n}`);
  const branch = `${labelConfig.branchPrefix}issue-${n}`;

  const issue = gh.getIssue(n);
  // On a public repository anyone can open an issue and edit its body later; only collaborators may steer the agent.
  if (issue.authorAssociation !== undefined && !TRUSTED_ASSOCIATIONS.has(issue.authorAssociation)) {
    return { outcome: 'skipped', reason: `opened by a ${issue.authorAssociation.toLowerCase()}, not a collaborator: a collaborator must file it` };
  }
  const existingPr = gh.findOpenPr(branch);
  const choice = stageFor(issue, labelConfig, opts.explicit, existingPr?.labels ?? []);
  if ('skip' in choice) return { outcome: 'skipped', reason: choice.skip };
  const stage = choice.stage;

  const { records } = readRecords(deps.ledger.sync());
  const budget = decideBudget(records, labelConfig.budget, issue.labels, deps.now());
  if (!budget.allowed) {
    if (opts.explicit) gh.comment(n, writeFile(outDir, 'budget.md', `The agent loop did not start. ${budget.reason}\n`));
    return { outcome: 'over-budget', reason: budget.reason, stage };
  }

  const claim = claimIssue(gh, n, deps.me, opts.takeUnassigned || opts.explicit, deps.claimSettleMs ?? 3000);
  if (!claim.claimed) return { outcome: 'skipped', reason: claim.reason, stage };

  gh.ensureLabels(allLabels(labelConfig));
  // Removing the trigger labels now means a crash can never make a watcher retry the same issue forever.
  const triggers = [L.ready, L.planApproved, L.planReview, L.prOpen, L.needsHuman];
  gh.editLabels(n, [L.working], triggers.filter((l) => issue.labels.includes(l)));
  if (existingPr?.labels?.includes(L.planApproved)) gh.editPrLabels(existingPr.number, [], [L.planApproved]);
  log(`#${n}: claimed by ${deps.me} for the ${stage} stage. ${budget.reason}`);

  const needsHuman = (text: string): void => {
    gh.editLabels(n, [L.needsHuman], [L.working]);
    gh.comment(n, writeFile(outDir, 'comment.md', text));
  };

  let result: LoopResult | undefined;
  let pushed = false;
  const spent = new Map<string, { model: string; usage: TokenUsage }>();
  try {
    if (stage === 'build' && !existingPr) {
      needsHuman(`There is no open plan pull request on \`${branch}\` to build. Add \`${L.ready}\` to write a new plan.\n`);
      return { outcome: 'needs-human', reason: 'no plan pull request to build', stage };
    }

    const dir = path.join(deps.workRoot, 'work', `issue-${n}`);
    const ws = deps.prepare(dir, labelConfig.setup, stage === 'build' ? branch : null);
    if (ws.rebaseConflicts) {
      needsHuman(
        `The plan branch \`${branch}\` no longer applies to \`${deps.repo.defaultBranch}\`: rebasing it conflicts in ${ws.rebaseConflicts.map((f) => `\`${f}\``).join(', ')}. Nothing was built. Rebase the branch by hand and add \`${L.planApproved}\` again, or add \`${L.ready}\` to write a new plan.\n`,
      );
      log(`#${n}: NEEDS HUMAN: rebase conflict in ${ws.rebaseConflicts.join(', ')}`);
      return { outcome: 'needs-human', reason: 'the plan branch conflicts with the default branch', stage };
    }
    const config = deps.loadConfig(dir);
    const loopOpts: LoopOptions = { stage, diffBase: ws.diffBase };
    if (stage === 'build' && existingPr) {
      loopOpts.lockedTests = ws.changedFiles.filter((f) => matchesAny(f, config.tdd.testFiles));
      const plan = extractPlan(gh.prBody(existingPr));
      if (plan) loopOpts.approvedPlan = plan;
      // Comments older than the branch's last commit were answered by that commit (or by the plan).
      const feedback = gh.prFeedback(existingPr, ws.branchUpdatedAt);
      if (feedback) loopOpts.buildFeedback = feedback;
    }
    if (stage === 'plan' && existingPr) {
      const feedback = gh.prFeedback(existingPr);
      if (feedback) loopOpts.planFeedback = feedback;
    }
    result = deps.loop(toLoopIssue(issue), config, dir, loopOpts, (role, model, usage) => spent.set(role, { model, usage }));

    const loopIssue = toLoopIssue(issue);
    const planReady = result.passed && stage === 'plan';
    const body = !result.passed
      ? renderFailureComment(loopIssue, result, config)
      : planReady
        ? renderPlanPrBody(loopIssue, result, config)
        : renderPrBody(loopIssue, result, config);
    const bodyFile = writeFile(outDir, 'pr-body.md', body);

    let prUrl: string | undefined;
    if (result.commits.length > 0) {
      deps.push(dir, result.branch);
      pushed = true;
      const draft = !result.passed || planReady;
      const title = planReady ? `plan: ${result.prTitle}` : result.prTitle;
      const pr = gh.findOpenPr(result.branch);
      if (pr) {
        gh.updatePr(pr, { title, bodyFile, draft });
        prUrl = pr.url;
      } else {
        prUrl = gh.createPr({ base: deps.repo.defaultBranch, branch: result.branch, title, bodyFile, draft });
      }
    } else if (existingPr) {
      prUrl = existingPr.url;
    }

    if (planReady) {
      gh.editLabels(n, [config.labels.planReview], [L.working]);
      gh.comment(n, writeFile(outDir, 'comment.md', `A plan and failing tests are ready for review: ${prUrl ?? 'no pull request'}\n\nAdd \`${config.labels.planApproved}\` to build it, or comment on the pull request and add \`${config.labels.ready}\` to re-plan.\n`));
      log(`#${n}: PLAN READY ${prUrl ?? ''}`);
      return { outcome: 'plan-ready', reason: 'waiting for plan approval', stage, ...(prUrl ? { prUrl } : {}) };
    }
    if (result.passed) {
      gh.editLabels(n, [config.labels.prOpen], [L.working]);
      log(`#${n}: PASS ${prUrl ?? ''}`);
      return { outcome: 'passed', reason: 'all gates pass', stage, ...(prUrl ? { prUrl } : {}) };
    }
    needsHuman(`${body}\nPull request: ${prUrl ?? 'none (no commits)'}\n`);
    log(`#${n}: NEEDS HUMAN ${prUrl ?? ''}`);
    return { outcome: 'needs-human', reason: result.stopReason ?? 'the run did not pass', stage, ...(prUrl ? { prUrl } : {}) };
  } catch (err) {
    const message = (err as Error).message;
    log(`#${n}: crashed: ${message}`);
    try {
      const what = pushed ? `The branch \`${branch}\` was already pushed, but the pull request and labels may not be up to date.` : 'Nothing was published.';
      needsHuman(`The agent loop crashed before it finished. ${what}\n\n\`\`\`\n${message.slice(0, 3000)}\n\`\`\`\n`);
    } catch (inner) {
      log(`#${n}: could not report the crash on the issue: ${(inner as Error).message}`);
    }
    return { outcome: 'crashed', reason: message, stage };
  } finally {
    // A crash after agent sessions still spent tokens: charge them to the budget.
    const record = result?.record ?? crashRecord(issue, stage, spent, labelConfig, deps.now());
    if (record) {
      try {
        const recordFile = writeRecord(path.join(outDir, 'records'), record);
        deps.ledger.append(recordFile, `ledger: record ${stage} run for #${n}`);
      } catch (err) {
        log(`#${n}: WARN could not write the ledger record: ${(err as Error).message}`);
      }
    }
  }
}

function crashRecord(
  issue: GitHubIssue,
  stage: Stage,
  spent: Map<string, { model: string; usage: TokenUsage }>,
  config: ResolvedAgentConfig,
  now: Date,
): RunRecord | null {
  const entries = [...spent.values()];
  if (entries.length === 0) return null;
  const usage = entries.reduce((acc, e) => addUsage(acc, e.usage), { ...ZERO_USAGE });
  const costs = entries.map((e) => costUsd(e.usage, config.budget.pricing[e.model]));
  const builder = spent.get('builder');
  return {
    schema: 1,
    issue: issue.number,
    title: issue.title,
    labels: issue.labels,
    runner: config.runner,
    model: builder?.model ?? entries[0]?.model ?? config.model,
    startedAt: now.toISOString(),
    finishedAt: now.toISOString(),
    outcome: 'needs-human',
    phases: [],
    usage,
    costUsd: costs.some((c) => c === null) ? null : Math.round(costs.reduce<number>((s, c) => s + (c ?? 0), 0) * 10_000) / 10_000,
    caughtBy: ['crash'],
    firstPass: false,
    stage,
  };
}

export interface WatchTick {
  processed: { issue: number; result: RunIssueResult }[];
  idleReason?: string;
}

/** One poll: runs every claimable issue that is ready to plan or approved to build, oldest first, one at a time. */
export function watchOnce(labelConfig: ResolvedAgentConfig, deps: RunIssueDeps, opts: { takeUnassigned: boolean; shouldStop: () => boolean }): WatchTick {
  const { records } = readRecords(deps.ledger.sync());
  const budget = decideBudget(records, labelConfig.budget, [], deps.now());
  if (budget.mode === 'stopped') return { processed: [], idleReason: budget.reason };

  const L = labelConfig.labels;
  const triggers = labelConfig.plan.approval === 'required' ? [L.ready, L.planApproved] : [L.ready];
  const seen = new Set<number>();
  // Plans approved on their pull request: map the agent branch back to its issue.
  const branchIssue = new RegExp(`^${labelConfig.branchPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}issue-(\\d+)$`);
  const approvedOnPr =
    labelConfig.plan.approval === 'required'
      ? deps.gh
          .listOpenPrs(L.planApproved)
          .map((pr) => Number(branchIssue.exec(pr.headRefName ?? '')?.[1]))
          .filter((num) => Number.isInteger(num) && num > 0)
          .map((num) => deps.gh.getIssue(num))
      : [];
  const candidates = [...triggers.flatMap((label) => deps.gh.listOpenIssues(label)), ...approvedOnPr]
    .filter((i) => !seen.has(i.number) && seen.add(i.number) !== undefined)
    .filter((i) => !i.labels.includes(L.working))
    .filter((i) => (i.assignees.length === 0 ? opts.takeUnassigned : i.assignees.includes(deps.me)))
    .sort((a, b) => a.number - b.number);

  const processed: WatchTick['processed'] = [];
  for (const c of candidates) {
    if (opts.shouldStop()) break;
    processed.push({ issue: c.number, result: runIssue(c.number, labelConfig, deps, { takeUnassigned: opts.takeUnassigned, explicit: false }) });
  }
  return candidates.length === 0 ? { processed, idleReason: 'no ready or approved issues for this watcher' } : { processed };
}
