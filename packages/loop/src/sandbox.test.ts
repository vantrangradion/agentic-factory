import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentConfigError, resolveAgentConfig, type ResolvedSandbox } from './config.js';
import type { CommandOutcome } from './gates.js';
import { createGitOps } from './git.js';
import { runLoop } from './loop.js';
import type { AgentRunner } from './runner.js';
import { assertDockerAvailable, createDockerGateRunner, SANDBOX_SETUP, stageFiles, type DockerCli } from './sandbox.js';
import { shellExecutor } from './gates.js';

const SANDBOX: ResolvedSandbox = { image: 'loop-test:1', env: [], gateNetwork: false, memory: null, cpus: null, agent: false, authVolume: 'agentic-loop-agy-auth' };

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-sandbox-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const write = (dir: string, file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
const ok = (output = ''): CommandOutcome => ({ exitCode: 0, output, durationMs: 1, timedOut: false });

/** Records every docker call and answers from a script. */
function recordingDocker(answer: (args: string[]) => CommandOutcome = () => ok()): DockerCli & { calls: string[][] } {
  const calls: string[][] = [];
  const cli = ((args: string[]) => {
    calls.push(args);
    return answer(args);
  }) as unknown as DockerCli & { calls: string[][] };
  cli.calls = calls;
  return cli;
}

/** Stands in for Docker by running the command on the host in the folder mounted at /work. */
const hostDocker: DockerCli = (args, timeoutMs) => {
  const vol = args[args.indexOf('--volume') + 1] ?? '';
  const dir = vol.slice(0, vol.lastIndexOf(':/work'));
  const res = spawnSync('bash', ['-c', args[args.length - 1] ?? ''], { cwd: dir, encoding: 'utf-8', timeout: timeoutMs });
  return { exitCode: res.status, output: `${res.stdout}${res.stderr}`, durationMs: 1, timedOut: false };
};

const valueAfter = (args: string[], flag: string): string[] => args.flatMap((a, i) => (a === flag ? [args[i + 1] ?? ''] : []));

describe('stageFiles', () => {
  it('copies only the listed files and keeps symlinks as links', () => {
    const src = path.join(tmp, 'src');
    write(src, 'a.txt', 'a');
    write(src, 'dir/b.sh', 'b');
    fs.chmodSync(path.join(src, 'dir/b.sh'), 0o755);
    write(src, 'ignored.txt', 'secret');
    fs.symlinkSync('/etc/hosts', path.join(src, 'link'));

    const dest = path.join(tmp, 'dest');
    write(dest, 'stale.txt', 'old');
    stageFiles(src, dest, ['a.txt', 'dir/b.sh', 'link']);

    expect(fs.readdirSync(dest).sort()).toEqual(['a.txt', 'dir', 'link']);
    expect(fs.statSync(path.join(dest, 'dir/b.sh')).mode & 0o777).toBe(0o755);
    expect(fs.lstatSync(path.join(dest, 'link')).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(dest, 'link'))).toBe('/etc/hosts');
  });

  it('refuses paths that leave the copy', () => {
    write(tmp, 'x', 'x');
    expect(() => stageFiles(path.join(tmp, 'src'), path.join(tmp, 'dest'), ['../x'])).toThrow(/outside/);
  });
});

describe('createDockerGateRunner', () => {
  const gates = [
    { name: 'build', run: 'pnpm build', timeoutMs: 1000 },
    { name: 'test', run: 'pnpm test', timeoutMs: 1000 },
  ];

  function runner(docker: DockerCli, overrides: Partial<ResolvedSandbox> = {}, setup: string | null = 'pnpm install') {
    write(tmp, 'repo/package.json', '{}');
    return createDockerGateRunner({
      sandbox: { ...SANDBOX, ...overrides },
      setup,
      listFiles: () => ['package.json'],
      stagingDir: path.join(tmp, 'gates'),
      cacheDir: path.join(tmp, 'cache'),
      env: { ALLOWED: 'yes', GH_TOKEN: 'not-for-containers' },
      docker,
      user: '501:20',
    });
  }

  it('runs setup with network and the cache, then each gate without network', () => {
    const docker = recordingDocker();
    const results = runner(docker, { env: ['ALLOWED', 'MISSING'] })(gates, path.join(tmp, 'repo'));

    expect(results.map((r) => `${r.name}:${r.status}`)).toEqual(['build:pass', 'test:pass']);
    const [setup, build, test] = docker.calls;
    expect(valueAfter(setup!, '--network')).toEqual(['bridge']);
    expect(valueAfter(setup!, '--volume')).toContain(`${path.join(tmp, 'cache')}:/cache`);
    for (const call of [build!, test!]) {
      expect(valueAfter(call, '--network')).toEqual(['none']);
      expect(valueAfter(call, '--volume')).toEqual([`${path.join(tmp, 'gates')}:/work`]);
    }
    for (const call of docker.calls) {
      expect(call).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', '--user', '501:20', 'loop-test:1']));
      expect(valueAfter(call, '--env')).toContain('ALLOWED=yes');
      expect(call.join(' ')).not.toContain('not-for-containers');
      expect(call.join(' ')).not.toContain('MISSING');
    }
    expect(build!.at(-1)).toBe('exec 2>&1; pnpm build');
  });

  it('gives gates network only when asked', () => {
    const docker = recordingDocker();
    runner(docker, { gateNetwork: true }, null)(gates, path.join(tmp, 'repo'));
    expect(docker.calls.map((c) => valueAfter(c, '--network')[0])).toEqual(['bridge', 'bridge']);
  });

  it('reports a failed setup and skips every gate', () => {
    const docker = recordingDocker((args) => (args.at(-1)?.includes('install') ? { exitCode: 1, output: 'ERR_PNPM_OUTDATED_LOCKFILE', durationMs: 1, timedOut: false } : ok()));
    const results = runner(docker)(gates, path.join(tmp, 'repo'));

    expect(results.map((r) => `${r.name}:${r.status}`)).toEqual([`${SANDBOX_SETUP}:fail`, 'build:skipped', 'test:skipped']);
    expect(results[0]?.outputTail).toContain('ERR_PNPM_OUTDATED_LOCKFILE');
    expect(docker.calls).toHaveLength(1);
  });

  it('removes the container when a gate times out', () => {
    const docker = recordingDocker((args) => (args.at(-1)?.includes('pnpm test') ? { exitCode: null, output: '', durationMs: 1, timedOut: true } : ok()));
    const results = runner(docker, {}, null)(gates, path.join(tmp, 'repo'));

    expect(results[1]?.status).toBe('fail');
    const name = valueAfter(docker.calls[1]!, '--name')[0];
    expect(docker.calls[2]).toEqual(['rm', '--force', name]);
  });
});

describe('assertDockerAvailable', () => {
  it('explains what to do when the daemon is down', () => {
    const docker = recordingDocker(() => ({ exitCode: 1, output: 'Cannot connect to the Docker daemon', durationMs: 1, timedOut: false }));
    expect(() => assertDockerAvailable(docker)).toThrow(/Start Docker, or remove "sandbox"/);
  });
});

describe('sandbox config', () => {
  const base = { model: 'm', gates: [{ name: 'test', run: 'true' }] };

  it('is off by default and fills defaults when set', () => {
    expect(resolveAgentConfig(base).sandbox).toBeNull();
    expect(resolveAgentConfig({ ...base, sandbox: { image: 'node:22' } }).sandbox).toEqual({ image: 'node:22', env: [], gateNetwork: false, memory: null, cpus: null, agent: false, authVolume: 'agentic-loop-agy-auth' });
  });

  it('lists every problem', () => {
    try {
      resolveAgentConfig({ ...base, sandbox: { image: ' ', env: ['OK', 'not ok'], memory: 'lots', cpus: 0 } });
      expect.unreachable();
    } catch (e) {
      expect((e as AgentConfigError).problems).toEqual([
        "sandbox.image is required: a Docker image with the project's toolchain",
        'sandbox.env must be a list of environment variable names',
        'sandbox.memory must look like "4g"',
        'sandbox.cpus must be greater than 0',
      ]);
    }
  });
});

describe('filesToCommit', () => {
  it('lists tracked and new files, without ignored or deleted ones', () => {
    git(tmp, 'init', '--quiet', '-b', 'main');
    write(tmp, '.gitignore', 'dist/\n*.log\n');
    write(tmp, 'kept.txt', 'k');
    write(tmp, 'gone.txt', 'g');
    git(tmp, 'add', '--all');
    git(tmp, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'init');
    fs.rmSync(path.join(tmp, 'gone.txt'));
    write(tmp, 'new.txt', 'n');
    write(tmp, 'dist/out.js', 'built');
    write(tmp, 'debug.log', 'x');

    expect(createGitOps(tmp).filesToCommit()).toEqual(['.gitignore', 'kept.txt', 'new.txt']);
  });
});

describe('runLoop with the Docker gate runner', () => {
  const issue = { number: 3, title: 'Make it build', body: '', labels: [] };

  function repo(): string {
    const dir = path.join(tmp, 'repo');
    fs.mkdirSync(dir);
    git(dir, 'init', '--quiet', '-b', 'main');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'commit.gpgsign', 'false');
    write(dir, '.gitignore', 'build.ok\n');
    write(dir, 'AGENTS.md', 'rules\n');
    git(dir, 'add', '--all');
    git(dir, 'commit', '--quiet', '-m', 'init');
    return dir;
  }

  function agent(steps: ((cwd: string) => void)[]): AgentRunner {
    let i = 0;
    return {
      name: 'scripted',
      model: 'm',
      run: (_prompt, cwd) => {
        steps[i++]?.(cwd);
        return { exitCode: 0, response: 'Summary: done', usage: { input: 1, cachedInput: 0, output: 1, total: 2, requests: 1 } };
      },
    };
  }

  it('does not let an ignored file make a gate pass', () => {
    const cwd = repo();
    const config = resolveAgentConfig({ model: 'm', gates: [{ name: 'test', run: 'test -f build.ok' }], tdd: { enabled: false }, plan: { approval: 'none' }, maxAttempts: 1 });
    const cheat = agent([(dir) => {
      write(dir, 'build.ok', '');
      write(dir, 'src.txt', 'change');
    }]);
    const gitOps = createGitOps(cwd);
    const deps = { runner: cheat, git: gitOps, exec: shellExecutor, cwd, now: () => new Date('2026-11-08T00:00:00Z'), log: () => {} };

    const sandboxed = runLoop(issue, config, [], {
      ...deps,
      runGates: createDockerGateRunner({ sandbox: SANDBOX, setup: null, listFiles: () => gitOps.filesToCommit(), stagingDir: path.join(tmp, 'gates'), cacheDir: path.join(tmp, 'cache'), env: {}, docker: hostDocker }),
    }, { stage: 'full' });

    expect(sandboxed.passed).toBe(false);
    expect(sandboxed.finalGates[0]?.status).toBe('fail');
  });

  it('does not take a failed setup as proof that the red tests fail', () => {
    const cwd = repo();
    const config = resolveAgentConfig({ model: 'm', gates: [{ name: 'test', run: 'false' }], plan: { approval: 'required' }, maxAttempts: 1, setup: 'exit 7' });
    const gitOps = createGitOps(cwd);
    const result = runLoop(issue, config, [], {
      runner: agent([(dir) => write(dir, 'a.test.ts', 'fails')]),
      git: gitOps,
      exec: shellExecutor,
      cwd,
      now: () => new Date('2026-11-08T00:00:00Z'),
      log: () => {},
      runGates: createDockerGateRunner({ sandbox: SANDBOX, setup: config.setup, listFiles: () => gitOps.filesToCommit(), stagingDir: path.join(tmp, 'gates'), cacheDir: path.join(tmp, 'cache'), env: {}, docker: hostDocker }),
    }, { stage: 'plan' });

    expect(result.passed).toBe(false);
    expect(result.commits).toEqual([]);
    expect(result.record.caughtBy).toEqual([SANDBOX_SETUP]);
    expect(result.record.phases[0]?.attempts[0]?.failure).toBe(`gate:${SANDBOX_SETUP}`);
  });
});
