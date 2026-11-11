import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { noteChildExit } from './interrupt.js';
import type { TokenUsage } from './usage.js';
import type { AgentVendor } from './vendor.js';
import { antigravity } from './vendors/antigravity.js';
import { vendorFor } from './vendors/index.js';

export { addUsage, ZERO_USAGE, type ParsedSession, type TokenUsage } from './usage.js';
export { agyArgs, parseAntigravityJson, parseAntigravityStream } from './vendors/antigravity.js';

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

export interface AgentCliOptions {
  model: string;
  timeoutMs: number;
  /** Binary to run. Default: the vendor's CLI, e.g. "agy" or "claude". */
  binary?: string;
  /** Environment for the agent session. Default: the current process environment. */
  env?: NodeJS.ProcessEnv;
  /** Folder for per-session traces (the CLI's JSON events, one per line). Default: the OS temp folder. */
  logDir?: string;
  /** Called with the trace path when a session starts, so a person can follow it live. */
  onSessionStart?: (traceFile: string) => void;
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
export function sessionResult(vendor: AgentVendor, traceFile: string, exit: SessionExit, seconds: number): AgentRunResult {
  const parsed = vendor.parse(fs.readFileSync(traceFile, 'utf-8'));
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
  const exitError =
    exit.status !== null && exit.status !== 0
      ? (vendor.exitError?.(exit.status, seconds, stderrTail) ?? `Agent exited with code ${exit.status}. ${stderrTail}`.trim())
      : undefined;
  const error = parsed.error ?? exitError;
  return { ...base, ...(error !== undefined ? { error } : {}) };
}

/**
 * How long the loop waits for a session before killing it. A CLI that stops
 * itself gets a minute of grace to write its result; one that does not is
 * killed at the limit.
 */
export function sessionDeadlineMs(vendor: AgentVendor, timeoutMs: number): number {
  return vendor.enforcesTimeout ? timeoutMs + 60_000 : timeoutMs;
}

/**
 * Runs an agent CLI headless on the host with every tool permission
 * auto-approved. The loop, not the agent, decides what is kept: protected
 * paths, locked tests and commits are enforced after each session.
 */
export class AgentCliRunner implements AgentRunner {
  readonly name: string;
  readonly model: string;

  constructor(
    readonly vendor: AgentVendor,
    private readonly opts: AgentCliOptions,
  ) {
    this.model = opts.model;
    this.name = vendor.id;
  }

  run(prompt: string, cwd: string): AgentRunResult {
    const seconds = Math.max(1, Math.round(this.opts.timeoutMs / 1000));
    const { traceFile, fd } = openTrace(this.opts.logDir, this.opts.onSessionStart);
    let res;
    try {
      res = spawnSync(
        'bash',
        ['-c', PROCESS_GROUP_WRAPPER, 'agentic-loop-agent', this.opts.binary ?? this.vendor.binary, ...this.vendor.args(promptArgument(prompt, cwd), this.opts.model, seconds)],
        // stdin is closed: agent CLIs can wait forever on an open, unused stdin when run as a subprocess.
        // stdout goes straight to the trace file, so it can be followed while the session runs.
        { cwd, env: this.opts.env ?? process.env, stdio: ['ignore', fd, 'pipe'], encoding: 'utf-8', timeout: sessionDeadlineMs(this.vendor, this.opts.timeoutMs), maxBuffer: 64 * 1024 * 1024 },
      );
    } finally {
      fs.closeSync(fd);
    }
    return sessionResult(this.vendor, traceFile, { status: res.status, signal: res.signal, stderr: res.stderr ?? '', ...(res.error ? { error: res.error } : {}) }, seconds);
  }
}

/** Runs Antigravity CLI (`agy`) on the host. Kept for callers of the 0.3 API. */
export class AntigravityCliRunner extends AgentCliRunner {
  constructor(opts: AgentCliOptions) {
    super(antigravity, opts);
  }
}

/** A host runner for the vendor named in the config's `runner`. */
export function createRunner(runner: string, opts: AgentCliOptions): AgentRunner {
  return new AgentCliRunner(vendorFor(runner), opts);
}
