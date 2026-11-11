import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadFactoryConfig } from '@agentic-factory/guards';
import { modelFor, resolveAgentConfig, type ResolvedAgentConfig } from './config.js';
import { makeShellExecutor } from './gates.js';
import { createGitOps } from './git.js';
import { createWorkspaceNotifier, WORKSPACE_TOKEN_VAR } from './chat-notify.js';
import { createGhOps, repoInfo } from './github.js';
import { createGitLedgerStore } from './ledger-store.js';
import { runLoop } from './loop.js';
import { watchOnce, type RunIssueDeps } from './run-issue.js';
import { checkAgentSandbox, DockerAgentRunner } from './agent-sandbox.js';
import { createRunner, type AgentCliOptions, type AgentRunner } from './runner.js';
import { vendorFor } from './vendors/index.js';
import { agentEnv } from './safe-env.js';
import { assertDockerAvailable, createDockerGateRunner, type GateRunner } from './sandbox.js';
import { restoreGitDir, type GitDirSnapshot } from './git-safety.js';
import { prepareWorkspace, pushBranch } from './workspace.js';

export interface LocalOptions {
  /** "owner/name"; defaults to the repository of the current directory. */
  repo?: string;
  /** Root for clones, outputs and the ledger cache. Default ~/.agentic-loop/<owner>__<name>. */
  workDir?: string;
  /**
   * Branch to clone and target pull requests at, instead of the default
   * branch. Lets a harness change be tried before it is merged.
   */
  baseBranch?: string;
  cwd: string;
  log: (m: string) => void;
  shouldStop: () => boolean;
}

/**
 * The user's GitHub token from their own `gh` login, read only when the loop
 * itself clones or pushes. It is sent as a request header and never stored,
 * so no git credential helper or SSH key is involved.
 */
function ghToken(): string | undefined {
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function loadAgentConfig(dir: string): ResolvedAgentConfig {
  return resolveAgentConfig(loadFactoryConfig(dir).agent);
}

/** Wires runIssue to the real gh, git and agent CLIs on this machine. */
export function createLocalDeps(opts: LocalOptions): RunIssueDeps {
  const detected = repoInfo(opts.repo, opts.cwd);
  const repo = opts.baseBranch ? { ...detected, defaultBranch: opts.baseBranch } : detected;
  const gh = createGhOps(repo.nameWithOwner);
  const remoteUrl = `https://github.com/${repo.nameWithOwner}.git`;
  const snapshots = new Map<string, GitDirSnapshot>();
  const trusted = (dir: string): GitDirSnapshot => {
    const snap = snapshots.get(dir);
    if (!snap) throw new Error(`No trusted .git snapshot for ${dir}`);
    return snap;
  };
  const workRoot = path.resolve(opts.workDir ?? path.join(os.homedir(), '.agentic-loop', repo.nameWithOwner.replace('/', '__')));
  const env = agentEnv(process.env, path.join(workRoot, 'agent-env'));
  const exec = makeShellExecutor(env);
  const labelConfig = loadAgentConfig(opts.cwd);
  const workspaceToken = process.env[WORKSPACE_TOKEN_VAR];
  if (labelConfig.notify.workspace && !workspaceToken) {
    opts.log(`WARN: notify.workspace is set but ${WORKSPACE_TOKEN_VAR} is not, so nothing is posted to Workspace`);
  }

  return {
    gh,
    repo,
    me: gh.me(),
    ledger: createGitLedgerStore({ remoteUrl, branch: labelConfig.ledgerBranch, dir: path.join(workRoot, 'ledger'), token: ghToken }),
    workRoot,
    prepare: (dir, setup, checkout) => {
      const token = ghToken();
      const ws = prepareWorkspace({ remoteUrl, branch: repo.defaultBranch, dir, setup, exec, log: opts.log, checkout, ...(token ? { token } : {}) });
      snapshots.set(dir, ws.snapshot);
      return { diffBase: ws.diffBase, changedFiles: ws.changedFiles };
    },
    loadConfig: loadAgentConfig,
    loop: (issue, config, dir, loopOpts, onUsage) => {
      const contextFiles = config.context.filter((f) => {
        const ok = fs.existsSync(path.join(dir, f));
        if (!ok) opts.log(`WARN: context file not found, skipping: ${f}`);
        return ok;
      });
      const model = modelFor(issue.labels, config);
      opts.log(`#${issue.number}: ${loopOpts.stage} stage, runner ${config.runner}, model ${model}${model === config.model ? '' : ' (routed by label)'}`);
      const bin = process.env['AGENTIC_LOOP_AGENT_BIN'];
      const runnerOpts = {
        timeoutMs: config.sessionTimeoutMs,
        env,
        logDir: path.join(workRoot, 'out', `issue-${issue.number}`, 'sessions'),
        onSessionStart: (f: string) => opts.log(`#${issue.number}: follow the agent live with: agentic-loop trace "${f}" --follow`),
        ...(bin ? { binary: bin } : {}),
      };
      const gitOps = createGitOps(dir, { beforeCommand: () => restoreGitDir(trusted(dir)) });
      const makeRunner = agentRunnerFactory(config, runnerOpts, opts.log);
      return runLoop(issue, config, contextFiles, {
        runner: makeRunner(model),
        reviewRunner: makeRunner(config.review.model ?? model),
        git: gitOps,
        exec,
        ...sandboxDeps(config, { listFiles: () => gitOps.filesToCommit(), workRoot, env, log: opts.log }),
        cwd: dir,
        now: () => new Date(),
        log: opts.log,
        shouldStop: opts.shouldStop,
        ...(onUsage ? { onUsage } : {}),
      }, loopOpts);
    },
    push: (dir, branch) => {
      const token = ghToken();
      pushBranch(dir, remoteUrl, branch, trusted(dir), token);
    },
    now: () => new Date(),
    log: opts.log,
    ...(workspaceToken ? { notify: createWorkspaceNotifier(workspaceToken) } : {}),
  };
}

/**
 * Makes agent runners for one run, for the vendor in `runner`: in Docker when
 * `sandbox.agent` is on, after checking that the image has the agent CLI and
 * the login volume holds a login; on the host otherwise.
 */
export function agentRunnerFactory(config: ResolvedAgentConfig, base: Omit<AgentCliOptions, 'model'>, log: (m: string) => void): (model: string) => AgentRunner {
  const sb = config.sandbox;
  if (!sb?.agent) return (model) => createRunner(config.runner, { ...base, model });
  const vendor = vendorFor(config.runner);
  assertDockerAvailable();
  const agentVersion = checkAgentSandbox(sb, undefined, undefined, vendor);
  log(`Agent sessions run in Docker (${sb.image}, ${vendor.binary} ${agentVersion}) with network, signed in from volume ${sb.authVolume}`);
  return (model) =>
    new DockerAgentRunner({
      vendor,
      model,
      timeoutMs: base.timeoutMs,
      sandbox: sb,
      agentVersion,
      ...(base.logDir ? { logDir: base.logDir } : {}),
      ...(base.onSessionStart ? { onSessionStart: base.onSessionStart } : {}),
    });
}

/** The Docker gate runner when `agent.sandbox` is set; nothing otherwise. Fails fast if Docker is not running. */
export function sandboxDeps(
  config: ResolvedAgentConfig,
  opts: { listFiles: () => string[]; workRoot: string; env: NodeJS.ProcessEnv; log: (m: string) => void },
): { runGates?: GateRunner } {
  if (!config.sandbox) return {};
  assertDockerAvailable();
  opts.log(`Gates run in Docker (${config.sandbox.image}), ${config.sandbox.gateNetwork ? 'with' : 'without'} network`);
  return {
    runGates: createDockerGateRunner({
      sandbox: config.sandbox,
      setup: config.setup,
      listFiles: opts.listFiles,
      stagingDir: path.join(opts.workRoot, 'gates'),
      cacheDir: path.join(opts.workRoot, 'sandbox-cache'),
      env: opts.env,
      log: opts.log,
    }),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls for ready issues until `shouldStop` returns true, or once with `once`. */
export async function watch(deps: RunIssueDeps, labelConfig: ResolvedAgentConfig, opts: { intervalSec: number; takeUnassigned: boolean; once: boolean; shouldStop: () => boolean }): Promise<void> {
  deps.log(
    `Watching ${deps.repo.nameWithOwner} as ${deps.me} for "${labelConfig.labels.ready}" issues ${opts.takeUnassigned ? 'assigned to you or unassigned' : 'assigned to you'}, every ${opts.intervalSec} s. Work folder: ${deps.workRoot}`,
  );
  let lastIdle = '';
  while (!opts.shouldStop()) {
    try {
      const tick = watchOnce(labelConfig, deps, { takeUnassigned: opts.takeUnassigned, shouldStop: opts.shouldStop });
      for (const p of tick.processed) {
        if (p.result.outcome === 'skipped') deps.log(`#${p.issue}: skipped, ${p.result.reason}`);
      }
      if (tick.idleReason && tick.idleReason !== lastIdle) deps.log(`Idle: ${tick.idleReason}`);
      lastIdle = tick.idleReason ?? '';
    } catch (err) {
      deps.log(`WARN poll failed: ${(err as Error).message}`);
    }
    if (opts.once) return;
    for (let waited = 0; waited < opts.intervalSec && !opts.shouldStop(); waited++) await sleep(1000);
  }
}
