import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkAgentSandbox, DockerAgentRunner, loginCommands, type DockerSpawn } from './agent-sandbox.js';
import { AgentConfigError, resolveAgentConfig, type ResolvedSandbox } from './config.js';
import type { CommandOutcome } from './gates.js';
import type { DockerCli } from './sandbox.js';

const SANDBOX: ResolvedSandbox = { image: 'loop-agent:1', env: ['NPM_TOKEN'], gateNetwork: false, memory: '4g', cpus: 2, agent: true, authVolume: 'agy-auth' };
const RESULT = '{"event":"result","result":{"status":"SUCCESS","response":"done","num_turns":1,"usage":{"input_tokens":5,"output_tokens":2}}}';
const outcome = (exitCode: number | null, output = ''): CommandOutcome => ({ exitCode, output, durationMs: 1, timedOut: false });
const valueAfter = (args: string[], flag: string): string[] => args.flatMap((a, i) => (a === flag ? [args[i + 1] ?? ''] : []));

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-agent-sandbox-'));
  fs.mkdirSync(path.join(dir, '.git'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Records docker calls; the spawn writes `stdout` to the trace and ends as told. */
function fakeDocker(exit: Partial<ReturnType<DockerSpawn>> = {}, stdout = RESULT) {
  const spawned: string[][] = [];
  const cli: string[][] = [];
  const spawn: DockerSpawn = (args, { stdoutFd }) => {
    spawned.push(args);
    fs.writeSync(stdoutFd, `${stdout}\n`);
    return { status: 0, signal: null, stderr: '', ...exit };
  };
  const docker: DockerCli = (args) => {
    cli.push(args);
    return outcome(0);
  };
  return { spawn, docker, spawned, cli };
}

function runner(fake: ReturnType<typeof fakeDocker>, timeoutMs = 60_000) {
  return new DockerAgentRunner({ model: 'gemini-x', timeoutMs, sandbox: SANDBOX, agentVersion: '1.5.5', logDir: path.join(dir, 'logs'), user: '501:20', spawn: fake.spawn, docker: fake.docker });
}

describe('DockerAgentRunner', () => {
  it('runs agy in a locked-down container that sees only the clone and the login', () => {
    const fake = fakeDocker();
    const res = runner(fake).run('write the tests', dir);
    expect(res.response).toBe('done');
    expect(res.usage.output).toBe(2);

    const args = fake.spawned[0] ?? [];
    expect(args.slice(0, 2)).toEqual(['run', '--rm']);
    expect(valueAfter(args, '--network')).toEqual(['bridge']);
    expect(valueAfter(args, '--cap-drop')).toEqual(['ALL']);
    expect(valueAfter(args, '--security-opt')).toEqual(['no-new-privileges']);
    expect(args).toContain('--read-only');
    expect(valueAfter(args, '--user')).toEqual(['501:20']);
    expect(valueAfter(args, '--memory')).toEqual(['4g']);
    expect(valueAfter(args, '--cpus')).toEqual(['2']);
    expect(valueAfter(args, '--tmpfs')).toContain('/home/agent:uid=501,gid=20,mode=0700,size=1g');
    expect(valueAfter(args, '--volume')).toEqual([`${dir}:/work`, `${path.join(dir, '.git')}:/work/.git:ro`, 'agy-auth:/auth:ro']);
    expect(valueAfter(args, '--workdir')).toEqual(['/work']);
    // No host environment, not even the names gates may receive.
    expect(valueAfter(args, '--env')).toEqual(['HOME=/home/agent']);
    expect(args.join(' ')).not.toContain('docker.sock');

    const image = args.indexOf('loop-agent:1');
    expect(image).toBeGreaterThan(0);
    const command = args.slice(image + 1);
    expect(command[2]).toContain('cp /auth/antigravity-oauth-token');
    expect(command.slice(4)).toEqual(['agy', '-p', 'write the tests', '--model', 'gemini-x', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--print-timeout', '60s']);
  });

  it('names the agy version in the run record', () => {
    expect(runner(fakeDocker()).name).toBe('antigravity-cli in docker (agy 1.5.5)');
  });

  it('always removes the container, so nothing the agent started keeps running', () => {
    const fake = fakeDocker({ status: null, error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }, '');
    const res = runner(fake, 5_000).run('task', dir);
    expect(res.error).toBe('Agent session timed out after 5 s');
    const name = valueAfter(fake.spawned[0] ?? [], '--name')[0];
    expect(fake.cli).toEqual([['rm', '--force', name]]);
  });

  it('reports Ctrl+C as an interruption by the user', () => {
    const res = runner(fakeDocker({ status: 130 }, '')).run('task', dir);
    expect(res.interrupted).toBe(true);
  });

  it('points a prompt too large for one argument at the task file inside the container', () => {
    const fake = fakeDocker();
    runner(fake).run('x'.repeat(150_000), dir);
    expect(fs.readFileSync(path.join(dir, '.git', 'agentic-loop-task.md'), 'utf-8')).toHaveLength(150_000);
    const promptArg = valueAfter(fake.spawned[0] ?? [], '-p')[0];
    expect(promptArg).toContain('/work/.git/agentic-loop-task.md');
    expect(promptArg).not.toContain(dir);
  });
});

describe('checkAgentSandbox', () => {
  const docker = (answer: CommandOutcome) => {
    const calls: string[][] = [];
    const cli: DockerCli = (args) => {
      calls.push(args);
      return answer;
    };
    return { cli, calls };
  };

  it('returns the agy version, checked without network', () => {
    const d = docker(outcome(0, '1.5.5\n'));
    expect(checkAgentSandbox(SANDBOX, d.cli, '501:20')).toBe('1.5.5');
    expect(valueAfter(d.calls[0] ?? [], '--network')).toEqual(['none']);
    expect(valueAfter(d.calls[0] ?? [], '--volume')).toEqual(['agy-auth:/auth:ro']);
  });

  it('says to run login when the volume holds no login', () => {
    expect(() => checkAgentSandbox(SANDBOX, docker(outcome(3)).cli)).toThrow(/agentic-loop login/);
  });

  it('says how to install agy when the image has none', () => {
    expect(() => checkAgentSandbox(SANDBOX, docker(outcome(127)).cli)).toThrow(/install\.sh/);
  });
});

describe('loginCommands', () => {
  it('gives the volume to the user, then signs in with a terminal and saves only the token', () => {
    const [own, signIn] = loginCommands(SANDBOX, '501:20');
    expect(own?.at(-1)).toBe('chown 501:20 /auth && chmod 700 /auth');
    expect(valueAfter(own ?? [], '--network')).toEqual(['none']);
    expect(signIn).toContain('-it');
    expect(valueAfter(signIn ?? [], '--volume')).toEqual(['agy-auth:/auth']);
    expect(signIn?.at(-1)).toContain('cp "$HOME/.gemini/antigravity-cli/antigravity-oauth-token" /auth/antigravity-oauth-token');
  });
});

describe('sandbox.agent config', () => {
  const base = { model: 'm', gates: [{ name: 'test', run: 'true' }] };

  it('defaults to the host and a shared login volume', () => {
    const c = resolveAgentConfig({ ...base, sandbox: { image: 'img' } });
    expect(c.sandbox).toMatchObject({ agent: false, authVolume: 'agentic-loop-agy-auth' });
  });

  it('rejects a non-boolean agent and a bad volume name', () => {
    try {
      resolveAgentConfig({ ...base, sandbox: { image: 'img', agent: 'yes' as unknown as boolean, authVolume: '../home' } });
      expect.unreachable();
    } catch (e) {
      expect((e as AgentConfigError).problems).toEqual([
        'sandbox.agent must be true or false',
        'sandbox.authVolume must be a Docker volume name, e.g. "agentic-loop-agy-auth"',
      ]);
    }
  });
});
