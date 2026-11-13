import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AUTH_SCHEME, curlPost, type HttpPost } from './chat-notify.js';
import type { TokenUsage } from './usage.js';

/** Where FactoryBench runs, without /v1/events. Unset: nothing is reported. */
export const FACTORYBENCH_URL_VAR = 'FACTORYBENCH_URL';
/** This factory's FactoryBench token. Never passed to the agent or gates. */
export const FACTORYBENCH_TOKEN_VAR = 'FACTORYBENCH_TOKEN';

/**
 * Reports one attempt (one stage run on one issue) to FactoryBench. Only
 * lifecycle facts and token counts: never prompts, code, diffs or secrets.
 * Every method swallows its own errors, so reporting never fails a run.
 */
export interface AttemptReporter {
  /** Empty when nothing is reported. */
  readonly attemptId: string;
  started(payload: { repo: string; issue: number; configVersion: string; role: string; labels: readonly string[]; baseCommit?: string }): void;
  /** One agent session's usage as a delta. */
  usage(model: string, usage: TokenUsage, phase: 'implement' | 'review'): void;
  pr(prUrl: string, branch: string): void;
  finished(status: 'completed' | 'failed' | 'cancelled', reason?: string): void;
}

export type ReporterFactory = () => AttemptReporter;

const NOOP: AttemptReporter = { attemptId: '', started() {}, usage() {}, pr() {}, finished() {} };

/** Short, so a down FactoryBench costs a run seconds, not minutes. */
const TIMEOUT_POST: HttpPost = (url, token, body) => curlPost(url, token, body, 5);

export function createFactoryBench(
  env: NodeJS.ProcessEnv,
  log: (m: string) => void,
  opts: { post?: HttpPost; now?: () => Date; spool?: string } = {},
): ReporterFactory {
  const base = env[FACTORYBENCH_URL_VAR]?.replace(/\/+$/, '');
  const token = env[FACTORYBENCH_TOKEN_VAR];
  if (!base) return () => NOOP;
  if (!token) {
    log(`WARN: ${FACTORYBENCH_URL_VAR} is set but ${FACTORYBENCH_TOKEN_VAR} is not, so nothing is reported to FactoryBench`);
    return () => NOOP;
  }
  const post = opts.post ?? TIMEOUT_POST;
  const now = opts.now ?? (() => new Date());
  const spool = opts.spool ?? env['FACTORYBENCH_SPOOL'] ?? path.join(os.homedir(), '.factorybench', 'spool.jsonl');

  return () => {
    const attempt = `al-${randomUUID()}`;
    let usageN = 0;
    const emit = (type: string, key: string, payload: Record<string, unknown>): void => {
      const event = { spec: 'factorybench/v1', id: `${attempt}:${key}`, type, ts: now().toISOString(), attempt_id: attempt, payload };
      try {
        const res = post(`${base}/v1/events`, token, JSON.stringify([event]));
        if (res.status >= 200 && res.status < 300) return;
        log(`WARN: FactoryBench answered ${res.status} to ${type}: ${res.body.slice(0, 200)}`);
        if (res.status >= 400 && res.status < 500) return; // a contract error does not get better on resend
      } catch (err) {
        log(`WARN: could not report ${type} to FactoryBench: ${(err as Error).message}`);
      }
      try {
        fs.mkdirSync(path.dirname(spool), { recursive: true });
        fs.appendFileSync(spool, JSON.stringify(event) + '\n');
      } catch {
        // Reporting never fails a run.
      }
    };
    return {
      attemptId: attempt,
      started: (p) =>
        emit('attempt.started', 'started', {
          work_item: { repo: p.repo, issue: p.issue },
          factory_config_version: p.configVersion,
          role: p.role,
          labels: [...p.labels],
          ...(p.baseCommit ? { base_commit: p.baseCommit } : {}),
        }),
      usage: (model, u, phase) => {
        if (u.input === 0 && u.output === 0) return; // unknown is missing, not zero
        usageN++;
        emit('usage', `usage:${usageN}`, {
          model,
          input: Math.max(0, u.input - u.cachedInput),
          output: u.output,
          cache_read: u.cachedInput,
          phase,
        });
      },
      pr: (prUrl, branch) => emit('pr.linked', 'pr', { pr_url: prUrl, branch }),
      finished: (status, reason) => emit('attempt.finished', 'finished', { status, ...(reason ? { reason: reason.slice(0, 500) } : {}) }),
    };
  };
}

/** Change whenever the factory, runner or model changes, so results are compared like for like. */
export function factoryConfigVersion(loopVersion: string, runner: string, model: string): string {
  return `agentic-loop@${loopVersion}+${runner}+${model}`;
}

/**
 * Environment for a Claude Code session, so it sends its own tokens, cost and
 * tool calls to FactoryBench over OTLP. Prompts, tool details and API bodies
 * stay off. Empty when FactoryBench is not configured or there is no attempt.
 */
export function claudeTelemetryEnv(env: NodeJS.ProcessEnv, attemptId: string, phase: 'implement' | 'review'): Record<string, string> {
  const base = env[FACTORYBENCH_URL_VAR]?.replace(/\/+$/, '');
  const token = env[FACTORYBENCH_TOKEN_VAR];
  if (!base || !token || !attemptId) return {};
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${base}/v1/logs`,
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=${AUTH_SCHEME} ${token}`,
    OTEL_RESOURCE_ATTRIBUTES: `factorybench.attempt=${attemptId},factorybench.phase=${phase}`,
  };
}
