import * as fs from 'node:fs';
import { newTraceState, type TraceState } from './trace-format.js';
import { VENDORS } from './vendors/index.js';

export { toolTarget, type TraceState } from './trace-format.js';

/**
 * Turns one trace line into readable text, or null for lines not worth
 * showing. Each vendor's events have their own shape, so the first vendor
 * that recognises the line formats it; a trace file needs no config to read.
 */
export function formatTraceEvent(line: string, state: TraceState): string | null {
  for (const v of Object.values(VENDORS)) {
    const out = v.formatTraceEvent(line, state);
    if (out !== null) return out;
  }
  return null;
}

function isEndEvent(line: string): boolean {
  return Object.values(VENDORS).some((v) => v.isEndEvent(line));
}

/** Prints a whole trace, or follows it while the session writes it, until the session ends. */
export async function printTrace(file: string, follow: boolean, write: (line: string) => void): Promise<void> {
  const state = newTraceState();
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
      if (isEndEvent(l)) ended = true;
    }
    return ended;
  };
  if (drain() || !follow) return;
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    if (drain()) return;
  }
}
