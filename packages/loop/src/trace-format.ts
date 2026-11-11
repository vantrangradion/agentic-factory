/** State carried across trace lines: model call count and the reply being streamed. */
export interface TraceState {
  calls: number;
  text: string;
}

export const newTraceState = (): TraceState => ({ calls: 0, text: '' });

const PARAM_KEYS = ['CommandLine', 'command', 'Path', 'AbsolutePath', 'TargetFile', 'path', 'file_path', 'Query', 'query', 'pattern', 'Url', 'url'];

export function short(s: string, n = 100): string {
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

/** A token count for people to read. */
export function count(v: unknown): string {
  return typeof v === 'number' ? v.toLocaleString('en-US') : '0';
}
