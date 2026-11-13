import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ResolvedAgentConfig } from './config.js';

/** HTTP auth scheme for personal API tokens. */
export const AUTH_SCHEME = 'Bearer';

/** Environment variable holding the chat token. Never passed to the agent or gates. */
export const WORKSPACE_TOKEN_VAR = 'AGENTIC_LOOP_WORKSPACE_TOKEN';

export interface NotifyEvent {
  kind: 'plan-ready' | 'passed' | 'needs-human';
  issue: { number: number; title: string; url: string };
  prUrl?: string;
}

/** Sends one notification. Throws on failure; the caller decides whether that matters. */
export type Notify = (config: ResolvedAgentConfig, event: NotifyEvent) => void;

/** Posts a JSON body with the token as the Authorization header and returns the HTTP status and response body. */
export type HttpPost = (url: string, token: string, body: string) => { status: number; body: string };

/**
 * The message text. Only the issue number, title and links: never code, diffs
 * or gate output, which may hold things the chat should not see.
 */
export function notifyText(event: NotifyEvent, cc: string): string {
  const { issue, prUrl } = event;
  const head =
    event.kind === 'plan-ready'
      ? `Plan ready for review: #${issue.number} ${issue.title}`
      : event.kind === 'passed'
        ? `Pull request ready for review: #${issue.number} ${issue.title}`
        : `The agent loop stopped and needs a person: #${issue.number} ${issue.title}`;
  const link = event.kind === 'needs-human' ? issue.url : (prUrl ?? issue.url);
  return [head, link, cc.trim()].filter(Boolean).join('\n');
}

/**
 * Posts with curl. The token goes in through stdin (`-H @-`), so it never
 * appears in the process list.
 */
export const curlPost = (url: string, token: string, body: string, maxTimeSec = 20): { status: number; body: string } => {
  const res = spawnSync(
    'curl',
    ['-sS', '--max-time', String(maxTimeSec), '-X', 'POST', '-H', '@-', '-H', 'Content-Type: application/json', '--data-binary', body, '-w', '\n%{http_code}', url],
    { input: `Authorization: ${AUTH_SCHEME} ${token}\n`, encoding: 'utf-8' },
  );
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`curl exited with code ${res.status}: ${res.stderr.trim()}`);
  const out = res.stdout;
  const cut = out.lastIndexOf('\n');
  return { status: Number(out.slice(cut + 1)), body: out.slice(0, cut) };
};

/** Posts loop events to a Gradion Workspace channel. */
export function createWorkspaceNotifier(token: string, post: HttpPost = curlPost): Notify {
  return (config, event) => {
    const ws = config.notify.workspace;
    if (!ws) return;
    const cc = event.kind === 'passed' ? ws.cc.pr : ws.cc.plan;
    const url = `${ws.url}/api/channels/${encodeURIComponent(ws.channel)}/messages`;
    const res = post(url, token, JSON.stringify({ content: notifyText(event, cc), client_message_id: randomUUID() }));
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Workspace answered ${res.status}: ${res.body.slice(0, 200)}`);
    }
  };
}
