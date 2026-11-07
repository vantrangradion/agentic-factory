import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AntigravityCliRunner } from './runner.js';

// A stand-in for agy: prints a stream-json result, and optionally leaves a background process behind.
const RESULT = '{"event":"result","result":{"status":"SUCCESS","response":"done","num_turns":1,"usage":{"input_tokens":1,"output_tokens":1}}}';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-runner-'));
  fs.mkdirSync(path.join(dir, '.git'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function fakeAgent(body: string): string {
  const bin = path.join(dir, 'fake-agy');
  fs.writeFileSync(bin, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  return bin;
}

describe('AntigravityCliRunner', () => {
  it('kills background processes the agent left running when the session ends', async () => {
    const late = path.join(dir, 'late.txt');
    const bin = fakeAgent(`( sleep 1; echo late > "${late}" ) &\necho '${RESULT}'`);
    const res = new AntigravityCliRunner({ model: 'm', timeoutMs: 20_000, binary: bin, logDir: path.join(dir, 'logs') }).run('task', dir);
    expect(res.response).toBe('done');
    await new Promise((r) => setTimeout(r, 2000));
    expect(fs.existsSync(late)).toBe(false);
  });

  it('reports exit code 130 as an interruption by the user', () => {
    const bin = fakeAgent('exit 130');
    const res = new AntigravityCliRunner({ model: 'm', timeoutMs: 20_000, binary: bin, logDir: path.join(dir, 'logs') }).run('task', dir);
    expect(res.interrupted).toBe(true);
    expect(res.error).toContain('Ctrl+C');
  });

  it('moves a prompt too large for one argument into a file inside .git', () => {
    const seen = path.join(dir, 'seen.txt');
    const bin = fakeAgent(`printf '%s' "$2" > "${seen}"\necho '${RESULT}'`);
    new AntigravityCliRunner({ model: 'm', timeoutMs: 20_000, binary: bin, logDir: path.join(dir, 'logs') }).run('x'.repeat(150_000), dir);
    const taskFile = path.join(dir, '.git', 'agentic-loop-task.md');
    expect(fs.readFileSync(taskFile, 'utf-8')).toHaveLength(150_000);
    expect(fs.readFileSync(seen, 'utf-8')).toContain(taskFile);
  });
});
