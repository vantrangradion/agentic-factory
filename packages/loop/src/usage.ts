export interface TokenUsage {
  input: number;
  cachedInput: number;
  output: number;
  total: number;
  /** Model requests (agent turns). Seat-based plans cap these per day. */
  requests: number;
}

export const ZERO_USAGE: TokenUsage = { input: 0, cachedInput: 0, output: 0, total: 0, requests: 0 };

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    cachedInput: a.cachedInput + b.cachedInput,
    output: a.output + b.output,
    total: a.total + b.total,
    requests: a.requests + b.requests,
  };
}

/** A finite number, or 0. */
export function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** What one session's trace says: the final reply, totals, tool calls and any error. */
export interface ParsedSession {
  response: string;
  usage: TokenUsage;
  error?: string;
  toolCalls: Record<string, number>;
}
