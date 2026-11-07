import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ResolvedPricing } from './config.js';
import type { Phase } from './prompt.js';
import type { TokenUsage } from './runner.js';

export interface AttemptRecord {
  attempt: number;
  agentExitCode: number | null;
  agentError?: string;
  usage: TokenUsage;
  /** Tool calls by name in this attempt's agent session. */
  toolCalls?: Record<string, number>;
  gates: { name: string; status: 'pass' | 'fail' | 'skipped'; durationMs: number }[];
  /** Protected files the agent changed; the loop reverted them. */
  protectedPathViolations: string[];
  /** Locked red-phase tests the agent changed in the green phase; the loop restored them. */
  lockedTestEdits: string[];
  /** Non-test files changed in the red phase; the loop reverted them. */
  outOfScopeFiles: string[];
  /** Why the attempt did not pass, or absent if it passed. */
  failure?: string;
}

export interface PhaseRecord {
  phase: Phase | 'fix';
  passed: boolean;
  attempts: AttemptRecord[];
}

export type Outcome = 'passed' | 'plan-ready' | 'needs-human';

/** Which part of the lifecycle a run covered. */
export type Stage = 'full' | 'plan' | 'build';

export interface ReviewRecord {
  model: string;
  usage: TokenUsage;
  /** Finding counts by kind. */
  findings: Record<string, number>;
  /** False when the reviewer gave no usable findings JSON. */
  parsed: boolean;
  fixRound: 'none' | 'kept' | 'discarded';
}

/** One loop run for one issue. Written by the loop, never by hand. */
export interface RunRecord {
  schema: 1;
  issue: number;
  title: string;
  labels: string[];
  runner: string;
  model: string;
  startedAt: string;
  finishedAt: string;
  outcome: Outcome;
  phases: PhaseRecord[];
  usage: TokenUsage;
  costUsd: number | null;
  /** The check that caught each failed attempt, in order: a gate name, "scope", "locked-tests", "red-not-failing", "no-tests" or "agent-error". */
  caughtBy: string[];
  /** True when the red and green phases each passed on their first attempt. */
  firstPass: boolean;
  /** Absent in records written before stages existed, which were full runs. */
  stage?: Stage;
  review?: ReviewRecord;
}

export function costUsd(usage: TokenUsage, pricing: ResolvedPricing | null | undefined): number | null {
  if (!pricing) return null;
  const fresh = Math.max(0, usage.input - usage.cachedInput);
  const usd =
    (fresh * pricing.inputPerMTok + usage.cachedInput * pricing.cachedInputPerMTok + usage.output * pricing.outputPerMTok) /
    1_000_000;
  return Math.round(usd * 10_000) / 10_000;
}

export function recordFileName(record: RunRecord): string {
  const stamp = record.finishedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${stamp}-issue-${record.issue}.json`;
}

export function writeRecord(dir: string, record: RunRecord): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, recordFileName(record));
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return file;
}

/** Reads every record in `dir`. Unreadable files are skipped and reported, never silently counted. */
export function readRecords(dir: string): { records: RunRecord[]; skipped: string[] } {
  if (!fs.existsSync(dir)) return { records: [], skipped: [] };
  const records: RunRecord[] = [];
  const skipped: string[] = [];
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')) as RunRecord;
      if (rec.schema !== 1 || typeof rec.issue !== 'number') throw new Error('unknown schema');
      records.push(rec);
    } catch {
      skipped.push(name);
    }
  }
  return { records, skipped };
}
