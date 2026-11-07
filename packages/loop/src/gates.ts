import { spawnSync } from 'node:child_process';
import type { ResolvedGate } from './config.js';
import { noteChildExit } from './interrupt.js';

export interface CommandOutcome {
  exitCode: number | null;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

/** Runs a shell command and returns combined stdout and stderr. Injected so tests never spawn processes. */
export type CommandExecutor = (command: string, cwd: string, timeoutMs: number) => CommandOutcome;

export interface GateResult {
  name: string;
  command: string;
  status: 'pass' | 'fail' | 'skipped';
  exitCode: number | null;
  durationMs: number;
  /** Last lines of output, enough for the agent to act on without flooding its context. */
  outputTail: string;
}

const TAIL_LINES = 80;
const TAIL_CHARS = 6000;

export function tail(text: string, lines = TAIL_LINES, chars = TAIL_CHARS): string {
  const byLines = text.split('\n').slice(-lines).join('\n');
  return byLines.length > chars ? byLines.slice(-chars) : byLines;
}

/** A shell executor. Pass `env` to run gates without the user's credentials (see safe-env.ts). */
export function makeShellExecutor(env?: NodeJS.ProcessEnv): CommandExecutor {
  return (command, cwd, timeoutMs) => runShell(command, cwd, timeoutMs, env);
}

export const shellExecutor: CommandExecutor = makeShellExecutor();

function runShell(command: string, cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv | undefined): CommandOutcome {
  const started = Date.now();
  const res = spawnSync('bash', ['-c', `exec 2>&1; ${command}`], {
    cwd,
    env: env ?? process.env,
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const timedOut = res.error !== undefined && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  noteChildExit(res.status, res.signal);
  return {
    exitCode: res.status,
    output: `${res.stdout ?? ''}${res.error && !timedOut ? `\n${res.error.message}` : ''}${timedOut ? `\nTimed out after ${timeoutMs} ms` : ''}`,
    durationMs: Date.now() - started,
    timedOut,
  };
}

/** Runs gates in order. With stopOnFail, gates after the first failure are reported as skipped. */
export function runGates(
  gates: readonly ResolvedGate[],
  cwd: string,
  exec: CommandExecutor,
  stopOnFail = true,
): GateResult[] {
  const results: GateResult[] = [];
  let failed = false;
  for (const gate of gates) {
    if (failed && stopOnFail) {
      results.push({ name: gate.name, command: gate.run, status: 'skipped', exitCode: null, durationMs: 0, outputTail: '' });
      continue;
    }
    const out = exec(gate.run, cwd, gate.timeoutMs);
    const pass = out.exitCode === 0 && !out.timedOut;
    if (!pass) failed = true;
    results.push({
      name: gate.name,
      command: gate.run,
      status: pass ? 'pass' : 'fail',
      exitCode: out.exitCode,
      durationMs: out.durationMs,
      outputTail: tail(out.output),
    });
  }
  return results;
}

export function firstFailure(results: readonly GateResult[]): GateResult | undefined {
  return results.find((r) => r.status === 'fail');
}
