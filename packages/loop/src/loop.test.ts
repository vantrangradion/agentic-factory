import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAgentConfig, type ResolvedAgentConfig } from './config.js';
import { shellExecutor } from './gates.js';
import { createGitOps } from './git.js';
import type { Issue } from './issue.js';
import { runLoop, type LoopOptions, type LoopResult } from './loop.js';
import type { AgentRunner, AgentRunResult } from './runner.js';

/** A scripted agent: each session runs the next step against the working tree. */
class ScriptedAgent implements AgentRunner {
  readonly name = 'scripted';
  readonly prompts: string[] = [];
  private i = 0;
  constructor(private readonly steps: ((cwd: string) => void | string)[], readonly model = 'test-model') {}
  run(prompt: string, cwd: string): AgentRunResult {
    this.prompts.push(prompt);
    const step = this.steps[this.i++];
    if (!step) throw new Error(`Agent called ${this.i} times; only ${this.steps.length} steps scripted`);
    const reply = step(cwd);
    return { exitCode: 0, response: typeof reply === 'string' ? reply : `Summary: step ${this.i}`, usage: { input: 1000, cachedInput: 200, output: 100, total: 1100, requests: 4 } };
  }
}

const write = (cwd: string, file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), content);
};
const read = (cwd: string, file: string) => fs.readFileSync(path.join(cwd, file), 'utf-8');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

// The test gate passes only when a test exists, it asks for "strict" behaviour, and the feature is done.
const TEST_GATE = 'test -f tests/feature.test.txt && grep -q strict tests/feature.test.txt && grep -q done src/feature.txt';

const ISSUE: Issue = { number: 7, title: 'Add the feature', body: 'The feature file says done.', labels: [] };

function config(overrides: Record<string, unknown> = {}): ResolvedAgentConfig {
  return resolveAgentConfig({
    model: 'test-model',
    gates: [
      { name: 'lint', run: 'true' },
      { name: 'test', run: TEST_GATE },
    ],
    protectedPaths: ['guards/**'],
    maxAttempts: 2,
    budget: { weeklyUsd: 10, pricing: { inputPerMTok: 1, outputPerMTok: 10, cachedInputPerMTok: 0.25 } },
    ...overrides,
  });
}

let repo: string;
const logs: string[] = [];

function loop(agent: ScriptedAgent, cfg = config(), opts: LoopOptions = { stage: 'full' }, reviewer?: ScriptedAgent, issue: Issue = ISSUE): LoopResult {
  return runLoop(issue, cfg, ['AGENTS.md'], {
    runner: agent,
    ...(reviewer ? { reviewRunner: reviewer } : {}),
    git: createGitOps(repo),
    exec: shellExecutor,
    cwd: repo,
    now: () => new Date('2026-11-09T03:00:00Z'),
    log: (m) => logs.push(m),
  }, opts);
}

const writeTests = (cwd: string) => write(cwd, 'tests/feature.test.txt', 'expect strict done\n');
const implement = (cwd: string) => write(cwd, 'src/feature.txt', 'done\n');

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-loop-'));
  git(repo, 'init', '--quiet', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  write(repo, 'AGENTS.md', 'rules\n');
  write(repo, 'guards/rule.ts', 'original guard\n');
  write(repo, '.github/workflows/ci.yml', 'original ci\n');
  git(repo, 'add', '--all');
  git(repo, 'commit', '--quiet', '-m', 'init');
  logs.length = 0;
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('runLoop', () => {
  it('commits failing tests first, then the implementation, on the issue branch', () => {
    const agent = new ScriptedAgent([writeTests, implement]);
    const result = loop(agent);

    expect(result.passed).toBe(true);
    expect(result.branch).toBe('agent/issue-7');
    expect(git(repo, 'branch', '--show-current')).toBe('agent/issue-7');
    expect(git(repo, 'log', '--format=%s', '-2').split('\n')).toEqual([
      'feat: Add the feature (#7)',
      'test: add failing tests for Add the feature (#7)',
    ]);
    expect(result.redRun?.status).toBe('fail');
    expect(result.finalGates.map((g) => g.status)).toEqual(['pass', 'pass']);
    expect(result.record.firstPass).toBe(true);
    expect(result.record.caughtBy).toEqual([]);
    expect(result.record.usage).toEqual({ input: 2000, cachedInput: 400, output: 200, total: 2200, requests: 8 });
    // 1600 fresh * 1 + 400 cached * 0.25 + 200 out * 10, per million tokens.
    expect(result.record.costUsd).toBeCloseTo(0.0037, 6);
    expect(agent.prompts[0]).toContain('write failing tests (red)');
    expect(agent.prompts[1]).toContain('tests/feature.test.txt');
  });

  it('reverts implementation code written during the red phase', () => {
    const agent = new ScriptedAgent([
      (cwd) => {
        writeTests(cwd);
        implement(cwd);
      },
      implement,
    ]);
    const result = loop(agent);

    expect(result.passed).toBe(true);
    expect(result.record.phases[0]?.attempts[0]?.outOfScopeFiles).toEqual(['src/feature.txt']);
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD~1')).toBe('tests/feature.test.txt');
  });

  it('reverts changes to protected paths and reports them', () => {
    const agent = new ScriptedAgent([
      writeTests,
      (cwd) => {
        implement(cwd);
        write(cwd, 'guards/rule.ts', 'weakened guard\n');
        write(cwd, '.github/workflows/ci.yml', 'weakened ci\n');
        write(cwd, 'guards/new-escape.ts', 'escape\n');
      },
    ]);
    const result = loop(agent);

    expect(result.passed).toBe(true);
    expect(read(repo, 'guards/rule.ts')).toBe('original guard\n');
    expect(read(repo, '.github/workflows/ci.yml')).toBe('original ci\n');
    expect(fs.existsSync(path.join(repo, 'guards/new-escape.ts'))).toBe(false);
    expect(result.record.phases[1]?.attempts[0]?.protectedPathViolations).toEqual([
      '.github/workflows/ci.yml',
      'guards/new-escape.ts',
      'guards/rule.ts',
    ]);
    expect(result.record.caughtBy).toEqual(['scope']);
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe('src/feature.txt');
  });

  it('restores weakened red-phase tests without spending a gate run', () => {
    const agent = new ScriptedAgent([
      writeTests,
      // Cheat: weaken the test instead of implementing.
      (cwd) => write(cwd, 'tests/feature.test.txt', 'expect anything\n'),
      implement,
    ]);
    const result = loop(agent);

    expect(result.passed).toBe(true);
    expect(read(repo, 'tests/feature.test.txt')).toBe('expect strict done\n');
    // After the restore nothing else changed, so the gates are skipped.
    expect(result.record.caughtBy).toEqual(['locked-tests', 'no-changes']);
    expect(result.record.firstPass).toBe(false);
    const retryPrompt = agent.prompts[2] ?? '';
    expect(retryPrompt).toContain('attempt 2 of 2');
    expect(retryPrompt).toContain('restored them: tests/feature.test.txt');
  });

  it('feeds the failing gate output back to the next attempt', () => {
    const agent = new ScriptedAgent([
      writeTests,
      (cwd) => {
        write(cwd, 'tests/feature.test.txt', 'expect anything\n');
        write(cwd, 'src/feature.txt', 'wip\n');
      },
      implement,
    ]);
    const result = loop(agent);

    expect(result.passed).toBe(true);
    expect(result.record.caughtBy).toEqual(['locked-tests', 'test']);
    expect(agent.prompts[2]).toContain('Gate "test" failed');
    expect(agent.prompts[2]).toContain(TEST_GATE);
  });

  it('retries when the new tests already pass', () => {
    implement(repo);
    git(repo, 'add', '--all');
    git(repo, 'commit', '--quiet', '-m', 'feature already exists');

    const agent = new ScriptedAgent([writeTests, writeTests]);
    const result = loop(agent);

    expect(result.passed).toBe(false);
    expect(result.record.caughtBy).toEqual(['red-not-failing', 'red-not-failing']);
    expect(result.stopReason).toContain('No failing tests');
    expect(agent.prompts[1]).toContain('do not check the new behaviour');
  });

  it('stops for a human when the gates keep failing', () => {
    const agent = new ScriptedAgent([writeTests, (cwd) => write(cwd, 'src/feature.txt', 'wip\n'), (cwd) => write(cwd, 'src/feature.txt', 'still wip\n')]);
    const result = loop(agent);

    expect(result.passed).toBe(false);
    expect(result.record.outcome).toBe('needs-human');
    expect(result.record.caughtBy).toEqual(['test', 'test']);
    expect(result.commits).toHaveLength(1);
    expect(result.stopReason).toContain('Gates still failing after 2 attempts');
  });

  it('keeps the work but replaces commits the agent made itself', () => {
    const agent = new ScriptedAgent([
      writeTests,
      (cwd) => {
        implement(cwd);
        git(cwd, 'add', '--all');
        git(cwd, 'commit', '--quiet', '-m', 'agent commit with a long body it should not write');
      },
    ]);
    const result = loop(agent);

    expect(result.passed).toBe(true);
    expect(git(repo, 'log', '--format=%s', '-1')).toBe('feat: Add the feature (#7)');
    expect(git(repo, 'log', '--format=%s')).not.toContain('agent commit');
  });

  it('runs a single implement phase when TDD is off', () => {
    const agent = new ScriptedAgent([
      (cwd) => {
        writeTests(cwd);
        implement(cwd);
      },
    ]);
    const result = loop(agent, config({ tdd: { enabled: false }, plan: { approval: 'none' } }));

    expect(result.passed).toBe(true);
    expect(result.record.phases.map((p) => p.phase)).toEqual(['single']);
    expect(result.redRun).toBeUndefined();
    expect(agent.prompts[0]).toContain('implement the issue');
  });

  it('uses a fix prefix for bug issues and keeps the subject short', () => {
    const agent = new ScriptedAgent([writeTests, implement]);
    const result = runLoop(
      { ...ISSUE, title: 'A very long bug title that keeps going and going well past the limit', labels: ['bug'] },
      config(),
      [],
      { runner: agent, git: createGitOps(repo), exec: shellExecutor, cwd: repo, now: () => new Date(), log: () => {} },
    );
    expect(result.prTitle.startsWith('fix: ')).toBe(true);
    expect(result.prTitle.endsWith('(#7)')).toBe(true);
    expect(result.prTitle.length).toBeLessThanOrEqual(72);
  });
});

describe('scope checks added after review', () => {
  it('restores package.json scripts changed in the green phase, so locked tests keep running', () => {
    write(repo, 'package.json', JSON.stringify({ name: 'x', scripts: { test: 'vitest run' } }, null, 2) + '\n');
    git(repo, 'add', '--all');
    git(repo, 'commit', '--quiet', '-m', 'add package.json');
    const agent = new ScriptedAgent([
      writeTests,
      (cwd) => {
        implement(cwd);
        write(cwd, 'package.json', JSON.stringify({ name: 'x', scripts: { test: 'echo skipped' } }, null, 2) + '\n');
      },
    ]);
    const result = loop(agent);

    expect(result.passed).toBe(true);
    expect(JSON.parse(read(repo, 'package.json')).scripts.test).toBe('vitest run');
    expect(result.record.caughtBy).toContain('locked-tests');
  });

  it('stops at once when the agent session was interrupted', () => {
    const agent = new ScriptedAgent([writeTests]);
    const interrupting: AgentRunner = { name: 'i', model: 'test-model', run: (p, c) => ({ ...agent.run(p, c), interrupted: true }) };
    const result = runLoop(ISSUE, config(), [], { runner: interrupting, git: createGitOps(repo), exec: shellExecutor, cwd: repo, now: () => new Date(), log: () => {} });
    expect(result.passed).toBe(false);
    expect(result.stopReason).toContain('Stopped by the user');
    expect(result.commits).toEqual([]);
    expect(agent.prompts).toHaveLength(1);
  });
});

describe('stages', () => {
  it('plan stage stops after the red commit and keeps the plan', () => {
    const agent = new ScriptedAgent([
      (cwd) => {
        writeTests(cwd);
        return 'Approach: write feature.txt\nRisks and open questions: None';
      },
    ]);
    const result = loop(agent, config(), { stage: 'plan' });

    expect(result).toMatchObject({ stage: 'plan', passed: true, lockedTests: ['tests/feature.test.txt'] });
    expect(result.plan).toContain('Approach: write feature.txt');
    expect(result.record.outcome).toBe('plan-ready');
    expect(result.commits).toHaveLength(1);
    expect(fs.existsSync(path.join(repo, 'src/feature.txt'))).toBe(false);
    expect(agent.prompts[0]).toContain('Files to change:');
  });

  it('gives a rejected plan\'s comments to the next red phase', () => {
    const agent = new ScriptedAgent([writeTests]);
    loop(agent, config(), { stage: 'plan', planFeedback: '- chau: cover the empty list' });
    expect(agent.prompts[0]).toContain('A reviewer rejected your previous plan');
    expect(agent.prompts[0]).toContain('cover the empty list');
  });

  it('build stage implements on top of approved tests and keeps them locked', () => {
    writeTests(repo);
    git(repo, 'add', '--all');
    git(repo, 'commit', '--quiet', '-m', 'test: approved red');
    const agent = new ScriptedAgent([
      (cwd) => {
        implement(cwd);
        write(cwd, 'tests/feature.test.txt', 'expect nothing\n');
      },
      implement,
    ]);
    const result = loop(agent, config(), { stage: 'build', lockedTests: ['tests/feature.test.txt'] });

    expect(result).toMatchObject({ stage: 'build', passed: true });
    expect(result.record.phases.map((p) => p.phase)).toEqual(['green']);
    expect(read(repo, 'tests/feature.test.txt')).toBe('expect strict done\n');
    expect(result.record.caughtBy).toEqual(['locked-tests']);
    expect(agent.prompts[0]).toContain('make the tests pass (green)');
  });

  const approveRed = () => {
    writeTests(repo);
    git(repo, 'add', '--all');
    git(repo, 'commit', '--quiet', '-m', 'test: approved red');
  };

  it('build stage follows the approved plan and the new review comments, and keeps the plan for the PR', () => {
    approveRed();
    const agent = new ScriptedAgent([implement]);
    const plan = 'Approach: write the feature file\nFiles to change: src/feature.txt';
    const result = loop(agent, config(), { stage: 'build', lockedTests: ['tests/feature.test.txt'], approvedPlan: plan, buildFeedback: '- tam: say done, not finished' });

    expect(result.passed).toBe(true);
    expect(result.plan).toBe(plan);
    expect(result.unplannedFiles).toBeUndefined();
    expect(result.record.caughtBy).toEqual([]);
    expect(agent.prompts[0]).toContain('## The approved plan');
    expect(agent.prompts[0]).toContain('Files to change: src/feature.txt');
    expect(agent.prompts[0]).toContain('## Review comments to address');
    expect(agent.prompts[0]).toContain('say done, not finished');
    expect(agent.prompts[0]).toContain('never overturns a recorded decision');
  });

  it('flags files the build changed that the approved plan does not name, without reverting them', () => {
    // Seen in a real run: the approved plan kept a table read-only; the build added a column and a migration, and nothing noticed.
    approveRed();
    const agent = new ScriptedAgent([
      (cwd) => {
        implement(cwd);
        write(cwd, 'src/migrations/002-updated-at.sql', 'alter table outbox add updated_at;\n');
      },
    ]);
    const result = loop(agent, config(), { stage: 'build', lockedTests: ['tests/feature.test.txt'], approvedPlan: 'Files to change: src/feature.txt' });

    expect(result.passed).toBe(true);
    expect(result.unplannedFiles).toEqual(['src/migrations/002-updated-at.sql']);
    expect(result.record.unplannedFiles).toEqual(['src/migrations/002-updated-at.sql']);
    expect(result.record.caughtBy).toEqual(['plan-drift']);
    expect(fs.existsSync(path.join(repo, 'src/migrations/002-updated-at.sql'))).toBe(true);
  });

  it('does not show the plan or check drift in a build without an approved plan', () => {
    approveRed();
    const agent = new ScriptedAgent([implement]);
    const result = loop(agent, config(), { stage: 'build', lockedTests: ['tests/feature.test.txt'] });
    expect(result.plan).toBeUndefined();
    expect(agent.prompts[0]).not.toContain('## The approved plan');
    expect(agent.prompts[0]).not.toContain('## Review comments to address');
  });
});

describe('gate output', () => {
  it('rewrites the clone\'s absolute paths before they reach the agent and the PR', () => {
    const cfg = config({ gates: [{ name: 'test', run: 'echo "FAIL $PWD/src/feature.ts:3"; exit 1' }], tdd: { enabled: false }, plan: { approval: 'none' }, maxAttempts: 1 });
    const result = loop(new ScriptedAgent([implement]), cfg);

    expect(result.passed).toBe(false);
    const tailText = result.finalGates[0]?.outputTail ?? '';
    expect(tailText).toContain('FAIL src/feature.ts:3');
    expect(tailText).not.toContain(fs.realpathSync(repo));
  });
});

describe('independent review', () => {
  const reviewed = () => config({ review: { when: 'labelled', labels: ['risky'], model: 'review-model' }, budget: { pricing: { inputPerMTok: 1, outputPerMTok: 10 } } });
  const risky: Issue = { ...ISSUE, labels: ['risky'] };
  const findings = (list: unknown[]) => `Here is my review.\n\`\`\`json\n${JSON.stringify({ findings: list })}\n\`\`\``;

  it('skips the review for issues without a review label', () => {
    const reviewer = new ScriptedAgent([], 'review-model');
    const result = loop(new ScriptedAgent([writeTests, implement]), reviewed(), { stage: 'full' }, reviewer);
    expect(result.review).toBeUndefined();
    expect(reviewer.prompts).toEqual([]);
  });

  it('reviews against the issue and diff, discards reviewer edits, and keeps a passing fix', () => {
    const reviewer = new ScriptedAgent(
      [
        (cwd) => {
          write(cwd, 'src/feature.txt', 'reviewer was here\n');
          return findings([{ kind: 'gap', severity: 'high', file: 'src/feature.txt', summary: 'Missing trailing note', evidence: 'issue says done' }, { kind: 'scope-drift', severity: 'low', summary: 'minor' }]);
        },
      ],
      'review-model',
    );
    const agent = new ScriptedAgent([writeTests, implement, (cwd) => write(cwd, 'src/feature.txt', 'done, with note\n')]);

    const result = loop(agent, reviewed(), { stage: 'full' }, reviewer, risky);

    expect(reviewer.prompts[0]).toContain('The issue below is the source of truth');
    expect(reviewer.prompts[0]).toContain('+done');
    expect(reviewer.prompts[0]).toContain('Summary: step 2');
    expect(result.review).toMatchObject({ model: 'review-model', fixRound: 'kept' });
    expect(result.review?.findings).toHaveLength(2);
    expect(agent.prompts[2]).toContain('Missing trailing note');
    expect(agent.prompts[2]).not.toContain('minor');
    expect(read(repo, 'src/feature.txt')).toBe('done, with note\n');
    expect(git(repo, 'log', '--format=%s', '-1')).toBe('fix: address review findings for Add the feature (#7)');
    expect(result.record.caughtBy).toEqual(['review:gap', 'review:scope-drift']);
    expect(result.record.review).toMatchObject({ findings: { gap: 1, 'scope-drift': 1 }, parsed: true, fixRound: 'kept' });
    expect(result.record.firstPass).toBe(true);
    // 3 builder sessions and 1 review session, each 800 fresh + 200 cached input and 100 output.
    expect(result.record.costUsd).toBeCloseTo((4 * (1000 * 1 + 100 * 10)) / 1_000_000, 6);
  });

  it('discards a fix that breaks a gate and keeps the reviewed version', () => {
    const reviewer = new ScriptedAgent([() => findings([{ kind: 'bug', severity: 'medium', summary: 'off by one', evidence: 'x' }])], 'review-model');
    const agent = new ScriptedAgent([writeTests, implement, (cwd) => write(cwd, 'src/feature.txt', 'broken\n')]);

    const result = loop(agent, reviewed(), { stage: 'full' }, reviewer, risky);

    expect(result.passed).toBe(true);
    expect(result.review).toMatchObject({ fixRound: 'discarded' });
    expect(result.review?.fixNote).toContain('broke gate "test"');
    expect(read(repo, 'src/feature.txt')).toBe('done\n');
    expect(result.finalGates.every((g) => g.status === 'pass')).toBe(true);
  });

  it('records an unusable review answer without failing the run', () => {
    const reviewer = new ScriptedAgent([() => 'Looks good to me!'], 'review-model');
    const result = loop(new ScriptedAgent([writeTests, implement]), reviewed(), { stage: 'full' }, reviewer, risky);
    expect(result.passed).toBe(true);
    expect(result.review).toMatchObject({ findings: null, fixRound: 'none' });
    expect(result.record.review?.parsed).toBe(false);
  });

  it('does not run a fix round for low findings only', () => {
    const reviewer = new ScriptedAgent([() => findings([{ kind: 'scope-drift', severity: 'low', summary: 'tiny' }])], 'review-model');
    const agent = new ScriptedAgent([writeTests, implement]);
    const result = loop(agent, reviewed(), { stage: 'full' }, reviewer, risky);
    expect(result.review?.fixRound).toBe('none');
    expect(agent.prompts).toHaveLength(2);
  });
});
