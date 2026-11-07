import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { githubAuthConfig, hardenedGitEnv } from './git-safety.js';

/** Where run records live. `sync` returns a local folder of records, refreshed from the remote. */
export interface LedgerStore {
  sync(): string;
  append(recordFile: string, message: string): void;
}

/**
 * A ledger kept on an orphan branch of the product repository. Every read and
 * write uses a fresh temporary clone with hardened git settings, so nothing an
 * agent may have planted in a long-lived folder (hooks, config) ever runs.
 * Each run adds one new file, so concurrent writers never conflict: a
 * rejected push is retried on a fresh clone.
 */
export function createGitLedgerStore(opts: { remoteUrl: string; branch: string; dir: string; retries?: number; token?: () => string | undefined }): LedgerStore {
  const { remoteUrl, branch } = opts;
  const cache = path.join(opts.dir, 'runs');

  const env = (): NodeJS.ProcessEnv => hardenedGitEnv(process.env, githubAuthConfig(opts.token?.()));
  const git = (cwd: string, e: NodeJS.ProcessEnv, ...args: string[]): string =>
    execFileSync('git', args, { cwd, env: e, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  /** A throwaway clone of the ledger branch, or a new orphan repository if the branch does not exist yet. */
  const freshClone = (e: NodeJS.ProcessEnv): string => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-ledger-'));
    const dir = path.join(tmp, 'ledger');
    try {
      git(tmp, e, 'clone', '--quiet', '--depth', '1', '--branch', branch, '--single-branch', remoteUrl, dir);
    } catch {
      fs.mkdirSync(dir, { recursive: true });
      git(dir, e, 'init', '--quiet', '-b', branch);
    }
    git(dir, e, 'config', 'user.name', 'agentic-loop');
    git(dir, e, 'config', 'user.email', 'agentic-loop@users.noreply.github.com');
    git(dir, e, 'config', 'commit.gpgsign', 'false');
    return dir;
  };
  const cleanup = (dir: string): void => fs.rmSync(path.dirname(dir), { recursive: true, force: true });

  return {
    sync: () => {
      const e = env();
      const dir = freshClone(e);
      try {
        fs.rmSync(cache, { recursive: true, force: true });
        fs.mkdirSync(cache, { recursive: true });
        const runs = path.join(dir, 'runs');
        if (fs.existsSync(runs)) for (const f of fs.readdirSync(runs)) fs.copyFileSync(path.join(runs, f), path.join(cache, f));
      } finally {
        cleanup(dir);
      }
      return cache;
    },
    append: (recordFile, message) => {
      const retries = opts.retries ?? 5;
      for (let i = 0; i < retries; i++) {
        const e = env();
        const dir = freshClone(e);
        try {
          fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
          fs.copyFileSync(recordFile, path.join(dir, 'runs', path.basename(recordFile)));
          git(dir, e, 'add', 'runs');
          git(dir, e, 'commit', '--quiet', '--no-verify', '-m', message);
          git(dir, e, 'push', '--quiet', '--no-verify', remoteUrl, `HEAD:refs/heads/${branch}`);
          return;
        } catch {
          // Someone else pushed first, or the network failed: start again from a fresh clone.
        } finally {
          cleanup(dir);
        }
      }
      throw new Error(`Could not push the run record to ${branch} after ${retries} attempts`);
    },
  };
}
