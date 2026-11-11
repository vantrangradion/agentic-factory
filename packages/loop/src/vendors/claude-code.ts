import { short, toolTarget, count, type TraceState } from '../trace-format.js';
import { num, ZERO_USAGE, type ParsedSession, type TokenUsage } from '../usage.js';
import type { AgentVendor } from '../vendor.js';

/**
 * Claude Code (`claude`), Anthropic's agent CLI, run with
 * `-p --output-format stream-json --verbose`.
 *
 * Its trace is one JSON event per line: `system` (init), `assistant` and
 * `user` messages, and a final `result`. One model response can arrive as
 * several `assistant` events that share `message.id`, so model calls are
 * counted by distinct id. Their `output_tokens` is only the count known when
 * the response started, so token totals come from the `result` event.
 */

export function claudeArgs(promptArg: string, model: string): string[] {
  return ['-p', promptArg, '--model', model, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
}

function parseLine(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    const v = JSON.parse(line) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** TokenUsage from Anthropic counts, where input excludes cache reads and cache writes. */
function toUsage(input: number, cacheRead: number, cacheWrite: number, output: number, requests: number): TokenUsage {
  const allInput = input + cacheRead + cacheWrite;
  return { input: allInput, cachedInput: cacheRead, output, total: allInput + output, requests };
}

/**
 * Totals from the `result` event. `modelUsage` covers every model the session
 * used, subagents included; `usage` covers only the main conversation, so it
 * is the fallback.
 */
function resultUsage(r: Record<string, unknown>, requests: number): TokenUsage | null {
  const byModel = r['modelUsage'];
  if (byModel && typeof byModel === 'object' && Object.keys(byModel).length > 0) {
    let input = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let output = 0;
    for (const m of Object.values(byModel as Record<string, Record<string, unknown>>)) {
      input += num(m?.['inputTokens']);
      cacheRead += num(m?.['cacheReadInputTokens']);
      cacheWrite += num(m?.['cacheCreationInputTokens']);
      output += num(m?.['outputTokens']);
    }
    return toUsage(input, cacheRead, cacheWrite, output, requests);
  }
  const u = r['usage'];
  if (!u || typeof u !== 'object') return null;
  const o = u as Record<string, unknown>;
  return toUsage(num(o['input_tokens']), num(o['cache_read_input_tokens']), num(o['cache_creation_input_tokens']), num(o['output_tokens']), requests);
}

function resultError(r: Record<string, unknown>): string | undefined {
  const subtype = typeof r['subtype'] === 'string' ? r['subtype'] : 'unknown';
  const errors = Array.isArray(r['errors']) ? (r['errors'] as unknown[]).filter((e): e is string => typeof e === 'string') : [];
  if (subtype !== 'success') return errors.length > 0 ? `Agent stopped (${subtype}): ${errors.join('; ')}` : `Agent stopped (${subtype})`;
  if (r['is_error'] === true) return `Agent reported an error: ${typeof r['result'] === 'string' ? short(r['result'], 300) : 'no details'}`;
  return undefined;
}

export function parseClaudeStream(ndjson: string): ParsedSession {
  const calls = new Map<string, Record<string, unknown>>();
  const toolUses = new Set<string>();
  const toolCalls: Record<string, number> = {};
  let result: Record<string, unknown> | undefined;
  for (const line of ndjson.split('\n')) {
    const e = parseLine(line);
    if (!e) continue;
    if (e['type'] === 'result') {
      result = e;
      continue;
    }
    if (e['type'] !== 'assistant') continue;
    const msg = (e['message'] ?? {}) as Record<string, unknown>;
    const id = typeof msg['id'] === 'string' ? msg['id'] : `event-${calls.size}`;
    if (msg['usage'] && typeof msg['usage'] === 'object') calls.set(id, msg['usage'] as Record<string, unknown>);
    else if (!calls.has(id)) calls.set(id, {});
    for (const block of Array.isArray(msg['content']) ? (msg['content'] as Record<string, unknown>[]) : []) {
      if (block?.['type'] !== 'tool_use') continue;
      const useId = typeof block['id'] === 'string' ? block['id'] : `${id}-${toolUses.size}`;
      if (toolUses.has(useId)) continue;
      toolUses.add(useId);
      const name = typeof block['name'] === 'string' ? block['name'] : 'unknown';
      toolCalls[name] = (toolCalls[name] ?? 0) + 1;
    }
  }
  const requests = calls.size;
  if (!result) {
    // Killed before the end (time limit, Ctrl+C): input and cache counts per call are right; output is a lower bound.
    let usage = { ...ZERO_USAGE, requests };
    for (const u of calls.values()) {
      const one = toUsage(num(u['input_tokens']), num(u['cache_read_input_tokens']), num(u['cache_creation_input_tokens']), num(u['output_tokens']), 0);
      usage = { ...usage, input: usage.input + one.input, cachedInput: usage.cachedInput + one.cachedInput, output: usage.output + one.output, total: usage.total + one.total };
    }
    return { response: '', usage, error: 'Agent ended without a result event', toolCalls };
  }
  const usage = resultUsage(result, requests || num(result['num_turns'])) ?? { ...ZERO_USAGE, requests };
  const error = resultError(result);
  return {
    response: typeof result['result'] === 'string' ? result['result'] : '',
    usage,
    toolCalls,
    ...(error !== undefined ? { error } : {}),
  };
}

/** Turns one Claude Code stream-json event into a readable line, or null for events not worth showing. */
export function formatClaudeEvent(line: string, state: TraceState & { seen?: Set<string> }): string | null {
  const e = parseLine(line);
  if (!e || typeof e['type'] !== 'string') return null;
  if (e['type'] === 'system' && e['subtype'] === 'init') {
    return `session start: model ${String(e['model'] ?? '?')}, permission mode ${String(e['permissionMode'] ?? '?')}`;
  }
  if (e['type'] === 'result') {
    const seconds = num(e['duration_ms']) / 1000;
    return `session end: ${String(e['subtype'] ?? '?')} after ${seconds.toFixed(0)} s, ${state.calls} model call(s)`;
  }
  if (e['type'] === 'assistant') {
    const msg = (e['message'] ?? {}) as Record<string, unknown>;
    const lines: string[] = [];
    const seen = (state.seen ??= new Set<string>());
    const id = typeof msg['id'] === 'string' ? msg['id'] : undefined;
    if (!id || !seen.has(id)) {
      if (id) seen.add(id);
      state.calls++;
      const u = (msg['usage'] ?? {}) as Record<string, unknown>;
      lines.push(`model call ${state.calls} (${count(num(u['input_tokens']) + num(u['cache_creation_input_tokens']) + num(u['cache_read_input_tokens']))} in, ${count(u['cache_read_input_tokens'])} cached)`);
    }
    for (const block of Array.isArray(msg['content']) ? (msg['content'] as Record<string, unknown>[]) : []) {
      if (block?.['type'] === 'text' && typeof block['text'] === 'string' && block['text'].trim()) lines.push(`  says: "${short(block['text'], 90)}"`);
      if (block?.['type'] === 'tool_use') {
        const target = toolTarget(block['input']);
        lines.push(`  > ${String(block['name'] ?? 'tool')}${target ? ` ${target}` : ''}`);
      }
    }
    return lines.length > 0 ? lines.join('\n') : null;
  }
  if (e['type'] === 'user') {
    const msg = (e['message'] ?? {}) as Record<string, unknown>;
    const out: string[] = [];
    for (const block of Array.isArray(msg['content']) ? (msg['content'] as Record<string, unknown>[]) : []) {
      if (block?.['type'] !== 'tool_result') continue;
      const c = block['content'];
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('\n') : '';
      const first = short(text.split('\n').find((l: string) => l.trim()) ?? '', 80);
      out.push(`    ${block['is_error'] === true ? 'failed' : 'done'}${first ? `: ${first}` : ''}`);
    }
    return out.length > 0 ? out.join('\n') : null;
  }
  return null;
}

const AUTH_TOKEN_FILE = 'claude-oauth-token';

export const claudeCode: AgentVendor = {
  id: 'claude-code',
  label: 'Claude Code',
  binary: 'claude',
  args: (promptArg, model) => claudeArgs(promptArg, model),
  // Claude Code has no session time limit of its own; the loop kills it at sessionTimeoutMs.
  enforcesTimeout: false,
  parse: parseClaudeStream,
  formatTraceEvent: formatClaudeEvent,
  isEndEvent: (line) => parseLine(line)?.['type'] === 'result',
  sandbox: {
    authFile: AUTH_TOKEN_FILE,
    defaultAuthVolume: 'agentic-loop-claude-auth',
    useLogin: (authPath) => [`CLAUDE_CODE_OAUTH_TOKEN="$(cat ${authPath})"`, 'export CLAUDE_CODE_OAUTH_TOKEN'],
    signIn: (authPath) => [
      'claude setup-token',
      "printf '\\nPaste the token it printed, then press Enter: '",
      'IFS= read -rs token',
      'echo',
      '[ -n "$token" ] || { echo "No token pasted; nothing saved." >&2; exit 1; }',
      `printf '%s' "$token" > ${authPath}`,
    ],
    signInHint:
      'It runs claude setup-token: open the URL it prints, approve access, and it prints a token. Paste that token back here. Needs a Claude Pro, Max, Team or Enterprise plan; the token lasts a year.',
    installHint: 'RUN npm install -g @anthropic-ai/claude-code',
  },
};
