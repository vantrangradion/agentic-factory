import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ResolvedGate, ResolvedSandbox } from './config.js';
import { runGates, tail, type CommandOutcome, type GateResult } from './gates.js';
import { noteChildExit } from './interrupt.js';

/**
 * Runs a gate ladder. The default runs each gate on the host in the working
 * folder; the Docker runner below runs them in containers on a clean copy.
 */
export type GateRunner = (gates: readonly ResolvedGate[], cwd: string) => GateResult[];

/** Name of the result reported when sandbox setup fails. The spaces keep it apart from any configured gate name. */
export const SANDBOX_SETUP = 'sandbox setup';

const SETUP_TIMEOUT_MS = 20 * 60 * 1000;
const KILL_TIMEOUT_MS = 30 * 1000;

/** Runs `docker` with the given arguments. Injected so tests never need Docker. */
export type DockerCli = (args: string[], timeoutMs: number) => CommandOutcome;

export const dockerCli: DockerCli = (args, timeoutMs) => {
  const started = Date.now();
  const res = spawnSync('docker', args, { encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const timedOut = res.error !== undefined && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  noteChildExit(res.status, res.signal);
  return {
    exitCode: res.status,
    output: `${res.stdout ?? ''}${res.stderr ?? ''}${res.error && !timedOut ? `\n${res.error.message}` : ''}${timedOut ? `\nTimed out after ${timeoutMs} ms` : ''}`,
    durationMs: Date.now() - started,
    timedOut,
  };
};

/** Copies files to `dest`, keeping their paths. Symlinks are recreated as links, never followed. */
export function stageFiles(src: string, dest: string, files: readonly string[]): void {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const root = path.resolve(dest);
  for (const file of files) {
    const to = path.resolve(root, file);
    if (!to.startsWith(root + path.sep)) throw new Error(`Refusing to stage a path outside the copy: ${file}`);
    const from = path.join(src, file);
    const stat = fs.lstatSync(from);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else if (stat.isFile()) {
      fs.copyFileSync(from, to, fs.constants.COPYFILE_FICLONE);
      fs.chmodSync(to, stat.mode & 0o777);
    }
    // Directories (submodules) and other types are skipped: there is nothing to copy.
  }
}

export interface DockerGateRunnerOptions {
  sandbox: ResolvedSandbox;
  /** Dependency install command, run with network before the gates. */
  setup: string | null;
  /** Files the commit would contain, relative to the working folder. */
  listFiles: (cwd: string) => string[];
  /** Folder for the clean copy; wiped before every ladder. */
  stagingDir: string;
  /** Host folder mounted at /cache during setup only, so installs are not downloaded every time. */
  cacheDir: string;
  /** Environment the `sandbox.env` names are read from. */
  env: NodeJS.ProcessEnv;
  docker?: DockerCli;
  /** Host user and group the containers run as. Default: the loop's own. */
  user?: string;
  log?: (message: string) => void;
}

/** Throws with a clear message when the Docker daemon is not reachable. */
export function assertDockerAvailable(docker: DockerCli = dockerCli): void {
  const out = docker(['version', '--format', '{{.Server.Version}}'], 30 * 1000);
  if (out.exitCode !== 0) {
    throw new Error(`agent.sandbox is set, but Docker is not reachable. Start Docker, or remove "sandbox" from .factoryrc.json to run gates on the host.\n${tail(out.output, 5)}`);
  }
}

/**
 * Runs setup and gates in Docker on a clean copy of the working folder.
 *
 * The copy holds only the files the commit would contain, so an ignored file
 * the agent left behind cannot make a gate pass. Setup runs first with network
 * and a package cache; each gate then runs in its own container with no
 * network, no capabilities, the host user's ids, and no host environment
 * beyond `sandbox.env`. Gates share the copy, so a build gate's output is
 * there for the test gate.
 */
export function createDockerGateRunner(opts: DockerGateRunnerOptions): GateRunner {
  const docker = opts.docker ?? dockerCli;
  const { sandbox } = opts;
  const user = opts.user ?? defaultUser();
  const passEnv = sandbox.env.flatMap((name) => (opts.env[name] !== undefined ? ['--env', `${name}=${opts.env[name]}`] : []));

  const run = (command: string, network: boolean, timeoutMs: number, extra: string[] = []): CommandOutcome => {
    const name = `agentic-loop-${randomBytes(6).toString('hex')}`;
    const args = [
      'run', '--rm', '--init', '--name', name,
      '--network', network ? 'bridge' : 'none',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--pids-limit', '4096',
      ...(sandbox.memory ? ['--memory', sandbox.memory] : []),
      ...(sandbox.cpus ? ['--cpus', String(sandbox.cpus)] : []),
      ...(user ? ['--user', user] : []),
      '--volume', `${path.resolve(opts.stagingDir)}:/work`,
      '--workdir', '/work',
      '--env', 'HOME=/tmp',
      '--env', 'CI=true',
      ...passEnv,
      ...extra,
      sandbox.image,
      'bash', '-c', `exec 2>&1; ${command}`,
    ];
    const out = docker(args, timeoutMs);
    // A timeout kills the docker client, not the container.
    if (out.timedOut) docker(['rm', '--force', name], KILL_TIMEOUT_MS);
    return out;
  };

  return (gates, cwd) => {
    stageFiles(cwd, opts.stagingDir, opts.listFiles(cwd));
    const results: GateResult[] = [];
    if (opts.setup) {
      fs.mkdirSync(opts.cacheDir, { recursive: true });
      opts.log?.(`[sandbox] setup in ${sandbox.image}: ${opts.setup}`);
      const out = run(opts.setup, true, SETUP_TIMEOUT_MS, [
        '--volume', `${path.resolve(opts.cacheDir)}:/cache`,
        '--env', 'npm_config_store_dir=/cache/pnpm-store',
        '--env', 'npm_config_cache=/cache/npm',
        '--env', 'XDG_CACHE_HOME=/cache/xdg',
      ]);
      if (out.exitCode !== 0 || out.timedOut) {
        results.push({ name: SANDBOX_SETUP, command: opts.setup, status: 'fail', exitCode: out.exitCode, durationMs: out.durationMs, outputTail: tail(out.output) });
        for (const g of gates) results.push({ name: g.name, command: g.run, status: 'skipped', exitCode: null, durationMs: 0, outputTail: '' });
        return results;
      }
    }
    return [...results, ...runGates(gates, opts.stagingDir, (command, _cwd, timeoutMs) => run(command, sandbox.gateNetwork, timeoutMs))];
  };
}

function defaultUser(): string | undefined {
  return typeof process.getuid === 'function' && typeof process.getgid === 'function' ? `${process.getuid()}:${process.getgid()}` : undefined;
}
