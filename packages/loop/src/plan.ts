import * as path from 'node:path';
import { matchesAny } from './glob.js';

/** Markers around the plan in a pull request body, so a later build stage can read back what was approved. */
const PLAN_START = '<!-- agentic-loop:plan -->';
const PLAN_END = '<!-- /agentic-loop:plan -->';

export function wrapPlan(plan: string): string {
  return `${PLAN_START}\n${plan.trim()}\n${PLAN_END}`;
}

/** The approved plan from a pull request body written by the loop, or null when it has none. */
export function extractPlan(body: string): string | null {
  const start = body.indexOf(PLAN_START);
  const end = body.indexOf(PLAN_END, start + PLAN_START.length);
  if (start === -1 || end === -1) return null;
  const plan = body.slice(start + PLAN_START.length, end).trim();
  return plan || null;
}

/**
 * True when the plan's "Risks" line is missing or says there are none. Every
 * change carries some risk; a plan that names none has not looked.
 */
export function planNamesNoRisks(plan: string): boolean {
  const m = /^\s*[-*]?\s*\**risks?\b[^:\n]*:\**\s*(.*)$/im.exec(plan);
  if (!m) return true;
  const rest = plan.slice(m.index + m[0].length).split(/\n\s*[-*]?\s*\**[A-Z][A-Za-z ]{2,40}:/)[0] ?? '';
  const text = `${m[1] ?? ''} ${rest}`.replace(/[*_`."]/g, ' ').trim().toLowerCase();
  return text === '' || /^(none|n\/a|no risks?|nothing)\b/.test(text);
}

/**
 * Changed files the approved plan does not mention, by path or file name.
 * Test files are left out: the approved tests are locked, and new tests are
 * always allowed. Matching on file names is loose on purpose, since plans
 * often name a file without its folder; it can miss drift, never invent it.
 */
export function unplannedFiles(plan: string, changed: readonly string[], testFiles: readonly string[]): string[] {
  const text = plan.toLowerCase();
  return changed.filter((f) => {
    if (matchesAny(f, testFiles)) return false;
    const lower = f.toLowerCase();
    return !text.includes(lower) && !text.includes(path.posix.basename(lower));
  });
}
