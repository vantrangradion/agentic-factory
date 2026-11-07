import type { GateResult } from './gates.js';
import type { Issue } from './issue.js';

/** The four ways finished work can fall short, after BuilderIO's agent-watchdog. */
export const FINDING_KINDS = ['gap', 'bug', 'verification-miss', 'scope-drift'] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];
export type Severity = 'high' | 'medium' | 'low';

export interface Finding {
  kind: FindingKind;
  severity: Severity;
  file?: string;
  summary: string;
  evidence: string;
}

const DIFF_LIMIT = 60_000;

/**
 * The reviewer's prompt. The issue is the source of truth; the coding agent's
 * summary is given only as claims to check against the diff and gate output.
 */
export function buildReviewPrompt(input: { issue: Issue; diff: string; gates: readonly GateResult[]; claims: string; contextFiles: string[] }): string {
  const { issue, diff, gates, claims, contextFiles } = input;
  const shownDiff = diff.length > DIFF_LIMIT ? `${diff.slice(0, DIFF_LIMIT)}\n[diff truncated after ${DIFF_LIMIT} characters; read the files for the rest]` : diff;
  const gateLines = gates.map((g) => `- ${g.name} (\`${g.command}\`): ${g.status.toUpperCase()}`).join('\n');
  return [
    `# Review: issue #${issue.number}: ${issue.title}`,
    'You are an independent reviewer. Another agent implemented this issue and every automated gate passed. Your job is to find what the gates cannot: requirements that were missed, bugs, claims that were never verified, and changes nobody asked for.',
    '## Rules',
    [
      '- The issue below is the source of truth. The other agent\'s summary is a list of claims, not facts: check each one against the diff and the code.',
      '- Read the changed files in the repository, not just the diff. Inspect evidence, not impressions.',
      '- Do not change any file. The loop discards any edit you make.',
      '- Report only real problems you can point to. Do not report style preferences.',
      contextFiles.length > 0 ? `- The project's rules are in: ${contextFiles.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    '## The issue',
    issue.body || '(No description. Use the title.)',
    '## Gate results',
    gateLines || '(none)',
    '## The other agent\'s claims',
    claims.trim() || '(No summary given.)',
    '## The diff',
    `\`\`\`diff\n${shownDiff.replace(/```/g, "'''")}\n\`\`\``,
    '## Your answer',
    [
      'Reply with only a JSON object in a ```json fenced block, in exactly this shape:',
      '```json',
      '{ "findings": [ { "kind": "gap", "severity": "high", "file": "path/to/file.ts", "summary": "one line", "evidence": "what you saw that proves it" } ] }',
      '```',
      'kind is one of: gap (an acceptance criterion is not met), bug (wrong behaviour), verification-miss (a claim or criterion has no test that would catch a regression), scope-drift (a change the issue did not ask for).',
      'severity is high (blocks the main use or loses data), medium (a real defect with a workaround) or low (minor).',
      'If you find nothing, reply with { "findings": [] }.',
    ].join('\n'),
    '',
  ].join('\n\n');
}

function isKind(v: unknown): v is FindingKind {
  return typeof v === 'string' && (FINDING_KINDS as readonly string[]).includes(v);
}

/** Reads the reviewer's JSON. Returns null when there is no usable findings object, so "no answer" is never mistaken for "no problems". */
export function parseFindings(response: string): Finding[] | null {
  const candidates: string[] = [];
  for (const m of response.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) if (m[1]) candidates.push(m[1]);
  const start = response.indexOf('{');
  const end = response.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(response.slice(start, end + 1));

  for (const text of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.trim());
    } catch {
      continue;
    }
    const list = (parsed as Record<string, unknown> | null)?.['findings'];
    if (!Array.isArray(list)) continue;
    return list.flatMap((raw): Finding[] => {
      const f = (raw ?? {}) as Record<string, unknown>;
      if (!isKind(f['kind']) || typeof f['summary'] !== 'string' || !f['summary']) return [];
      const severity: Severity = f['severity'] === 'high' || f['severity'] === 'low' ? f['severity'] : 'medium';
      return [
        {
          kind: f['kind'],
          severity,
          ...(typeof f['file'] === 'string' && f['file'] ? { file: f['file'] } : {}),
          summary: f['summary'],
          evidence: typeof f['evidence'] === 'string' ? f['evidence'] : '',
        },
      ];
    });
  }
  return null;
}

export function isActionable(f: Finding): boolean {
  return f.severity !== 'low';
}

export function describeFindings(findings: readonly Finding[]): string {
  return findings
    .map((f, i) => `${i + 1}. [${f.kind}, ${f.severity}]${f.file ? ` ${f.file}:` : ''} ${f.summary}${f.evidence ? `\n   Evidence: ${f.evidence}` : ''}`)
    .join('\n');
}
