import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ResolvedSandbox } from './config.js';
import { tail } from './gates.js';
import { openTrace, promptArgument, sessionDeadlineMs, sessionResult, type AgentRunner, type AgentRunResult, type SessionExit } from './runner.js';
import { defaultUser, dockerCli, type DockerCli } from './sandbox.js';
import type { AgentVendor } from './vendor.js';
import { antigravity } from './vendors/antigravity.js';

/**
 * Runs agent sessions in Docker instead of on the host.
 *
 * The container sees the clone at /work (with `.git` read-only), a fresh
 * in-memory home folder, and one file from the login volume: the agent CLI's
 * login, made usable at start (copied into that home, or exported). It has no
 * Docker socket, no Linux capabilities, a read-only root file system, the host
 * user's ids and no host environment. It does have network, which the agent
 * needs to reach the model.
 */

const AUTH_MOUNT = '/auth';
const HOME = '/home/agent';
export const AGENT_WORK_DIR = '/work';
const KILL_TIMEOUT_MS = 30 * 1000;
const CHECK_TIMEOUT_MS = 2 * 60 * 1000;
/** Exit code of the startup check when the volume holds no login. */
const NO_LOGIN = 3;

const authPath = (vendor: AgentVendor): string => `${AUTH_MOUNT}/${vendor.sandbox.authFile}`;

/** Makes the login usable in the fresh home, then replaces itself with the command given as arguments. */
export function startScript(vendor: AgentVendor): string {
  return ['set -e', ...vendor.sandbox.useLogin(authPath(vendor)), 'exec "$@"'].join('\n');
}

/** Runs `docker` with stdout going to `stdoutFd`. Injected so tests never need Docker. */
export type DockerSpawn = (args: string[], opts: { stdoutFd: number; timeoutMs: number }) => SessionExit;

export const dockerSpawn: DockerSpawn = (args, { stdoutFd, timeoutMs }) => {
  const res = spawnSync('docker', args, { stdio: ['ignore', stdoutFd, 'pipe'], encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { status: res.status, signal: res.signal, stderr: res.stderr ?? '', ...(res.error ? { error: res.error } : {}) };
};

/** Options shared by every `docker run` this module starts. */
function baseRunArgs(name: string, sandbox: ResolvedSandbox, user: string | undefined, opts: { network: boolean; interactive?: boolean }): string[] {
  return [
    'run', '--rm', ...(opts.interactive ? ['-it'] : []), '--init', '--name', name,
    '--network', opts.network ? 'bridge' : 'none',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '4096',
    '--read-only',
    '--tmpfs', '/tmp:size=1g',
    '--tmpfs', `${HOME}:${user ? `uid=${user.split(':')[0]},gid=${user.split(':')[1]},` : ''}mode=0700,size=1g`,
    ...(sandbox.memory ? ['--memory', sandbox.memory] : []),
    ...(sandbox.cpus ? ['--cpus', String(sandbox.cpus)] : []),
    ...(user ? ['--user', user] : []),
    '--env', `HOME=${HOME}`,
  ];
}

export interface DockerAgentRunnerOptions {
  model: string;
  timeoutMs: number;
  sandbox: ResolvedSandbox;
  /** The agent CLI. Default: agy. */
  vendor?: AgentVendor;
  /** CLI version in the image, from `checkAgentSandbox`; shown in the run record. */
  agentVersion: string;
  /** Folder for per-session traces. Default: the OS temp folder. */
  logDir?: string;
  onSessionStart?: (traceFile: string) => void;
  /** Host user and group the container runs as. Default: the loop's own. */
  user?: string;
  spawn?: DockerSpawn;
  docker?: DockerCli;
}

export class DockerAgentRunner implements AgentRunner {
  readonly name: string;
  readonly model: string;
  readonly vendor: AgentVendor;

  constructor(private readonly opts: DockerAgentRunnerOptions) {
    this.model = opts.model;
    this.vendor = opts.vendor ?? antigravity;
    this.name = `${this.vendor.id} in docker (${this.vendor.binary} ${opts.agentVersion})`;
  }

  /** The full `docker run` arguments for one session. */
  dockerArgs(promptArg: string, cwd: string, containerName: string): string[] {
    const { sandbox } = this.opts;
    const seconds = Math.max(1, Math.round(this.opts.timeoutMs / 1000));
    const host = path.resolve(cwd);
    return [
      ...baseRunArgs(containerName, sandbox, this.opts.user ?? defaultUser(), { network: true }),
      '--volume', `${host}:${AGENT_WORK_DIR}`,
      '--volume', `${path.join(host, '.git')}:${AGENT_WORK_DIR}/.git:ro`,
      '--volume', `${sandbox.authVolume}:${AUTH_MOUNT}:ro`,
      '--workdir', AGENT_WORK_DIR,
      sandbox.image,
      'bash', '-c', startScript(this.vendor), 'agentic-loop-agent',
      this.vendor.binary, ...this.vendor.args(promptArg, this.opts.model, seconds),
    ];
  }

  run(prompt: string, cwd: string): AgentRunResult {
    const seconds = Math.max(1, Math.round(this.opts.timeoutMs / 1000));
    const spawn = this.opts.spawn ?? dockerSpawn;
    const docker = this.opts.docker ?? dockerCli;
    const name = `agentic-loop-agent-${randomBytes(6).toString('hex')}`;
    const args = this.dockerArgs(promptArgument(prompt, cwd, AGENT_WORK_DIR), cwd, name);
    const { traceFile, fd } = openTrace(this.opts.logDir, this.opts.onSessionStart);
    let exit: SessionExit;
    try {
      exit = spawn(args, { stdoutFd: fd, timeoutMs: sessionDeadlineMs(this.vendor, this.opts.timeoutMs) });
    } finally {
      fs.closeSync(fd);
      // A timeout or Ctrl+C can end the docker client before the container. The container dies with it, so no process the agent started keeps changing files.
      docker(['rm', '--force', name], KILL_TIMEOUT_MS);
    }
    return sessionResult(this.vendor, traceFile, exit, seconds);
  }
}

/**
 * Checks before a run that the image has the agent CLI and the login volume
 * holds a login, and returns the CLI version. Throws a message that says what to do.
 */
export function checkAgentSandbox(
  sandbox: ResolvedSandbox,
  docker: DockerCli = dockerCli,
  user: string | undefined = defaultUser(),
  vendor: AgentVendor = antigravity,
): string {
  const name = `agentic-loop-check-${randomBytes(6).toString('hex')}`;
  const args = [
    ...baseRunArgs(name, sandbox, user, { network: false }),
    '--volume', `${sandbox.authVolume}:${AUTH_MOUNT}:ro`,
    sandbox.image,
    'bash', '-c', `test -s ${authPath(vendor)} || exit ${NO_LOGIN}; exec ${vendor.binary} --version`,
  ];
  const out = docker(args, CHECK_TIMEOUT_MS);
  if (out.exitCode === NO_LOGIN) {
    throw new Error(`agent.sandbox.agent is on, but the Docker volume "${sandbox.authVolume}" holds no ${vendor.label} login. Run 'agentic-loop login' once on this machine.`);
  }
  if (out.exitCode === 127) {
    throw new Error(`agent.sandbox.agent is on, but the image ${sandbox.image} has no ${vendor.binary}. Add it to the image, e.g.:\n  ${vendor.sandbox.installHint}`);
  }
  if (out.exitCode !== 0) {
    throw new Error(`Could not check the agent sandbox in ${sandbox.image}:\n${tail(out.output, 10)}`);
  }
  // Only the version number: `claude --version` prints "2.1.3 (Claude Code)".
  const version = out.output.trim().split('\n').pop()?.trim().split(/\s+/)[0] ?? '';
  return version || 'unknown';
}

/** The two `docker run` commands `agentic-loop login` runs: give the volume to the user, then sign in interactively and save the token there. */
export function loginCommands(sandbox: ResolvedSandbox, user: string | undefined = defaultUser(), vendor: AgentVendor = antigravity): string[][] {
  const own = [
    'run', '--rm', '--network', 'none',
    '--volume', `${sandbox.authVolume}:${AUTH_MOUNT}`,
    sandbox.image,
    'bash', '-c', `chown ${user ?? '0:0'} ${AUTH_MOUNT} && chmod 700 ${AUTH_MOUNT}`,
  ];
  const script = ['set -e', ...vendor.sandbox.signIn(authPath(vendor)), `chmod 600 ${authPath(vendor)}`].join('\n');
  const signIn = [
    ...baseRunArgs(`agentic-loop-login-${randomBytes(6).toString('hex')}`, sandbox, user, { network: true, interactive: true }),
    '--volume', `${sandbox.authVolume}:${AUTH_MOUNT}`,
    sandbox.image,
    'bash', '-c', script,
  ];
  return [own, signIn];
}
