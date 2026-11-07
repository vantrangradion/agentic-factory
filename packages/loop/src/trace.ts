import * as fs from 'node:fs';

/** State carried across trace lines: model call count and the reply being streamed. */
export interface TraceState {
  calls: number;
  text: string;
}

const PARAM_KEYS = ['CommandLine', 'command', 'Path', 'AbsolutePath', 'TargetFile', 'path', 'file_path', 'Query', 'query', 'Url', 'url'];

function short(s: string, n = 100): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 3)}...` : one;
}

/** The one parameter that says what a tool call was about: the command, the file, or the query. */
export function toolTarget(parameters: unknown): string {
  let p: unknown = parameters;
  if (typeof parameters === 'string') {
    try {
      p = JSON.parse(parameters);
    } catch {
      return short(parameters);
    }
  }
  if (!p || typeof p !== 'object') return '';
  const obj = p as Record<string, unknown>;
  for (const k of PARAM_KEYS) if (typeof obj[k] === 'string') return short(obj[k] as string);
  const first = Object.values(obj).find((v) => typeof v === 'string');
  return typeof first === 'string' ? short(first) : '';
}

function n(v: unknown): string {
  return typeof v === 'number' ? v.toLocaleString('en-US') : '0';
}

/** Turns one stream-json event into a readable line, or null for events not worth showing. */
export function formatTraceEvent(line: string, state: TraceState): string | null {
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
    return `model call ${state.calls} (${n(u['input_tokens'])} in, ${n(u['cache_read_tokens'])} cached, ${n(u['output_tokens'])} out, ${Number(s['duration_seconds'] ?? 0).toFixed(1)} s)${said}`;
  }
  return null;
}

/** Prints a whole trace, or follows it while the session writes it, until the session ends. */
export async function printTrace(file: string, follow: boolean, write: (line: string) => void): Promise<void> {
  const state: TraceState = { calls: 0, text: '' };
  let offset = 0;
  let partial = '';
  const drain = (): boolean => {
    if (!fs.existsSync(file)) return false;
    const size = fs.statSync(file).size;
    if (size <= offset) return false;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    offset = size;
    const lines = (partial + buf.toString('utf-8')).split('\n');
    partial = lines.pop() ?? '';
    let ended = false;
    for (const l of lines) {
      const out = formatTraceEvent(l, state);
      if (out) write(out);
      if (l.includes('"event":"result"') || l.includes('"event": "result"')) ended = true;
    }
    return ended;
  };
  if (drain() || !follow) return;
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    if (drain()) return;
  }
}
