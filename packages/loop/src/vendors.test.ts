import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkAgentSandbox, DockerAgentRunner, loginCommands, startScript, type DockerSpawn } from './agent-sandbox.js';
import { AgentConfigError, resolveAgentConfig, type ResolvedSandbox } from './config.js';
import type { CommandOutcome } from './gates.js';
import { AgentCliRunner, createRunner } from './runner.js';
import type { DockerCli } from './sandbox.js';
import { formatTraceEvent } from './trace.js';
import { newTraceState } from './trace-format.js';
import { antigravity, claudeCode, vendorFor } from './vendors/index.js';
import { parseClaudeStream } from './vendors/claude-code.js';

// Shaped like Claude Code 2.1 `-p --output-format stream-json --verbose`: one response split over two
// assistant events that share message.id, a tool result, a second response, then the result.
const ev = (o: unknown) => JSON.stringify(o);
const INIT = ev({ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5', permissionMode: 'bypassPermissions', tools: ['Read'], session_id: 's' });
const placeholderUsage = { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 1000, output_tokens: 1 };
const A1_TEXT = ev({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Reading the file.' }], usage: placeholderUsage }, parent_tool_use_id: null });
const A1_TOOL = ev({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/work/a.txt' } }], usage: placeholderUsage }, parent_tool_use_id: null });
const TOOL_RESULT = ev({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'hello from the file' }] }, parent_tool_use_id: null });
const A2 = ev({ type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: 'hello from the file' }], usage: { input_tokens: 5, cache_read_input_tokens: 1200, output_tokens: 1 } }, parent_tool_use_id: null });
const RESULT = ev({
  type: 'result', subtype: 'success', is_error: false, result: 'hello from the file', num_turns: 2, duration_ms: 4200,
  total_cost_usd: 0.01,
  usage: { input_tokens: 15, cache_creation_input_tokens: 200, cache_read_input_tokens: 2200, output_tokens: 80 },
  modelUsage: { 'claude-sonnet-5-5': { inputTokens: 15, outputTokens: 80, cacheReadInputTokens: 2200, cacheCreationInputTokens: 200, costUSD: 0.01 } },
});
const STREAM = [INIT, A1_TEXT, A1_TOOL, TOOL_RESULT, A2, RESULT].join('\n');

describe('parseClaudeStream', () => {
  it('counts one model call per message id and takes token totals from the result', () => {
    expect(parseClaudeStream(STREAM)).toEqual({
      response: 'hello from the file',
      // input = 15 + 2200 cache reads + 200 cache writes; output from the result, not the per-event placeholder.
      usage: { input: 2415, cachedInput: 2200, output: 80, total: 2495, requests: 2 },
      toolCalls: { Read: 1 },
    });
  });

  it('sums every model in modelUsage, so subagent calls are charged too', () => {
    const r = JSON.parse(RESULT) as Record<string, unknown>;
    r['modelUsage'] = {
      'claude-sonnet-5-5': { inputTokens: 15, outputTokens: 80, cacheReadInputTokens: 2200, cacheCreationInputTokens: 200 },
      'claude-haiku-5-5': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    };
    expect(parseClaudeStream([A1_TEXT, ev(r)].join('\n')).usage).toEqual({ input: 2515, cachedInput: 2200, output: 100, total: 2615, requests: 1 });
  });

  it('falls back to the main conversation usage when modelUsage is missing', () => {
    const r = JSON.parse(RESULT) as Record<string, unknown>;
    delete r['modelUsage'];
    expect(parseClaudeStream([A1_TEXT, ev(r)].join('\n')).usage).toEqual({ input: 2415, cachedInput: 2200, output: 80, total: 2495, requests: 1 });
  });

  it('reports a stopped session with its errors', () => {
    const stopped = ev({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Reached max turns'], num_turns: 9, usage: {} });
    expect(parseClaudeStream([A1_TEXT, stopped].join('\n')).error).toBe('Agent stopped (error_max_turns): Reached max turns');
  });

  it('reports a success result flagged as an error', () => {
    const failed = ev({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 529 overloaded', usage: {} });
    expect(parseClaudeStream(failed).error).toBe('Agent reported an error: API Error: 529 overloaded');
  });

  it('still counts calls and input when the session was killed before its result', () => {
    expect(parseClaudeStream([INIT, A1_TEXT, A1_TOOL, TOOL_RESULT, A2].join('\n'))).toMatchObject({
      error: 'Agent ended without a result event',
      usage: { requests: 2, input: 1210 + 1205, cachedInput: 2200 },
      toolCalls: { Read: 1 },
    });
  });

  it('ignores lines that are not JSON', () => {
    expect(parseClaudeStream(`warning: something\n${RESULT}`).response).toBe('hello from the file');
  });
});

describe('trace', () => {
  it('formats Claude Code events, one model call per message id', () => {
    const state = newTraceState();
    const lines = STREAM.split('\n').map((l) => formatTraceEvent(l, state)).filter(Boolean);
    expect(lines).toEqual([
      'session start: model claude-sonnet-5-5, permission mode bypassPermissions',
      'model call 1 (1,210 in, 1,000 cached)\n  says: "Reading the file."',
      '  > Read /work/a.txt',
      '    done: hello from the file',
      'model call 2 (1,205 in, 1,200 cached)\n  says: "hello from the file"',
      'session end: success after 4 s, 2 model call(s)',
    ]);
  });

  it('knows where each vendor ends a session', () => {
    expect(claudeCode.isEndEvent(RESULT)).toBe(true);
    expect(claudeCode.isEndEvent(A2)).toBe(false);
    expect(antigravity.isEndEvent('{"event":"result","result":{}}')).toBe(true);
    expect(antigravity.isEndEvent(RESULT)).toBe(false);
  });
});

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-vendors-'));
  fs.mkdirSync(path.join(dir, '.git'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function fakeCli(body: string): string {
  const bin = path.join(dir, 'fake-claude');
  fs.writeFileSync(bin, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  return bin;
}

describe('Claude Code on the host', () => {
  it('runs claude headless with stream-json and no time-limit flag of its own', () => {
    const seen = path.join(dir, 'args.txt');
    const bin = fakeCli(`printf '%s\\n' "$@" > "${seen}"\necho '${RESULT}'`);
    const res = new AgentCliRunner(claudeCode, { model: 'claude-sonnet-5-5', timeoutMs: 20_000, binary: bin, logDir: path.join(dir, 'logs') }).run('task', dir);
    expect(res.response).toBe('hello from the file');
    // No assistant events in this trace, so the call count falls back to the result's num_turns.
    expect(res.usage.requests).toBe(2);
    expect(fs.readFileSync(seen, 'utf-8').trim().split('\n')).toEqual([
      '-p', 'task', '--model', 'claude-sonnet-5-5', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions',
    ]);
  });

  it('is killed at the session time limit, since claude has none', () => {
    const bin = fakeCli(`echo '${A1_TEXT}'\nsleep 10`);
    const started = Date.now();
    const res = new AgentCliRunner(claudeCode, { model: 'm', timeoutMs: 1000, binary: bin, logDir: path.join(dir, 'logs') }).run('task', dir);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(res.error).toBe('Agent session timed out after 1 s');
    expect(res.usage.requests).toBe(1);
  });

  it('is chosen by the runner name', () => {
    expect(createRunner('claude-code', { model: 'm', timeoutMs: 1000 }).name).toBe('claude-code');
    expect(createRunner('antigravity-cli', { model: 'm', timeoutMs: 1000 }).name).toBe('antigravity-cli');
    expect(() => vendorFor('codex')).toThrow(/antigravity-cli, claude-code/);
  });
});

const SANDBOX: ResolvedSandbox = { image: 'loop-agent:1', env: [], gateNetwork: false, memory: null, cpus: null, agent: true, authVolume: 'claude-auth' };
const outcome = (exitCode: number | null, output = ''): CommandOutcome => ({ exitCode, output, durationMs: 1, timedOut: false });

describe('Claude Code in Docker', () => {
  it('exports the saved token and runs claude in the locked-down container', () => {
    const spawned: string[][] = [];
    const spawn: DockerSpawn = (args, { stdoutFd }) => {
      spawned.push(args);
      fs.writeSync(stdoutFd, `${RESULT}\n`);
      return { status: 0, signal: null, stderr: '' };
    };
    const docker: DockerCli = () => outcome(0);
    const r = new DockerAgentRunner({ vendor: claudeCode, model: 'claude-sonnet-5-5', timeoutMs: 60_000, sandbox: SANDBOX, agentVersion: '2.1.3', logDir: path.join(dir, 'logs'), user: '501:20', spawn, docker });
    expect(r.name).toBe('claude-code in docker (claude 2.1.3)');
    expect(r.run('task', dir).response).toBe('hello from the file');
    const args = spawned[0] ?? [];
    expect(args).toContain('claude-auth:/auth:ro');
    const command = args.slice(args.indexOf('loop-agent:1') + 1);
    expect(command[2]).toContain('CLAUDE_CODE_OAUTH_TOKEN="$(cat /auth/claude-oauth-token)"');
    expect(command.slice(4)).toEqual(['claude', '-p', 'task', '--model', 'claude-sonnet-5-5', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions']);
  });

  it('keeps the agy start script unchanged', () => {
    expect(startScript(antigravity)).toBe(
      'set -e\nmkdir -p "$HOME/.gemini/antigravity-cli"\ncp /auth/antigravity-oauth-token "$HOME/.gemini/antigravity-cli/antigravity-oauth-token"\nexec "$@"',
    );
  });

  it('checks for claude and its login, and reads the bare version number', () => {
    const calls: string[][] = [];
    const cli: DockerCli = (args) => {
      calls.push(args);
      return outcome(0, '2.1.322 (Claude Code)\n');
    };
    expect(checkAgentSandbox(SANDBOX, cli, '501:20', claudeCode)).toBe('2.1.322');
    expect(calls[0]?.at(-1)).toBe('test -s /auth/claude-oauth-token || exit 3; exec claude --version');
    expect(() => checkAgentSandbox(SANDBOX, () => outcome(127), '501:20', claudeCode)).toThrow(/npm install -g @anthropic-ai\/claude-code/);
    expect(() => checkAgentSandbox(SANDBOX, () => outcome(3), '501:20', claudeCode)).toThrow(/holds no Claude Code login/);
  });

  it('signs in with setup-token and saves only the pasted token', () => {
    const [, signIn] = loginCommands(SANDBOX, '501:20', claudeCode);
    const script = signIn?.at(-1) ?? '';
    expect(script).toContain('claude setup-token');
    expect(script).toContain(`printf '%s' "$token" > /auth/claude-oauth-token`);
    expect(script.endsWith('chmod 600 /auth/claude-oauth-token')).toBe(true);
  });
});

describe('runner config', () => {
  const base = { model: 'm', gates: [{ name: 'test', run: 'true' }] };

  it('accepts claude-code and gives it its own login volume', () => {
    const c = resolveAgentConfig({ ...base, runner: 'claude-code', sandbox: { image: 'img', agent: true } });
    expect(c.runner).toBe('claude-code');
    expect(c.sandbox?.authVolume).toBe('agentic-loop-claude-auth');
    expect(resolveAgentConfig({ ...base, sandbox: { image: 'img' } }).sandbox?.authVolume).toBe('agentic-loop-agy-auth');
  });

  it('names every supported runner when one is unknown', () => {
    try {
      resolveAgentConfig({ ...base, runner: 'codex' as unknown as 'claude-code' });
      expect.unreachable();
    } catch (e) {
      expect((e as AgentConfigError).problems).toEqual(['runner "codex" is not supported; use one of: antigravity-cli, claude-code']);
    }
  });
});
