import type { ResolvedAgentConfig } from './config.js';
import type { RunRecord } from './ledger.js';

export type BudgetMode = 'unlimited' | 'full' | 'bugs-only' | 'stopped';

export interface BudgetDecision {
  mode: BudgetMode;
  allowed: boolean;
  spentUsd: number;
  weeklyUsd: number | null;
  weekStart: string;
  reason: string;
}

function offsetMinutes(utcOffset: string): number {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(utcOffset);
  if (!m) return 0;
  const mins = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -mins : mins;
}

/** Monday 00:00 in the given offset, as a UTC instant. */
export function weekStart(now: Date, utcOffset: string): Date {
  const off = offsetMinutes(utcOffset) * 60_000;
  const local = new Date(now.getTime() + off);
  const daysSinceMonday = (local.getUTCDay() + 6) % 7;
  const localMidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - daysSinceMonday);
  return new Date(localMidnight - off);
}

/** The local calendar date (YYYY-MM-DD) of the Monday that starts the week containing `instant`. */
export function weekLabel(instant: Date, utcOffset: string): string {
  const start = weekStart(instant, utcOffset);
  return new Date(start.getTime() + offsetMinutes(utcOffset) * 60_000).toISOString().slice(0, 10);
}

export function spentThisWeek(records: readonly RunRecord[], start: Date): number {
  return records
    .filter((r) => new Date(r.finishedAt).getTime() >= start.getTime())
    .reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
}

/**
 * Decides whether an issue may run. Below `bugOnlyAt` of the cap everything
 * runs; between `bugOnlyAt` and `stopAt` only bug issues run; above `stopAt`
 * nothing runs until next Monday.
 */
export function decideBudget(
  records: readonly RunRecord[],
  budget: ResolvedAgentConfig['budget'],
  issueLabels: readonly string[],
  now: Date,
): BudgetDecision {
  const start = weekStart(now, budget.utcOffset);
  const spent = Math.round(spentThisWeek(records, start) * 10_000) / 10_000;
  const base = { spentUsd: spent, weeklyUsd: budget.weeklyUsd, weekStart: start.toISOString() };

  if (budget.weeklyUsd === null) {
    return { ...base, mode: 'unlimited', allowed: true, reason: 'No weekly cap is configured.' };
  }
  const ratio = spent / budget.weeklyUsd;
  const pct = `${Math.round(ratio * 100)}%`;
  if (ratio >= budget.stopAt) {
    return { ...base, mode: 'stopped', allowed: false, reason: `Weekly budget used: ${pct} of $${budget.weeklyUsd}. The loop resumes on Monday.` };
  }
  if (ratio >= budget.bugOnlyAt) {
    const isBug = issueLabels.some((l) => budget.bugLabels.includes(l));
    return {
      ...base,
      mode: 'bugs-only',
      allowed: isBug,
      reason: isBug
        ? `Budget at ${pct}: bug issues only, and this is one.`
        : `Budget at ${pct}: only issues labelled ${budget.bugLabels.join(' or ')} run until Monday.`,
    };
  }
  return { ...base, mode: 'full', allowed: true, reason: `Budget at ${pct} of $${budget.weeklyUsd}.` };
}
