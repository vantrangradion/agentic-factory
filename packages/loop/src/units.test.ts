import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideBudget, weekLabel, weekStart } from './budget.js';
import { AgentConfigError, modelFor, resolveAgentConfig, wantsReview } from './config.js';
import { parseFindings } from './review.js';
import { runGates, tail, type CommandExecutor } from './gates.js';
import { matchesAny } from './glob.js';
import { parseIssue } from './issue.js';
import { readRecords, writeRecord, type RunRecord } from './ledger.js';
import { buildPrompt } from './prompt.js';
import { renderBudgetReport } from './render.js';
import { parseAntigravityJson, parseAntigravityStream } from './runner.js';
import { formatTraceEvent, toolTarget } from './trace.js';
import { localPathsToRelative } from './paths.js';
import { extractPlan, planNamesNoRisks, unplannedFiles, wrapPlan } from './plan.js';

const base = { model: 'm', gates: [{ name: 'test', run: 'pnpm test' }] };

describe('matchesAny', () => {
  it.each([
    ['packages/a/src/x.test.ts', ['**/*.test.*'], true],
    ['x.test.ts', ['**/*.test.*'], true],
    ['src/x.ts', ['**/*.test.*'], false],
    ['e2e/flows/setup.spec.ts', ['e2e'], true],
    ['e2e/flows/setup.spec.ts', ['e2e/'], true],
    ['e2e-helpers/a.ts', ['e2e'], false],
    ['.github/workflows/ci.yml', ['.github/**'], true],
    ['.factoryrc.json', ['.factoryrc.json'], true],
    ['tests/test_api.py', ['**/test_*.py'], true],
    ['a/b.c', ['a/?.c'], true],
  ])('%s against %j is %s', (file, globs, expected) => {
    expect(matchesAny(file, globs)).toBe(expected);
  });
});

describe('resolveAgentConfig', () => {
  it('applies defaults and always protects the config and CI', () => {
    const c = resolveAgentConfig({ ...base, protectedPaths: ['e2e/**'] });
    expect(c.labels.ready).toBe('agent:ready');
    expect(c.maxAttempts).toBe(3);
    expect(c.tdd).toMatchObject({ enabled: true, redGate: 'test' });
    expect(c.protectedPaths).toEqual(expect.arrayContaining(['.factoryrc.json', '.github/**', 'e2e/**']));
    expect(c.budget.weeklyUsd).toBeNull();
    expect(c.runner).toBe('antigravity-cli');
  });

  it('lists every problem at once', () => {
    try {
      resolveAgentConfig({ gates: [{ name: 'lint', run: 'x' }, { name: 'lint', run: 'y' }], budget: { weeklyUsd: 5 } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AgentConfigError);
      const problems = (err as AgentConfigError).problems.join('\n');
      expect(problems).toContain('model is required');
      expect(problems).toContain('unique');
      expect(problems).toContain('tdd.redGate "test"');
      expect(problems).toContain('budget.pricing is required');
    }
  });

  it('uses the input price for cached tokens when no cached price is given', () => {
    const c = resolveAgentConfig({ ...base, budget: { weeklyUsd: 5, pricing: { inputPerMTok: 2, outputPerMTok: 8 } } });
    expect(c.budget.pricing['m']?.cachedInputPerMTok).toBe(2);
  });
});

describe('plan and review config', () => {
  it('requires plan approval and labelled review by default', () => {
    const c = resolveAgentConfig(base);
    expect(c.plan.approval).toBe('required');
    expect(c.review).toEqual({ when: 'labelled', labels: ['risky', 'security'], model: null, maxFixRounds: 1 });
    expect(c.labels).toMatchObject({ planReview: 'agent:plan-review', planApproved: 'agent:plan-approved' });
  });

  it('rejects plan approval without TDD, and bad review settings', () => {
    expect(() => resolveAgentConfig({ ...base, tdd: { enabled: false } })).toThrow('plan.approval "required" needs tdd.enabled');
    expect(() => resolveAgentConfig({ ...base, review: { maxFixRounds: 2 } })).toThrow('review.maxFixRounds must be 0 or 1');
  });

  it('needs a price for the reviewer model when a cap is set', () => {
    expect(() =>
      resolveAgentConfig({ ...base, review: { model: 'rev' }, budget: { weeklyUsd: 5, pricing: { m: { inputPerMTok: 1, outputPerMTok: 1 } } } }),
    ).toThrow('budget.pricing has no price for: rev');
  });

  it('decides which issues get reviewed', () => {
    expect(wantsReview(['risky'], resolveAgentConfig(base))).toBe(true);
    expect(wantsReview(['bug'], resolveAgentConfig(base))).toBe(false);
    expect(wantsReview([], resolveAgentConfig({ ...base, review: { when: 'always' } }))).toBe(true);
    expect(wantsReview(['risky'], resolveAgentConfig({ ...base, review: { when: 'never' } }))).toBe(false);
  });
});

describe('parseFindings', () => {
  it('reads a fenced JSON block and drops malformed findings', () => {
    const text = 'Review:\n```json\n{"findings":[{"kind":"gap","severity":"high","file":"a.ts","summary":"x","evidence":"y"},{"kind":"style","summary":"nit"},{"kind":"bug","summary":"z"}]}\n```';
    expect(parseFindings(text)).toEqual([
      { kind: 'gap', severity: 'high', file: 'a.ts', summary: 'x', evidence: 'y' },
      { kind: 'bug', severity: 'medium', summary: 'z', evidence: '' },
    ]);
  });

  it('tells "no findings" apart from "no answer"', () => {
    expect(parseFindings('{"findings": []}')).toEqual([]);
    expect(parseFindings('Looks fine to me.')).toBeNull();
  });
});

describe('model routing', () => {
  const routed = {
    ...base,
    model: 'big',
    routes: [
      { labels: ['chore', 'docs'], model: 'small' },
      { labels: ['bug'], model: 'medium' },
    ],
  };

  it('picks the first route with a matching label, else the default', () => {
    const c = resolveAgentConfig(routed);
    expect(modelFor(['docs'], c)).toBe('small');
    expect(modelFor(['bug', 'chore'], c)).toBe('small');
    expect(modelFor(['bug'], c)).toBe('medium');
    expect(modelFor(['enhancement'], c)).toBe('big');
    expect(modelFor([], c)).toBe('big');
  });

  it('applies one price to every routed model', () => {
    const c = resolveAgentConfig({ ...routed, budget: { weeklyUsd: 5, pricing: { inputPerMTok: 1, outputPerMTok: 2 } } });
    expect(Object.keys(c.budget.pricing).sort()).toEqual(['big', 'medium', 'small']);
  });

  it('accepts a price per model and names any model without one', () => {
    const c = resolveAgentConfig({
      ...routed,
      budget: {
        pricing: {
          big: { inputPerMTok: 2, outputPerMTok: 12 },
          small: { inputPerMTok: 0.3, outputPerMTok: 2.5, cachedInputPerMTok: 0.03 },
          medium: { inputPerMTok: 1, outputPerMTok: 5 },
        },
      },
    });
    expect(c.budget.pricing['small']).toEqual({ inputPerMTok: 0.3, outputPerMTok: 2.5, cachedInputPerMTok: 0.03 });

    expect(() =>
      resolveAgentConfig({ ...routed, budget: { weeklyUsd: 5, pricing: { big: { inputPerMTok: 2, outputPerMTok: 12 } } } }),
    ).toThrow('budget.pricing has no price for: small, medium');
  });

  it('rejects a route without labels or model', () => {
    expect(() => resolveAgentConfig({ ...base, routes: [{ labels: [], model: '' }] })).toThrow(/routes\[0\]\.model is required[\s\S]*routes\[0\]\.labels/);
  });
});

describe('budget', () => {
  const rec = (finishedAt: string, costUsd: number): RunRecord => ({
    schema: 1, issue: 1, title: 't', labels: [], runner: 'r', model: 'm', startedAt: finishedAt, finishedAt,
    outcome: 'passed', phases: [], usage: { input: 0, cachedInput: 0, output: 0, total: 0, requests: 0 }, costUsd, caughtBy: [], firstPass: true,
  });
  const budget = resolveAgentConfig({ ...base, budget: { weeklyUsd: 100, utcOffset: '+07:00', pricing: { inputPerMTok: 1, outputPerMTok: 1 } } }).budget;

  it('finds Monday 00:00 in the configured offset', () => {
    // Sunday 2026-11-08 20:00 UTC is Monday 03:00 at +07:00.
    expect(weekStart(new Date('2026-11-08T20:00:00Z'), '+07:00').toISOString()).toBe('2026-11-08T17:00:00.000Z');
    expect(weekStart(new Date('2026-11-08T16:00:00Z'), '+07:00').toISOString()).toBe('2026-11-01T17:00:00.000Z');
  });

  it('labels a week by its local Monday', () => {
    expect(weekLabel(new Date('2026-11-07T08:00:00Z'), '+07:00')).toBe('2026-11-02');
    expect(weekLabel(new Date('2026-11-08T20:00:00Z'), '+07:00')).toBe('2026-11-09');
  });

  it('runs everything below the bug-only line and ignores last week', () => {
    const d = decideBudget([rec('2026-11-01T10:00:00Z', 500), rec('2026-11-09T01:00:00Z', 50)], budget, [], new Date('2026-11-10T00:00:00Z'));
    expect(d).toMatchObject({ mode: 'full', allowed: true, spentUsd: 50 });
  });

  it('allows only bug issues between 80% and 100%', () => {
    const records = [rec('2026-11-09T01:00:00Z', 85)];
    const now = new Date('2026-11-10T00:00:00Z');
    expect(decideBudget(records, budget, ['enhancement'], now)).toMatchObject({ mode: 'bugs-only', allowed: false });
    expect(decideBudget(records, budget, ['bug'], now)).toMatchObject({ mode: 'bugs-only', allowed: true });
  });

  it('stops at the cap', () => {
    const d = decideBudget([rec('2026-11-09T01:00:00Z', 100)], budget, ['bug'], new Date('2026-11-10T00:00:00Z'));
    expect(d).toMatchObject({ mode: 'stopped', allowed: false });
    expect(d.reason).toContain('Monday');
  });

  it('is unlimited without a cap', () => {
    expect(decideBudget([], resolveAgentConfig(base).budget, [], new Date()).mode).toBe('unlimited');
  });
});

describe('parseAntigravityJson', () => {
  it('reads the real agy 1.5.2 output shape', () => {
    // Captured from: agy -p ... --model gemini-4-argon --output-format json
    const out =
      '{"conversation_id":"a72ba9e9","status":"SUCCESS","response":"ok\\n","duration_seconds":5.37,"num_turns":1,' +
      '"usage":{"input_tokens":7886,"output_tokens":31,"thinking_tokens":26,"cache_read_tokens":0,"total_tokens":7917}}';
    expect(parseAntigravityJson(out)).toEqual({
      response: 'ok\n',
      usage: { input: 7886, cachedInput: 0, output: 31, total: 7917, requests: 1 },
    });
  });

  it('reports a non-success status as an error', () => {
    const out = JSON.stringify({ status: 'ERROR', response: '', num_turns: 3, usage: { input_tokens: 10, output_tokens: 1 } });
    expect(parseAntigravityJson(out)).toMatchObject({ error: 'Agent status ERROR', usage: { requests: 3, total: 11 } });
  });

  it('reports output that is not JSON', () => {
    expect(parseAntigravityJson('hang').error).toBe('Agent output was not JSON');
  });

  it('counts cache reads as input, as the first real run showed agy reports them separately', () => {
    // From issue #14's first run: 75,713 fresh plus 607,859 cached input tokens.
    const out = JSON.stringify({ status: 'SUCCESS', response: 'ok', num_turns: 1, usage: { input_tokens: 75713, output_tokens: 11932, cache_read_tokens: 607859, total_tokens: 87645 } });
    expect(parseAntigravityJson(out).usage).toEqual({ input: 683572, cachedInput: 607859, output: 11932, total: 695504, requests: 1 });
  });


  it('treats an early finish as an error, keeping the partial reply and usage', () => {
    const out = JSON.stringify({ status: 'SUCCESS', response: 'half', finished_reason: 'print_timeout', num_turns: 9, usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 } });
    expect(parseAntigravityJson(out)).toEqual({
      response: 'half',
      usage: { input: 50, cachedInput: 0, output: 5, total: 55, requests: 9 },
      error: 'Agent stopped early (print_timeout); its reply is partial',
    });
  });
});

// Captured from a real agy 1.5.3 stream-json run that read one file.
const REAL_STREAM = [
  '{"event":"init","conversation_id":"c","init":{"model":"gemini-3.8-flash-low","cwd":"/w","tools":["ask_custom_permission"],"permission_mode":"always-proceed"}}',
  '{"event":"step_update","step_update":{"conversation_id":"c","step_index":0,"state":"DONE","step_type":"user_input"}}',
  '{"event":"step_update","step_update":{"conversation_id":"c","step_index":1,"state":"DONE","step_type":"agent_response","duration_seconds":2.9,"usage":{"input_tokens":7094,"output_tokens":87,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":7181}}}',
  '{"event":"step_update","step_update":{"conversation_id":"c","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"read_file","tool_info":{"name":"read_file","parameters":"{\\"Path\\":\\"/w/note.txt\\"}"}}}',
  '{"event":"step_update","step_update":{"conversation_id":"c","step_index":2,"state":"DONE","step_type":"tool","tool_name":"read_file","duration_seconds":0.24,"tool_info":{"name":"read_file","parameters":"{\\"Path\\":\\"/w/note.txt\\"}","output":"1 lines, 17 bytes"}}}',
  '{"event":"step_update","step_update":{"conversation_id":"c","step_index":3,"state":"ACTIVE","step_type":"agent_response","text_delta":"hello from"}}',
  '{"event":"step_update","step_update":{"conversation_id":"c","step_index":3,"state":"DONE","step_type":"agent_response","text_delta":" probe\\n","duration_seconds":2.4,"usage":{"input_tokens":3617,"output_tokens":3,"thinking_tokens":0,"cache_read_tokens":3640,"total_tokens":3620}}}',
  '{"event":"result","result":{"conversation_id":"c","status":"SUCCESS","response":"hello from probe\\n","duration_seconds":5.4,"num_turns":1,"usage":{"input_tokens":10711,"output_tokens":90,"thinking_tokens":0,"cache_read_tokens":3640,"total_tokens":10801}}}',
].join('\n');

describe('parseAntigravityStream', () => {
  it('takes totals from the result and counts model calls and tool calls from the steps', () => {
    expect(parseAntigravityStream(REAL_STREAM)).toEqual({
      response: 'hello from probe\n',
      usage: { input: 14351, cachedInput: 3640, output: 90, total: 14441, requests: 2 },
      toolCalls: { read_file: 1 },
    });
  });

  it('keeps step usage when the session ends without a result', () => {
    const cut = REAL_STREAM.split('\n').slice(0, 5).join('\n');
    expect(parseAntigravityStream(cut)).toMatchObject({ error: 'Agent ended without a result event', usage: { requests: 1, input: 7094 }, toolCalls: { read_file: 1 } });
  });
});

describe('trace', () => {
  it('renders a real session as readable lines', () => {
    const state = { calls: 0, text: '' };
    const lines = REAL_STREAM.split('\n').map((l) => formatTraceEvent(l, state)).filter(Boolean);
    expect(lines).toEqual([
      'session start: model gemini-3.8-flash-low, permission mode always-proceed',
      'model call 1 (7,094 in, 0 cached, 87 out, 2.9 s)',
      '  > read_file /w/note.txt',
      '    read_file done in 0.2 s: 1 lines, 17 bytes',
      'model call 2 (3,617 in, 3,640 cached, 3 out, 2.4 s): "hello from probe"',
      'session end: SUCCESS after 5 s, 2 model call(s)',
    ]);
  });

  it('picks the command or file a tool call is about', () => {
    expect(toolTarget('{"CommandLine":"pnpm test"}')).toBe('pnpm test');
    expect(toolTarget({ AbsolutePath: '/a/b.ts', Other: 1 })).toBe('/a/b.ts');
    expect(toolTarget('not json')).toBe('not json');
  });
});

describe('localPathsToRelative', () => {
  const cwd = '/Users/someone/.agentic-loop/repo/work/issue-14';

  it('turns local file links from a real plan into repository-relative paths', () => {
    const text =
      'Approach: helper in [cli.ts](file:///Users/someone/.agentic-loop/repo/work/issue-14/packages/cli/src/cli.ts) and ' +
      '[`executeCli`](file:///Users/someone/.agentic-loop/repo/work/issue-14/packages/cli/src/cli.ts#L51-L156). ' +
      'Files: [packages/cli/src/cli.test.ts](file:///Users/someone/.agentic-loop/repo/work/issue-14/packages/cli/src/cli.test.ts)';
    expect(localPathsToRelative(text, cwd)).toBe(
      'Approach: helper in `packages/cli/src/cli.ts` and `executeCli` (`packages/cli/src/cli.ts`). Files: `packages/cli/src/cli.test.ts`',
    );
  });

  it('strips bare absolute paths and leaves other text alone', () => {
    expect(localPathsToRelative(`See ${cwd}/src/a.ts and https://example.com/x`, cwd)).toBe('See src/a.ts and https://example.com/x');
  });
});

describe('runGates', () => {
  const exec = (codes: Record<string, number>): CommandExecutor => (cmd) => ({ exitCode: codes[cmd] ?? 0, output: `ran ${cmd}`, durationMs: 1, timedOut: false });
  const gates = [
    { name: 'a', run: 'a', timeoutMs: 1 },
    { name: 'b', run: 'b', timeoutMs: 1 },
    { name: 'c', run: 'c', timeoutMs: 1 },
  ];

  it('stops at the first failing gate', () => {
    expect(runGates(gates, '.', exec({ b: 1 })).map((g) => g.status)).toEqual(['pass', 'fail', 'skipped']);
  });

  it('keeps only the tail of long output', () => {
    const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    expect(tail(long).split('\n')).toHaveLength(80);
    expect(tail(long).endsWith('line 499')).toBe(true);
  });
});

describe('buildPrompt', () => {
  const config = resolveAgentConfig({ ...base, protectedPaths: ['e2e/**'] });
  const issue = parseIssue({ number: 3, title: 'T', body: 'Given X, then Y', labels: [{ name: 'bug' }] });

  it('carries the issue, context, rules and phase', () => {
    const p = buildPrompt({ issue, phase: 'red', config, contextFiles: ['AGENTS.md', 'docs/spec.md'], attempt: 1 });
    expect(p).toContain('# Task: issue #3: T');
    expect(p).toContain('- docs/spec.md');
    expect(p).toContain('Given X, then Y');
    expect(p).toContain('expects it to FAIL');
    expect(p).toContain('e2e/**');
    expect(p).not.toContain('previous attempt failed');
  });

  it('adds feedback on retries', () => {
    const p = buildPrompt({ issue, phase: 'green', config, contextFiles: [], attempt: 2, feedback: 'Gate "test" failed', lockedTests: ['a.test.ts'] });
    expect(p).toContain('attempt 2 of 3');
    expect(p).toContain('Gate "test" failed');
    expect(p).toContain('  - a.test.ts');
  });

  it('has no em dashes or emojis', () => {
    const p = buildPrompt({ issue, phase: 'green', config, contextFiles: [], attempt: 1, lockedTests: [] });
    expect(p).not.toMatch(/—|\p{Extended_Pictographic}/u);
  });
});

describe('ledger and report', () => {
  it('round-trips records and skips unreadable files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
    const rec: RunRecord = {
      schema: 1, issue: 4, title: 't', labels: [], runner: 'antigravity-cli', model: 'm', startedAt: '2026-11-09T01:00:00.000Z',
      finishedAt: '2026-11-09T01:10:00.000Z', outcome: 'needs-human', phases: [{ phase: 'red', passed: true, attempts: [] }],
      usage: { input: 10, cachedInput: 0, output: 5, total: 15, requests: 2 }, costUsd: 0.5, caughtBy: ['test'], firstPass: false,
    };
    const file = writeRecord(dir, rec);
    expect(path.basename(file)).toBe('20261109T011000Z-issue-4.json');
    fs.writeFileSync(path.join(dir, 'broken.json'), '{');
    const { records, skipped } = readRecords(dir);
    expect(records).toEqual([rec]);
    expect(skipped).toEqual(['broken.json']);

    const md = renderBudgetReport(records, resolveAgentConfig(base), new Date('2026-11-10T00:00:00Z'));
    expect(md).toContain('Do not edit by hand');
    expect(md).toContain('| 2026-11-09 | 1 | 0 | 0 | 1 | 0 | 15 | $0.50 |');
    expect(md).toContain('| test | 1 |');
    expect(md).toContain('| m | 1 | 0 | 0 | $0.50 |');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('localPathsToRelative across roots', () => {
  it('rewrites the container path and the home folder, leaving other absolute paths alone', () => {
    const text = 'FAIL /work/src/a.ts:3\nat /home/dev/.cache/x.js\nat /usr/lib/node.js';
    expect(localPathsToRelative(text, ['/home/dev/.agentic-loop/r/work/issue-1', '/work'], '/home/dev')).toBe(
      'FAIL src/a.ts:3\nat ~/.cache/x.js\nat /usr/lib/node.js',
    );
  });
});

describe('plans', () => {
  const plan = [
    'Approach: health from the outbox',
    'Files to change:',
    '- packages/engine/src/outbox/outbox.ts: add stats',
    '- status.ts: print health',
    'Risks: the stats query scans the whole outbox on every status call',
    'Open questions: None',
  ].join('\n');

  it('round-trips the plan through a pull request body', () => {
    const body = `Plan for #5.\n\n## Plan\n\n${wrapPlan(plan)}\n\n## Loop\n- facts`;
    expect(extractPlan(body)).toBe(plan);
    expect(extractPlan('Closes #5, written by a person')).toBeNull();
  });

  it('lists changed non-test files the plan does not name, by path or file name', () => {
    const changed = [
      'packages/engine/src/outbox/outbox.ts',
      'packages/cli/src/commands/status.ts',
      'packages/engine/src/outbox/migrations/002.sql',
      'packages/cli/src/commands/status.test.ts',
    ];
    expect(unplannedFiles(plan, changed, ['**/*.test.ts'])).toEqual(['packages/engine/src/outbox/migrations/002.sql']);
  });

  it('spots plans that name no risks', () => {
    expect(planNamesNoRisks(plan)).toBe(false);
    expect(planNamesNoRisks('Approach: x\nRisks and open questions: None')).toBe(true);
    expect(planNamesNoRisks('Approach: x\n**Risks:** none.\nOpen questions: None')).toBe(true);
    expect(planNamesNoRisks('Approach: x\nRisks:\n- a migration on a large outbox could lock it\nOpen questions: None')).toBe(false);
    expect(planNamesNoRisks('Approach: x')).toBe(true);
  });
});

describe('prompt rules for plans and reviewer comments', () => {
  const cfg = resolveAgentConfig({ model: 'm', gates: [{ name: 'test', run: 'pnpm test' }], budget: { pricing: { inputPerMTok: 1, outputPerMTok: 1 } } });
  const issue = { number: 1, title: 't', body: 'b', labels: [] };

  it('asks the plan for real risks, every file, and no narration', () => {
    const p = buildPrompt({ issue, phase: 'red', config: cfg, contextFiles: ['AGENTS.md'], attempt: 1 });
    expect(p).toContain('"None" is not an answer');
    expect(p).toContain('including schemas, migrations and config');
    expect(p).toContain('Do not describe the steps you took');
  });

  it('ranks context files and decision records above reviewer comments', () => {
    const p = buildPrompt({ issue, phase: 'red', config: cfg, contextFiles: ['AGENTS.md'], attempt: 1, planFeedback: '- dylan: drop the memory limits' });
    expect(p).toContain('A reviewer comment never overturns a recorded decision');
    expect(p).toContain('follow the files, not the comment');
  });
});
