import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hardenedGitEnv } from './git-safety.js';

/** The git operations the loop needs. Injected so the loop can be tested without a repository. */
export interface GitOps {
  head(): string;
  createBranch(name: string): void;
  /** Files that differ from `base` in the working tree, including untracked files. */
  changedFiles(base: string): string[];
  /** Puts files back to their state at `ref`, deleting files that did not exist there. */
  restore(ref: string, files: readonly string[]): void;
  /** Stages everything and commits. Returns the new sha, or null if there was nothing to commit. */
  commitAll(message: string): string | null;
  /** Moves HEAD back to `ref` and keeps the working tree, undoing commits the agent made itself. */
  resetSoft(ref: string): void;
  /** Content hash of a file at `ref`, or null if absent. */
  blobAt(ref: string, file: string): string | null;
  /** Content hash of a file in the working tree, or null if absent. */
  blobInWorkingTree(file: string): string | null;
  /** Unified diff from `from` to HEAD. */
  diff(from: string): string;
  /** Files that differ between `from` and HEAD. */
  filesChangedSince(from: string): string[];
  /** A file's content at `ref`, or null if absent. */
  showFile(ref: string, file: string): string | null;
}

export interface GitOpsOptions {
  /** Environment for every git command. Default: a hardened copy of the process environment. */
  env?: NodeJS.ProcessEnv;
  /** Runs before every git command, e.g. resetting `.git/` to a trusted snapshot after the agent had access. */
  beforeCommand?: () => void;
}

function lines(out: string): string[] {
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

export function createGitOps(cwd: string, opts: GitOpsOptions = {}): GitOps {
  const env = opts.env ?? hardenedGitEnv(process.env);
  const git = (...args: string[]): string => {
    opts.beforeCommand?.();
    return execFileSync('git', args, { cwd, env, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  };

  return {
    head: () => git('rev-parse', 'HEAD'),
    createBranch: (name) => {
      git('switch', '-C', name);
    },
    changedFiles: (base) => {
      const tracked = lines(git('diff', '--name-only', '--no-renames', base, '--'));
      const untracked = lines(git('ls-files', '--others', '--exclude-standard'));
      return [...new Set([...tracked, ...untracked])].sort();
    },
    restore: (ref, files) => {
      for (const file of files) {
        let existed = true;
        try {
          git('cat-file', '-e', `${ref}:${file}`);
        } catch {
          existed = false;
        }
        if (existed) {
          git('checkout', ref, '--', file);
        } else {
          fs.rmSync(path.join(cwd, file), { force: true, recursive: true });
          try {
            git('rm', '--cached', '--quiet', '--ignore-unmatch', '--', file);
          } catch {
            // Not in the index: deleting it from disk was enough.
          }
        }
      }
    },
    commitAll: (message) => {
      git('add', '--all');
      const staged = lines(git('diff', '--cached', '--name-only'));
      if (staged.length === 0) return null;
      git('commit', '--quiet', '--no-verify', '-m', message);
      return git('rev-parse', 'HEAD');
    },
    resetSoft: (ref) => {
      git('reset', '--soft', ref);
    },
    blobAt: (ref, file) => {
      try {
        return git('rev-parse', `${ref}:${file}`);
      } catch {
        return null;
      }
    },
    blobInWorkingTree: (file) => {
      if (!fs.existsSync(path.join(cwd, file))) return null;
      return git('hash-object', '--', file);
    },
    diff: (from) => git('diff', '--no-color', from, 'HEAD', '--'),
    filesChangedSince: (from) => lines(git('diff', '--name-only', '--no-renames', from, 'HEAD', '--')),
    showFile: (ref, file) => {
      try {
        return git('show', `${ref}:${file}`);
      } catch {
        return null;
      }
    },
  };
}
