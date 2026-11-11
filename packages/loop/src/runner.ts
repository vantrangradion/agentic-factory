import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { noteChildExit } from './interrupt.js';
import * as path from 'node:path';

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

export interface AgentRunResult {
  exitCode: number | null;
  /** The agent's final message. */
  response: string;
  usage: TokenUsage;
  error?: string;
  /** Tool calls by tool name, from the session trace. */
  toolCalls?: Record<string, number>;
  /** The session ended because the user pressed Ctrl+C. */
  interrupted?: boolean;
}

/**
 * Runs the agent in its own process group and kills that whole group when the
 * agent exits, so background processes it started cannot keep changing files
 * after the loop has checked them. Ctrl+C is forwarded to the group, and the
 * wrapper then exits with 130 so the loop knows the user stopped it.
 */
const PROCESS_GROUP_WRAPPER = [
  'set -m',
  '"$@" &',
  'pid=$!',
  'interrupted=0',
  "trap 'interrupted=1; kill -INT -- -$pid 2>/dev/null' INT",
  "trap 'kill -TERM -- -$pid 2>/dev/null' TERM",
  'code=0',
  'while :; do wait $pid; code=$?; kill -0 $pid 2>/dev/null || break; done',
  'kill -KILL -- -$pid 2>/dev/null',
  '[ "$interrupted" = 1 ] && exit 130',
  'exit $code',
].join('\n');

/** Prompts above this size go in a file: one command-line argument is limited to 128 KiB on Linux. */
const MAX_ARG_PROMPT_BYTES = 100_000;

/** One agent session: a prompt in, file edits in `cwd` and a final message out. */
export interface AgentRunner {
  readonly name: string;
  readonly model: string;
  run(prompt: string, cwd: string): AgentRunResult;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export interface AgentCliOptions {
  model: string;
  timeoutMs: number;
  /** Binary to run. Default "agy". */
  binary?: string;
  /** Environment for the agent session. Default: the current process environment. */
  env?: NodeJS.ProcessEnv;
  /** Folder for per-session traces (agy stream-json events, one JSON object per line). Default: the OS temp folder. */
  logDir?: string;
  /** Called with the trace path when a session starts, so a person can follow it live. */
  onSessionStart?: (traceFile: string) => void;
}

/**
 * Reads an agy `--output-format stream-json` trace. The `result` event holds
 * the reply and totals; each finished `agent_response` step is one model call,
 * which is what seat quotas count; each finished `tool` step is one tool call.
 */
export function parseAntigravityStream(ndjson: string): { response: string; usage: TokenUsage; error?: string; toolCalls: Record<string, number> } {
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
 * Returns the `-p` argument for a prompt. A prompt too large for one argument
 * is written to a file inside `.git` (never committed, but readable by the
 * agent), and the argument points there. `visibleCwd` is where the agent sees
 * `cwd`: the same folder on the host, or its mount point in a container.
 */
export function promptArgument(prompt: string, cwd: string, visibleCwd: string = cwd): string {
  if (Buffer.byteLength(prompt) <= MAX_ARG_PROMPT_BYTES) return prompt;
  fs.writeFileSync(path.join(cwd, '.git', TASK_FILE), prompt);
  const seen = path.posix.join(visibleCwd.split(path.sep).join('/'), '.git', TASK_FILE);
  return `Your full task is in the file ${seen}. Read all of it first, then carry it out exactly as written there.`;
}

const TASK_FILE = 'agentic-loop-task.md';

/** The agy arguments for one headless session with every tool permission auto-approved. */
export function agyArgs(promptArg: string, model: string, seconds: number): string[] {
  return ['-p', promptArg, '--model', model, '--output-format', 'stream-json', '--dangerously-skip-permissions', '--print-timeout', `${seconds}s`];
}

/** Creates the trace file for one session and reports its path. The caller closes the descriptor. */
export function openTrace(logDir: string | undefined, onSessionStart?: (traceFile: string) => void): { traceFile: string; fd: number } {
  const dir = logDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-loop-'));
  fs.mkdirSync(dir, { recursive: true });
  const traceFile = path.join(dir, `session-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`);
  const fd = fs.openSync(traceFile, 'w');
  onSessionStart?.(traceFile);
  return { traceFile, fd };
}

/** How the session process ended. */
export interface SessionExit {
  status: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  error?: Error;
}

/** Turns a finished session (its trace and how the process ended) into a result. */
export function sessionResult(traceFile: string, exit: SessionExit, seconds: number): AgentRunResult {
  const parsed = parseAntigravityStream(fs.readFileSync(traceFile, 'utf-8'));
  noteChildExit(exit.status, exit.signal);
  const base = { exitCode: exit.status, response: parsed.response, usage: parsed.usage, toolCalls: parsed.toolCalls };
  if (exit.status === 130 || exit.signal === 'SIGINT') {
    return { ...base, interrupted: true, error: 'Stopped by the user (Ctrl+C)' };
  }
  if (exit.error) {
    const timedOut = (exit.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    return { ...base, error: timedOut ? `Agent session timed out after ${seconds} s` : exit.error.message };
  }
  const stderrTail = exit.stderr.trim().split('\n').slice(-20).join('\n');
  // agy 1.5.0+ exits with code 3 when --print-timeout cuts a turn short.
  const exitError =
    exit.status === 3
      ? `Agent session hit its ${seconds} s time limit. ${stderrTail}`.trim()
      : exit.status !== 0
        ? `Agent exited with code ${exit.status}. ${stderrTail}`.trim()
        : undefined;
  const error = parsed.error ?? exitError;
  return { ...base, ...(error !== undefined ? { error } : {}) };
}

/**
 * Runs Antigravity CLI (`agy`) headless on the host with every tool
 * permission auto-approved. The loop, not the agent, decides what is kept:
 * protected paths, locked tests and commits are enforced after each session.
 */
export class AntigravityCliRunner implements AgentRunner {
  readonly name = 'antigravity-cli';
  readonly model: string;

  constructor(private readonly opts: AgentCliOptions) {
    this.model = opts.model;
  }

  run(prompt: string, cwd: string): AgentRunResult {
    const seconds = Math.max(1, Math.round(this.opts.timeoutMs / 1000));
    const { traceFile, fd } = openTrace(this.opts.logDir, this.opts.onSessionStart);
    let res;
    try {
      res = spawnSync(
        'bash',
        ['-c', PROCESS_GROUP_WRAPPER, 'agentic-loop-agent', this.opts.binary ?? 'agy', ...agyArgs(promptArgument(prompt, cwd), this.opts.model, seconds)],
        // stdin is closed: agy waits forever on an open, unused stdin when run as a subprocess.
        // stdout goes straight to the trace file, so it can be followed while the session runs.
        { cwd, env: this.opts.env ?? process.env, stdio: ['ignore', fd, 'pipe'], encoding: 'utf-8', timeout: this.opts.timeoutMs + 60_000, maxBuffer: 64 * 1024 * 1024 },
      );
    } finally {
      fs.closeSync(fd);
    }
    return sessionResult(traceFile, { status: res.status, signal: res.signal, stderr: res.stderr ?? '', ...(res.error ? { error: res.error } : {}) }, seconds);
  }
}

export function createRunner(_runner: 'antigravity-cli', opts: AgentCliOptions): AgentRunner {
  return new AntigravityCliRunner(opts);
}
