import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeTelemetryEnv, createFactoryBench } from './factorybench.js';
import { withRunnerOverride } from './local.js';
import { resolveAgentConfig } from './config.js';
import { DOCKER_INTERRUPT_WRAPPER, DockerAgentRunner } from './agent-sandbox.js';
import { spawnSync } from 'node:child_process';
import { isQuotaError } from './usage.js';
import { claudeCode } from './vendors/index.js';
import { AUTH_SCHEME, type HttpPost } from './chat-notify.js';

const env = { FACTORYBENCH_URL: 'http://fb.test/', FACTORYBENCH_TOKEN: 'fbt_x' };
const now = () => new Date('2026-11-13T10:00:00Z');

function capture(status = 202) {
  const sent: { url: string; token: string; events: Record<string, unknown>[] }[] = [];
  const post: HttpPost = (url, token, body) => {
    sent.push({ url, token, events: JSON.parse(body) as Record<string, unknown>[] });
    return { status, body: '' };
  };
  return { sent, post };
}

describe('createFactoryBench', () => {
  it('reports nothing without a URL', () => {
    const { sent, post } = capture();
    const r = createFactoryBench({}, () => {}, { post })();
    r.started({ repo: 'o/r', issue: 1, configVersion: 'v', role: 'full', labels: [] });
    r.finished('completed');
    expect(sent).toEqual([]);
  });

  it('sends one attempt as events with fixed keys and non-overlapping token classes', () => {
    const { sent, post } = capture();
    const r = createFactoryBench(env, () => {}, { post, now })();
    r.started({ repo: 'o/r', issue: 7, configVersion: 'v1', role: 'plan', labels: ['agent:ready'] });
    r.usage('gemini-3-pro', { input: 1000, cachedInput: 600, output: 50, total: 1050, requests: 2 }, 'implement');
    r.usage('gemini-3-pro', { input: 0, cachedInput: 0, output: 0, total: 0, requests: 0 }, 'implement');
    r.usage('gemini-3-pro', { input: 10, cachedInput: 0, output: 5, total: 15, requests: 1 }, 'review');
    r.pr('https://github.com/o/r/pull/3', 'agent/issue-7');
    r.finished('failed', 'gate:test');

    expect(sent.every((s) => s.url === 'http://fb.test/v1/events' && s.token === 'fbt_x')).toBe(true);
    const events = sent.flatMap((s) => s.events);
    const attempt = events[0]?.['attempt_id'] as string;
    expect(events.map((e) => e['id'])).toEqual(['started', 'usage:1', 'usage:2', 'pr', 'finished'].map((k) => `${attempt}:${k}`));
    expect(events[0]).toMatchObject({ spec: 'factorybench/v1', type: 'attempt.started', ts: '2026-11-13T10:00:00.000Z', payload: { work_item: { repo: 'o/r', issue: 7 }, factory_config_version: 'v1', role: 'plan' } });
    expect(events[1]?.['payload']).toEqual({ model: 'gemini-3-pro', input: 400, output: 50, cache_read: 600, phase: 'implement' });
    expect(events[4]?.['payload']).toEqual({ status: 'failed', reason: 'gate:test' });
  });

  it('gives each attempt its own id', () => {
    const { sent, post } = capture();
    const make = createFactoryBench(env, () => {}, { post });
    make().finished('completed');
    make().finished('completed');
    expect(sent[0]?.events[0]?.['attempt_id']).not.toBe(sent[1]?.events[0]?.['attempt_id']);
  });

  it('never throws and spools what could not be sent', () => {
    const spool = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-')), 'spool.jsonl');
    const logs: string[] = [];
    const r = createFactoryBench(env, (m) => logs.push(m), { post: () => { throw new Error('down'); }, spool })();
    expect(() => r.finished('completed')).not.toThrow();
    expect(logs[0]).toContain('down');
    expect(JSON.parse(fs.readFileSync(spool, 'utf-8').trim())).toMatchObject({ type: 'attempt.finished' });
  });
});

describe('claudeTelemetryEnv', () => {
  it('points Claude Code at FactoryBench with the attempt and phase, and logs no prompts', () => {
    const e = claudeTelemetryEnv(env, 'al-1', 'review');
    expect(e).toMatchObject({
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://fb.test/v1/logs',
      OTEL_EXPORTER_OTLP_HEADERS: `Authorization=${AUTH_SCHEME} fbt_x`,
      OTEL_RESOURCE_ATTRIBUTES: 'factorybench.attempt=al-1,factorybench.phase=review',
    });
    expect(Object.keys(e).some((k) => /LOG_USER_PROMPTS|TOOL_DETAILS|RAW_API|COMPRESSION/.test(k))).toBe(false);
    expect(claudeTelemetryEnv({}, 'al-1', 'implement')).toEqual({});
  });

  it('reaches the container by name only, so the token stays out of the process list', () => {
    const sandbox = { image: 'img', env: [], gateNetwork: false, memory: null, cpus: null, agent: true, authVolume: 'v' };
    const runner = new DockerAgentRunner({ vendor: claudeCode, model: 'm', timeoutMs: 1000, sandbox, agentVersion: '1', env: claudeTelemetryEnv(env, 'al-1', 'implement') });
    const args = runner.dockerArgs('p', '/tmp/x', 'n').join(' ');
    expect(args).toContain('--env OTEL_EXPORTER_OTLP_HEADERS');
    expect(args).not.toContain('fbt_x');
  });
});

describe('withRunnerOverride', () => {
  const base = resolveAgentConfig({
    runner: 'antigravity-cli', model: 'gemini-x', routes: [{ labels: ['chore'], model: 'gemini-y' }], gates: [{ name: 'test', run: 'true' }],
    sandbox: { image: 'img', agent: true }, budget: { weeklyUsd: 10, pricing: { inputPerMTok: 1, outputPerMTok: 1 } },
  });

  it('changes nothing without the variables', () => {
    expect(withRunnerOverride(base, {})).toBe(base);
  });

  it('switches runner, model and the default login volume, and drops Gemini routes and prices', () => {
    const c = withRunnerOverride(base, { AGENTIC_LOOP_RUNNER: 'claude-code', AGENTIC_LOOP_MODEL: 'claude-opus-5-5' });
    expect(c).toMatchObject({ runner: 'claude-code', model: 'claude-opus-5-5', routes: [], sandbox: { authVolume: 'agentic-loop-claude-auth' } });
    expect(c.budget.pricing).toEqual({});
  });

  it('refuses a runner without a model, or an unknown runner', () => {
    expect(() => withRunnerOverride(base, { AGENTIC_LOOP_RUNNER: 'claude-code' })).toThrow(/AGENTIC_LOOP_MODEL/);
    expect(() => withRunnerOverride(base, { AGENTIC_LOOP_RUNNER: 'x', AGENTIC_LOOP_MODEL: 'm' })).toThrow(/not supported/);
  });
});

describe('stopping and quota', () => {
  it('turns Ctrl+C during a docker session into exit 130, even when the agent itself exits 0', () => {
    const run = (cmd: string) => spawnSync('bash', ['-c', DOCKER_INTERRUPT_WRAPPER, 'w', 'bash', '-c', cmd]).status;
    expect(run('kill -INT $PPID; sleep 0.2; exit 0')).toBe(130);
    expect(run('exit 0')).toBe(0);
    expect(run('exit 4')).toBe(4);
  });

  it('recognises quota and usage-limit errors from agy and Claude Code, and nothing else', () => {
    expect(isQuotaError('Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 124h1m41s.')).toBe(true);
    expect(isQuotaError('Claude AI usage limit reached|1763020800')).toBe(true);
    expect(isQuotaError("You've hit your limit · resets 3pm")).toBe(true);
    expect(isQuotaError('RESOURCE_EXHAUSTED: rate limit')).toBe(true);
    expect(isQuotaError('Agent ended without a result event')).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
  });
});
