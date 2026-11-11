import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CommandExecutor } from './gates.js';
import type { PreparedWorkspace } from './run-issue.js';
import { githubAuthConfig, hardenedGitEnv, restoreGitDir, snapshotGitDir, type GitDirSnapshot } from './git-safety.js';

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export const DISABLED_PUSH_URL = 'no-push-during-agent-session';

/**
 * Makes a fresh clone of `branch` in `dir`, deleting whatever was there, so
 * every run starts from a clean checkout. Commits are authored as
 * agentic-loop, and pushing from the clone is disabled; the loop pushes with
 * an explicit URL once the agent has finished.
 */
export function prepareWorkspace(opts: {
  remoteUrl: string;
  branch: string;
  dir: string;
  setup: string | null;
  exec: CommandExecutor;
  log: (m: string) => void;
  /** An existing remote branch to check out on top of the clone, e.g. an approved plan. */
  checkout?: string | null;
  /** GitHub token for private repositories; sent as a request header, never written to disk. */
  token?: string;
}): PreparedWorkspace & { snapshot: GitDirSnapshot } {
  const { remoteUrl, branch, dir, setup, exec, log } = opts;
  const env = hardenedGitEnv(process.env, githubAuthConfig(opts.token));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  log(`Cloning ${branch} into ${dir}`);
  git(path.dirname(dir), env, 'clone', '--quiet', '--branch', branch, '--single-branch', remoteUrl, dir);
  git(dir, env, 'config', 'user.name', 'agentic-loop');
  git(dir, env, 'config', 'user.email', 'agentic-loop@users.noreply.github.com');
  git(dir, env, 'config', 'commit.gpgsign', 'false');
  git(dir, env, 'remote', 'set-url', '--push', 'origin', DISABLED_PUSH_URL);
  const baseTip = git(dir, env, 'rev-parse', 'HEAD');
  let diffBase = baseTip;
  let changedFiles: string[] = [];
  let branchUpdatedAt: string | undefined;
  if (opts.checkout) {
    log(`Checking out ${opts.checkout}`);
    git(dir, env, 'fetch', '--quiet', remoteUrl, `refs/heads/${opts.checkout}`);
    git(dir, env, 'switch', '--quiet', '-C', opts.checkout, 'FETCH_HEAD');
    // Read before the rebase, which rewrites commit times.
    branchUpdatedAt = new Date(git(dir, env, 'log', '-1', '--format=%cI')).toISOString();
    // Build on the current default branch, so a plan approved before other work merged does not conflict later.
    if (git(dir, env, 'merge-base', baseTip, 'HEAD') !== baseTip) {
      log(`Rebasing ${opts.checkout} onto ${branch}`);
      try {
        git(dir, env, 'rebase', '--quiet', baseTip);
      } catch {
        const conflicts = git(dir, env, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
        git(dir, env, 'rebase', '--abort');
        return { diffBase: baseTip, changedFiles: [], branchUpdatedAt, rebaseConflicts: conflicts.length > 0 ? conflicts : ['(git did not name the files)'], snapshot: snapshotGitDir(dir) };
      }
    }
    diffBase = git(dir, env, 'merge-base', baseTip, 'HEAD');
    changedFiles = git(dir, env, 'diff', '--name-only', '--no-renames', diffBase, 'HEAD', '--').split('\n').filter(Boolean);
  }
  // Taken before setup and before any agent session: nothing untrusted has touched .git yet.
  const snapshot = snapshotGitDir(dir);
  if (setup) {
    log(`Setup: ${setup}`);
    const out = exec(setup, dir, 20 * 60 * 1000);
    if (out.exitCode !== 0) throw new Error(`Setup command failed (${setup}), exit ${out.exitCode}:\n${out.output.split('\n').slice(-30).join('\n')}`);
  }
  restoreGitDir(snapshot);
  return { diffBase, changedFiles, ...(branchUpdatedAt ? { branchUpdatedAt } : {}), snapshot };
}

/**
 * Pushes the agent's branch, replacing any earlier run of the same issue.
 * `.git/` is reset to its trusted snapshot first, and the push ignores every
 * hook and stored credential; the token travels only as a request header.
 */
export function pushBranch(dir: string, remoteUrl: string, branch: string, snapshot: GitDirSnapshot, token?: string): void {
  restoreGitDir(snapshot);
  git(dir, hardenedGitEnv(process.env, githubAuthConfig(token)), 'push', '--quiet', '--force', '--no-verify', remoteUrl, `HEAD:refs/heads/${branch}`);
}
