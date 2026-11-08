import * as fs from 'node:fs';
import * as path from 'node:path';
import { wantsReview, type ResolvedAgentConfig, type ResolvedGate } from './config.js';
import { firstFailure, runGates, type CommandExecutor, type GateResult } from './gates.js';
import type { GitOps } from './git.js';
import { matchesAny } from './glob.js';
import type { Issue } from './issue.js';
import { costUsd, type AttemptRecord, type PhaseRecord, type ReviewRecord, type RunRecord, type Stage } from './ledger.js';
import { buildPrompt, type Phase } from './prompt.js';
import { buildReviewPrompt, describeFindings, isActionable, parseFindings, type Finding } from './review.js';
import { addUsage, ZERO_USAGE, type AgentRunner, type AgentRunResult, type TokenUsage } from './runner.js';
import type { GateRunner } from './sandbox.js';

export interface LoopDeps {
  runner: AgentRunner;
  git: GitOps;
  exec: CommandExecutor;
  /** Runs a gate ladder. Default: each gate on the host in `cwd` with `exec`. */
  runGates?: GateRunner;
  cwd: string;
  now: () => Date;
  log: (message: string) => void;
  /** Checked before each attempt; true ends the run as needs-human. */
  shouldStop?: () => boolean;
  /** Runner for the independent review. Default: `runner`. */
  reviewRunner?: AgentRunner;
  /** Called after every agent session with the usage so far, so a crash can still be charged to the budget. */
  onUsage?: (role: 'builder' | 'reviewer', model: string, usage: TokenUsage) => void;
}

export interface LoopOptions {
  /**
   * "full": red then green in one run. "plan": red only, then stop for a
   * person to approve the plan. "build": green only, on a branch whose red
   * commit was approved; HEAD must be that branch.
   */
  stage: Stage;
  /** For "build": the approved tests, which the agent may not change. */
  lockedTests?: string[];
  /** For "plan": a person's comments on a rejected earlier plan. */
  planFeedback?: string;
  /** Commit the review diff starts from. Default: HEAD when the run starts. */
  diffBase?: string;
}

export interface ReviewOutcome {
  model: string;
  usage: TokenUsage;
  /** Null when the reviewer gave no usable answer. */
  findings: Finding[] | null;
  fixRound: 'none' | 'kept' | 'discarded';
  fixNote?: string;
}

export interface LoopResult {
  stage: Stage;
  /** The stage succeeded: for "plan", the plan is ready for review; otherwise every gate passes. */
  passed: boolean;
  branch: string;
  commits: string[];
  prTitle: string;
  /** The agent's final summary from the last phase that ran. */
  summary: string;
  /** The red phase's reply, which holds the plan. */
  plan?: string;
  /** Tests fixed by the red phase (or the approved plan). */
  lockedTests?: string[];
  review?: ReviewOutcome;
  /** The red gate run that proved the tests failed first. */
  redRun?: GateResult;
  /** The gate results of the last attempt. */
  finalGates: GateResult[];
  /** Why the run stopped, when it did not pass. */
  stopReason?: string;
  record: RunRecord;
}

const SUBJECT_MAX = 72;
const STOPPED = 'Stopped by the user before the run finished.';

function subject(prefix: string, title: string, issue: number): string {
  const suffix = ` (#${issue})`;
  const room = SUBJECT_MAX - prefix.length - suffix.length;
  const t = title.length > room ? `${title.slice(0, Math.max(0, room - 3)).trimEnd()}...` : title;
  return `${prefix}${t}${suffix}`;
}

/**
 * Agents link files with absolute local URLs (file:///home/.../repo/src/a.ts#L1).
 * Those leak the machine's paths into public pull requests and do not resolve
 * on GitHub, so they become repository-relative code spans.
 */
export function localPathsToRelative(text: string, cwd: string): string {
  const root = cwd.replace(/\/$/, '');
  const rel = (target: string): string => target.replace(/^file:\/\//, '').split(root + '/').join('').replace(/#.*$/, '');
  return text
    .replace(/\[([^\]]+)\]\((file:\/\/[^)\s]+)\)/g, (_m, label: string, target: string) => {
      const file = rel(target);
      const name = label.replace(/^`|`$/g, '');
      return name === file || file.endsWith(`/${name}`) ? `\`${file}\`` : `${label} (\`${file}\`)`;
    })
    .split(`file://${root}/`).join('')
    .split(`${root}/`).join('');
}

/** True when a package.json's "scripts" differ from the version at `ref`: changing them could stop the locked tests from running. */
function scriptsChanged(before: string | null, afterPath: string): boolean {
  const scripts = (text: string | null): string => {
    if (text === null) return 'absent';
    try {
      return JSON.stringify((JSON.parse(text) as Record<string, unknown>)['scripts'] ?? null);
    } catch {
      return 'unparseable';
    }
  };
  const after = fs.existsSync(afterPath) ? fs.readFileSync(afterPath, 'utf-8') : null;
  return scripts(before) !== scripts(after);
}

function fence(text: string): string {
  return `\`\`\`\n${text.replace(/```/g, "'''")}\n\`\`\``;
}

interface ScopeResult {
  protectedPathViolations: string[];
  lockedTestEdits: string[];
  outOfScopeFiles: string[];
}

export function runLoop(
  issue: Issue,
  config: ResolvedAgentConfig,
  contextFiles: string[],
  deps: LoopDeps,
  opts: LoopOptions = { stage: 'full' },
): LoopResult {
  if (opts.stage !== 'full' && !config.tdd.enabled) throw new Error(`Stage "${opts.stage}" needs tdd.enabled`);
  const { runner, git, exec, cwd, log } = deps;
  const ladder = (gates: readonly ResolvedGate[]): GateResult[] => (deps.runGates ? deps.runGates(gates, cwd) : runGates(gates, cwd, exec));
  const startedAt = deps.now().toISOString();
  const isBug = issue.labels.some((l) => config.budget.bugLabels.includes(l));
  const branch = `${config.branchPrefix}issue-${issue.number}`;
  const prTitle = subject(isBug ? 'fix: ' : 'feat: ', issue.title || `issue ${issue.number}`, issue.number);

  git.createBranch(branch);
  const base = git.head();
  const diffBase = opts.diffBase ?? base;

  let usage = { ...ZERO_USAGE };
  const caughtBy: string[] = [];
  const phases: PhaseRecord[] = [];
  const commits: string[] = [];
  let summary = '';
  let redRun: GateResult | undefined;
  let finalGates: GateResult[] = [];
  let lockedTests: string[] = opts.stage === 'build' ? [...(opts.lockedTests ?? [])] : [];
  let stopReason: string | undefined;
  let plan: string | undefined;
  let review: ReviewOutcome | undefined;

  const session = (phase: Phase, attempt: number, feedback: string | undefined): AgentRunResult => {
    log(`[${phase}] attempt ${attempt} of ${config.maxAttempts}: starting agent session`);
    const prompt = buildPrompt({
      issue,
      phase,
      config,
      contextFiles,
      attempt,
      ...(feedback !== undefined ? { feedback } : {}),
      ...(phase === 'green' ? { lockedTests } : {}),
      ...(phase === 'red' && opts.planFeedback ? { planFeedback: opts.planFeedback } : {}),
    });
    const raw = runner.run(prompt, cwd);
    const res = { ...raw, response: localPathsToRelative(raw.response, cwd) };
    usage = addUsage(usage, res.usage);
    deps.onUsage?.('builder', runner.model, usage);
    log(`[${phase}] agent finished: exit ${res.exitCode}, ${res.usage.total} tokens${res.error ? `, error: ${res.error}` : ''}`);
    return res;
  };

  /** Undoes anything the agent was not allowed to do, relative to `ref`. */
  const enforceScope = (ref: string, phase: Phase): ScopeResult => {
    if (git.head() !== ref) {
      log(`[${phase}] agent made its own commits; moving HEAD back and keeping the changes`);
      git.resetSoft(ref);
    }
    const changed = git.changedFiles(ref);
    const protectedPathViolations = changed.filter((f) => matchesAny(f, config.protectedPaths));
    const rest = changed.filter((f) => !protectedPathViolations.includes(f));
    const outOfScopeFiles = phase === 'red' ? rest.filter((f) => !matchesAny(f, config.tdd.testFiles)) : [];
    const lockedTestEdits =
      phase === 'green'
        ? rest.filter((f) => lockedTests.includes(f) || (path.basename(f) === 'package.json' && scriptsChanged(git.showFile(ref, f), path.join(cwd, f))))
        : [];
    const revert = [...protectedPathViolations, ...outOfScopeFiles, ...lockedTestEdits];
    if (revert.length > 0) {
      log(`[${phase}] reverting ${revert.length} file(s) the agent may not change: ${revert.join(', ')}`);
      git.restore(ref, revert);
    }
    if (protectedPathViolations.length > 0) caughtBy.push('scope');
    if (lockedTestEdits.length > 0) caughtBy.push('locked-tests');
    return { protectedPathViolations, lockedTestEdits, outOfScopeFiles };
  };

  const scopeNotes = (s: ScopeResult): string[] => {
    const notes: string[] = [];
    if (s.protectedPathViolations.length > 0) {
      notes.push(`You changed protected files, so the loop reverted them: ${s.protectedPathViolations.join(', ')}. Do not touch them again.`);
    }
    if (s.outOfScopeFiles.length > 0) {
      notes.push(`In this step only test files may change, so the loop reverted: ${s.outOfScopeFiles.join(', ')}.`);
    }
    if (s.lockedTestEdits.length > 0) {
      notes.push(`You edited tests that are fixed for this issue, so the loop restored them: ${s.lockedTestEdits.join(', ')}. Change the implementation, not the tests.`);
    }
    return notes;
  };

  const attemptRecord = (attempt: number, res: AgentRunResult, gates: GateResult[], scope: ScopeResult, failure?: string): AttemptRecord => ({
    attempt,
    agentExitCode: res.exitCode,
    ...(res.error !== undefined ? { agentError: res.error } : {}),
    usage: res.usage,
    ...(res.toolCalls ? { toolCalls: res.toolCalls } : {}),
    gates: gates.map((g) => ({ name: g.name, status: g.status, durationMs: g.durationMs })),
    ...scope,
    ...(failure !== undefined ? { failure } : {}),
  });

  // Red phase: tests only, and they must fail.
  let ref = base;
  if (config.tdd.enabled && opts.stage !== 'build') {
    const redGate = config.gates.find((g) => g.name === config.tdd.redGate);
    if (!redGate) throw new Error(`Red gate "${config.tdd.redGate}" not found`);
    const phase: PhaseRecord = { phase: 'red', passed: false, attempts: [] };
    phases.push(phase);
    let feedback: string | undefined;

    for (let attempt = 1; attempt <= config.maxAttempts && !phase.passed; attempt++) {
      if (deps.shouldStop?.()) {
        stopReason = STOPPED;
        break;
      }
      const res = session('red', attempt, feedback);
      const scope = enforceScope(base, 'red');
      if (res.interrupted || deps.shouldStop?.()) {
        stopReason = STOPPED;
        phase.attempts.push(attemptRecord(attempt, res, [], scope, 'stopped'));
        break;
      }
      const notes = scopeNotes(scope);
      if (res.error) notes.unshift(`The agent session reported an error: ${res.error}`);
      const tests = git.changedFiles(base).filter((f) => matchesAny(f, config.tdd.testFiles));

      if (tests.length === 0) {
        caughtBy.push(res.error ? 'agent-error' : 'no-tests');
        notes.push('No test files were added or changed. Write the failing tests for this issue.');
        phase.attempts.push(attemptRecord(attempt, res, [], scope, 'no-tests'));
        feedback = notes.join('\n\n');
        continue;
      }

      const redResults = ladder([redGate]);
      const gate = redResults.find((r) => r.name === redGate.name);
      if (!gate) throw new Error('Red gate produced no result');
      if (deps.shouldStop?.()) {
        stopReason = STOPPED;
        phase.attempts.push(attemptRecord(attempt, res, [gate], scope, 'stopped'));
        break;
      }
      // Late writes (a background process, a test) must not reach the commit.
      enforceScope(base, 'red');
      const blocked = firstFailure(redResults);
      if (gate.status === 'skipped' && blocked) {
        // Setup failed, so the tests never ran: that is not proof they fail.
        caughtBy.push(blocked.name);
        notes.push(`"${blocked.name}" failed (\`${blocked.command}\`, exit code ${blocked.exitCode}), so the tests did not run. Last lines of its output:\n${fence(blocked.outputTail)}`);
        phase.attempts.push(attemptRecord(attempt, res, redResults, scope, `gate:${blocked.name}`));
        feedback = notes.join('\n\n');
        continue;
      }
      if (gate.status === 'pass') {
        caughtBy.push('red-not-failing');
        notes.push(
          `The tests pass already (\`${gate.command}\` exited 0), so they do not check the new behaviour. Make them describe what the issue asks for, which does not exist yet.`,
        );
        phase.attempts.push(attemptRecord(attempt, res, [gate], scope, 'red-not-failing'));
        feedback = notes.join('\n\n');
        continue;
      }

      const sha = git.commitAll(subject('test: add failing tests for ', issue.title || `issue ${issue.number}`, issue.number));
      if (sha) commits.push(sha);
      ref = sha ?? base;
      lockedTests = tests;
      redRun = gate;
      summary = res.response;
      plan = res.response;
      phase.passed = true;
      phase.attempts.push(attemptRecord(attempt, res, [gate], scope));
      log(`[red] tests fail as expected; committed ${tests.length} test file(s)`);
    }
    if (!phase.passed && !stopReason) stopReason = `No failing tests after ${config.maxAttempts} attempts.`;
  }

  // Green phase (or a single phase when TDD is off): every gate must pass.
  if (!stopReason && opts.stage !== 'plan') {
    const phaseName: Phase = config.tdd.enabled ? 'green' : 'single';
    const phase: PhaseRecord = { phase: phaseName, passed: false, attempts: [] };
    phases.push(phase);
    let feedback: string | undefined;

    for (let attempt = 1; attempt <= config.maxAttempts && !phase.passed; attempt++) {
      if (deps.shouldStop?.()) {
        stopReason = STOPPED;
        break;
      }
      const res = session(phaseName, attempt, feedback);
      const scope = enforceScope(ref, phaseName);
      if (res.interrupted || deps.shouldStop?.()) {
        stopReason = STOPPED;
        phase.attempts.push(attemptRecord(attempt, res, [], scope, 'stopped'));
        break;
      }
      const notes = scopeNotes(scope);
      if (res.error) notes.unshift(`The agent session reported an error: ${res.error}`);

      if (git.changedFiles(ref).length === 0) {
        caughtBy.push(res.error ? 'agent-error' : 'no-changes');
        notes.push('No files changed. Implement the issue.');
        phase.attempts.push(attemptRecord(attempt, res, [], scope, 'no-changes'));
        feedback = notes.join('\n\n');
        continue;
      }

      const gates = ladder(config.gates);
      finalGates = gates;
      if (deps.shouldStop?.()) {
        stopReason = STOPPED;
        phase.attempts.push(attemptRecord(attempt, res, gates, scope, 'stopped'));
        break;
      }
      const failed = firstFailure(gates);
      if (failed) {
        caughtBy.push(failed.name);
        notes.push(
          `Gate "${failed.name}" failed (\`${failed.command}\`, exit code ${failed.exitCode}). Last lines of its output:\n${fence(failed.outputTail)}`,
        );
        phase.attempts.push(attemptRecord(attempt, res, gates, scope, `gate:${failed.name}`));
        feedback = notes.join('\n\n');
        log(`[${phaseName}] gate "${failed.name}" failed`);
        continue;
      }

      // Late writes (a background process, a test) must not reach the commit.
      const late = enforceScope(ref, phaseName);
      scope.protectedPathViolations.push(...late.protectedPathViolations);
      scope.lockedTestEdits.push(...late.lockedTestEdits);
      const sha = git.commitAll(prTitle);
      if (sha) commits.push(sha);
      summary = res.response;
      phase.passed = true;
      phase.attempts.push(attemptRecord(attempt, res, gates, scope));
      log(`[${phaseName}] all gates pass; committed`);
    }
    if (!phase.passed && !stopReason) stopReason = `Gates still failing after ${config.maxAttempts} attempts.`;
  }

  // Independent review, by exception. Advisory: it can add one fix round but never fails the run.
  const greenPassed = !stopReason && opts.stage !== 'plan';
  if (greenPassed && wantsReview(issue.labels, config) && !deps.shouldStop?.()) {
    const reviewer = deps.reviewRunner ?? runner;
    const headBefore = git.head();
    log(`[review] starting independent review with ${reviewer.model}`);
    const rawReview = reviewer.run(buildReviewPrompt({ issue, diff: git.diff(diffBase), gates: finalGates, claims: summary, contextFiles }), cwd);
    const res = { ...rawReview, response: localPathsToRelative(rawReview.response, cwd) };
    deps.onUsage?.('reviewer', reviewer.model, res.usage);
    if (git.head() !== headBefore) git.resetSoft(headBefore);
    const touched = git.changedFiles(headBefore);
    if (touched.length > 0) {
      log(`[review] discarding ${touched.length} file(s) the reviewer changed`);
      git.restore(headBefore, touched);
    }
    const findings = parseFindings(res.response);
    for (const f of findings ?? []) caughtBy.push(`review:${f.kind}`);
    review = { model: reviewer.model, usage: res.usage, findings, fixRound: 'none' };
    log(`[review] ${findings === null ? 'no usable answer' : `${findings.length} finding(s)`}`);

    const actionable = (findings ?? []).filter(isActionable);
    if (actionable.length > 0 && config.review.maxFixRounds >= 1 && !deps.shouldStop?.()) {
      const phase: PhaseRecord = { phase: 'fix', passed: false, attempts: [] };
      phases.push(phase);
      const fixRes = session(
        'green',
        1,
        `An independent reviewer found these problems after all gates passed. Fix each one that is real. If you disagree with one, leave the code and explain why in Notes.\n\n${describeFindings(actionable)}`,
      );
      const scope = enforceScope(headBefore, 'green');
      if (git.changedFiles(headBefore).length === 0) {
        review.fixRound = 'discarded';
        review.fixNote = 'The agent changed nothing in the fix round.';
        phase.attempts.push(attemptRecord(1, fixRes, [], scope, 'no-changes'));
      } else {
        const gates = ladder(config.gates);
        const failed = firstFailure(gates);
        if (failed) {
          git.restore(headBefore, git.changedFiles(headBefore));
          review.fixRound = 'discarded';
          review.fixNote = `The fix broke gate "${failed.name}", so it was discarded and the reviewed version kept.`;
          phase.attempts.push(attemptRecord(1, fixRes, gates, scope, `gate:${failed.name}`));
        } else {
          enforceScope(headBefore, 'green');
          const sha = git.commitAll(subject('fix: address review findings for ', issue.title || `issue ${issue.number}`, issue.number));
          if (sha) commits.push(sha);
          finalGates = gates;
          phase.passed = true;
          review.fixRound = 'kept';
          review.fixNote = `${fixRes.response.trim()}`;
          phase.attempts.push(attemptRecord(1, fixRes, gates, scope));
        }
      }
      log(`[review] fix round ${review.fixRound}`);
    }
  }

  const passed = stopReason === undefined;
  const reviewRecord: ReviewRecord | undefined = review
    ? {
        model: review.model,
        usage: review.usage,
        findings: (review.findings ?? []).reduce<Record<string, number>>((acc, f) => ({ ...acc, [f.kind]: (acc[f.kind] ?? 0) + 1 }), {}),
        parsed: review.findings !== null,
        fixRound: review.fixRound,
      }
    : undefined;
  const builderCost = costUsd(usage, config.budget.pricing[runner.model]);
  const reviewCost = review ? costUsd(review.usage, config.budget.pricing[review.model]) : 0;
  const record: RunRecord = {
    schema: 1,
    issue: issue.number,
    title: issue.title,
    labels: issue.labels,
    runner: runner.name,
    model: runner.model,
    startedAt,
    finishedAt: deps.now().toISOString(),
    outcome: !passed ? 'needs-human' : opts.stage === 'plan' ? 'plan-ready' : 'passed',
    phases,
    usage,
    costUsd: builderCost === null || reviewCost === null ? null : Math.round((builderCost + reviewCost) * 10_000) / 10_000,
    caughtBy,
    firstPass: passed && phases.filter((p) => p.phase !== 'fix').every((p) => p.attempts.length === 1),
    stage: opts.stage,
    ...(reviewRecord ? { review: reviewRecord } : {}),
  };

  return {
    stage: opts.stage,
    passed,
    branch,
    commits,
    prTitle,
    summary,
    ...(plan !== undefined ? { plan } : {}),
    ...(lockedTests.length > 0 ? { lockedTests } : {}),
    ...(review ? { review } : {}),
    ...(redRun ? { redRun } : {}),
    finalGates,
    ...(stopReason ? { stopReason } : {}),
    record,
  };
}
