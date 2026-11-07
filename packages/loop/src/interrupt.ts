/**
 * Ctrl+C reaches the loop's child processes (the agent and the gates) while
 * the loop itself is blocked waiting for them, so its own SIGINT handler
 * cannot run until much later. A child that ended because of SIGINT (or
 * exited with 130, the shell convention) therefore marks the whole run as
 * interrupted, and the loop checks this after every session and gate run.
 */
let interrupted = false;

export function noteChildExit(status: number | null, signal: NodeJS.Signals | null): void {
  if (signal === 'SIGINT' || status === 130) interrupted = true;
}

export function markInterrupted(): void {
  interrupted = true;
}

export function wasInterrupted(): boolean {
  return interrupted;
}
