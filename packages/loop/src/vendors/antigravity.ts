import { count, short, toolTarget, type TraceState } from '../trace-format.js';
import { addUsage, num, ZERO_USAGE, type ParsedSession, type TokenUsage } from '../usage.js';
import type { AgentVendor } from '../vendor.js';

/** Antigravity CLI (`agy`), Google's agent CLI for Gemini models. */

/** The agy arguments for one headless session with every tool permission auto-approved. */
export function agyArgs(promptArg: string, model: string, seconds: number): string[] {
  return ['-p', promptArg, '--model', model, '--output-format', 'stream-json', '--dangerously-skip-permissions', '--print-timeout', `${seconds}s`];
}

function parseLooseJson(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  const attempts = [trimmed];
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) attempts.push(trimmed.slice(start, end + 1));
  for (const text of attempts) {
    try {
      const v = JSON.parse(text) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/**
 * Parses `agy -p ... --output-format json`:
 * `{ status, response, num_turns, usage: { input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens } }`.
 * `output_tokens` already includes thinking tokens, so they are not added again.
 */
export function parseAntigravityJson(stdout: string): { response: string; usage: TokenUsage; error?: string } {
  const obj = parseLooseJson(stdout);
  if (!obj) return { response: '', usage: { ...ZERO_USAGE }, error: 'Agent output was not JSON' };
  const u = (obj['usage'] ?? {}) as Record<string, unknown>;
  // agy reports cache reads separately from input_tokens; TokenUsage.input includes them.
  const cached = num(u['cache_read_tokens']);
  const input = num(u['input_tokens']) + cached;
  const output = num(u['output_tokens']);
  const status = typeof obj['status'] === 'string' ? obj['status'] : undefined;
  // Present only when a turn ended early (agy 1.4.11+): print_timeout, interrupted or error. The response is then partial.
  const finished = typeof obj['finished_reason'] === 'string' ? obj['finished_reason'] : undefined;
  const err = obj['error'];
  const errorMessage =
    err !== undefined && err !== null
      ? typeof err === 'string'
        ? err
        : String((err as Record<string, unknown>)['message'] ?? JSON.stringify(err))
      : finished !== undefined
        ? `Agent stopped early (${finished}); its reply is partial`
        : status !== undefined && status !== 'SUCCESS'
          ? `Agent status ${status}`
          : undefined;
  return {
    response: typeof obj['response'] === 'string' ? obj['response'] : '',
    usage: {
      input,
      cachedInput: cached,
      output,
      total: input + output,
      // num_turns counts conversation turns, not model calls; the runner replaces this with the count from the session log.
      requests: num(obj['num_turns']),
    },
    ...(errorMessage !== undefined ? { error: errorMessage } : {}),
  };
}

/**
 * Reads an agy `--output-format stream-json` trace. The `result` event holds
 * the reply and totals; each finished `agent_response` step is one model call,
 * which is what seat quotas count; each finished `tool` step is one tool call.
 */
export function parseAntigravityStream(ndjson: string): ParsedSession {
  let requests = 0;
  const toolCalls: Record<string, number> = {};
  let stepUsage = { ...ZERO_USAGE };
  let result: Record<string, unknown> | undefined;
  for (const line of ndjson.split('\n')) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (e['event'] === 'result') result = (e['result'] ?? {}) as Record<string, unknown>;
    const s = e['step_update'] as Record<string, unknown> | undefined;
    if (!s || s['state'] !== 'DONE') continue;
    if (s['step_type'] === 'agent_response') {
      requests++;
      const u = (s['usage'] ?? {}) as Record<string, unknown>;
      const cached = num(u['cache_read_tokens']);
      const input = num(u['input_tokens']) + cached;
      const output = num(u['output_tokens']);
      stepUsage = addUsage(stepUsage, { input, cachedInput: cached, output, total: input + output, requests: 0 });
    } else if (s['step_type'] === 'tool') {
      const name = typeof s['tool_name'] === 'string' ? s['tool_name'] : 'unknown';
      toolCalls[name] = (toolCalls[name] ?? 0) + 1;
    }
  }
  if (!result) {
    return { response: '', usage: { ...stepUsage, requests }, error: 'Agent ended without a result event', toolCalls };
  }
  const parsed = parseAntigravityJson(JSON.stringify(result));
  return { ...parsed, usage: { ...parsed.usage, requests: requests || parsed.usage.requests }, toolCalls };
}

/** Turns one agy stream-json event into a readable line, or null for events not worth showing. */
export function formatAntigravityEvent(line: string, state: TraceState): string | null {
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (e['event'] === 'init') {
    const i = (e['init'] ?? {}) as Record<string, unknown>;
    return `session start: model ${String(i['model'] ?? '?')}, permission mode ${String(i['permission_mode'] ?? '?')}`;
  }
  if (e['event'] === 'result') {
    const r = (e['result'] ?? {}) as Record<string, unknown>;
    const early = typeof r['finished_reason'] === 'string' ? `, stopped early: ${r['finished_reason']}` : '';
    return `session end: ${String(r['status'] ?? '?')} after ${Number(r['duration_seconds'] ?? 0).toFixed(0)} s, ${state.calls} model call(s)${early}`;
  }
  const s = e['step_update'] as Record<string, unknown> | undefined;
  if (!s) return null;
  const type = s['step_type'];
  const done = s['state'] === 'DONE';
  if (type === 'tool') {
    const info = (s['tool_info'] ?? {}) as Record<string, unknown>;
    const name = String(s['tool_name'] ?? info['name'] ?? 'tool');
    const target = toolTarget(info['parameters']);
    if (!done) return `  > ${name}${target ? ` ${target}` : ''}`;
    const out = typeof info['output'] === 'string' ? short(info['output'].split('\n').find((l) => l.trim()) ?? '', 80) : '';
    return `    ${name} done in ${Number(s['duration_seconds'] ?? 0).toFixed(1)} s${out ? `: ${out}` : ''}`;
  }
  if (type === 'agent_response') {
    if (typeof s['text_delta'] === 'string') state.text += s['text_delta'];
    if (!done) return null;
    state.calls++;
    const u = (s['usage'] ?? {}) as Record<string, unknown>;
    const said = state.text.trim() ? `: "${short(state.text, 90)}"` : '';
    state.text = '';
    return `model call ${state.calls} (${count(u['input_tokens'])} in, ${count(u['cache_read_tokens'])} cached, ${count(u['output_tokens'])} out, ${Number(s['duration_seconds'] ?? 0).toFixed(1)} s)${said}`;
  }
  return null;
}

/** The file in the login volume that holds agy's login. */
const AUTH_TOKEN_FILE = 'antigravity-oauth-token';
const AGY_DIR = '$HOME/.gemini/antigravity-cli';

export const antigravity: AgentVendor = {
  id: 'antigravity-cli',
  label: 'agy',
  binary: 'agy',
  args: agyArgs,
  enforcesTimeout: true,
  parse: parseAntigravityStream,
  // agy 1.5.0+ exits with code 3 when --print-timeout cuts a turn short.
  exitError: (status, seconds, stderrTail) => (status === 3 ? `Agent session hit its ${seconds} s time limit. ${stderrTail}`.trim() : undefined),
  formatTraceEvent: formatAntigravityEvent,
  isEndEvent: (line) => /"event"\s*:\s*"result"/.test(line),
  sandbox: {
    authFile: AUTH_TOKEN_FILE,
    defaultAuthVolume: 'agentic-loop-agy-auth',
    useLogin: (authPath) => [`mkdir -p "${AGY_DIR}"`, `cp ${authPath} "${AGY_DIR}/${AUTH_TOKEN_FILE}"`],
    signIn: (authPath) => [
      `mkdir -p "${AGY_DIR}"`,
      'agy -p "Reply with the word OK" --output-format text',
      `cp "${AGY_DIR}/${AUTH_TOKEN_FILE}" ${authPath}`,
    ],
    signInHint: 'Open the URL it prints, sign in, then paste the code back here. This uses one model request.',
    installHint: 'RUN curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /usr/local/bin',
  },
};
