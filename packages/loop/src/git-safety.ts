import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The agent can write anything in its clone, including `.git/`. Git commands
 * the loop runs afterwards must therefore never execute code from there:
 * hooks (post-commit runs even with --no-verify), core.fsmonitor, filter and
 * textconv drivers, include.path, credential helpers or core.sshCommand.
 *
 * Two layers stop that: an environment that ignores system and global config
 * and overrides the dangerous keys at command-line priority, and a reset of
 * `.git/config`, `hooks/` and `info/` to a snapshot taken before the agent ran.
 */

/** Builds an environment for the loop's own git commands. `extra` adds config at command-line priority. */
export function hardenedGitEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const entries: [string, string][] = [
    ['core.hooksPath', os.devNull],
    ['core.fsmonitor', 'false'],
    ['credential.helper', ''],
    ['core.sshCommand', 'ssh -o BatchMode=yes'],
    ['protocol.ext.allow', 'never'],
    ...Object.entries(extra),
  ];
  const env: NodeJS.ProcessEnv = { ...base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: '0' };
  for (const k of Object.keys(env)) if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) delete env[k];
  env['GIT_CONFIG_COUNT'] = String(entries.length);
  entries.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
}

/** Config that authenticates HTTPS requests to github.com with a token, without storing it anywhere. */
export function githubAuthConfig(token: string | undefined): Record<string, string> {
  if (!token) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return { 'http.https://github.com/.extraheader': `AUTHORIZATION: basic ${basic}` };
}

export interface GitDirSnapshot {
  dir: string;
  config: string;
  infoExclude: string | null;
}

/** Records the parts of `.git/` the loop must trust, right after cloning and before any agent session. */
export function snapshotGitDir(repoDir: string): GitDirSnapshot {
  const gitDir = path.join(repoDir, '.git');
  const exclude = path.join(gitDir, 'info', 'exclude');
  return {
    dir: gitDir,
    config: fs.readFileSync(path.join(gitDir, 'config'), 'utf-8'),
    infoExclude: fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf-8') : null,
  };
}

/** Puts `.git/config`, `hooks/` and `info/` back to the snapshot. Cheap enough to run before every git command. */
export function restoreGitDir(snap: GitDirSnapshot): void {
  fs.writeFileSync(path.join(snap.dir, 'config'), snap.config);
  fs.rmSync(path.join(snap.dir, 'hooks'), { recursive: true, force: true });
  fs.mkdirSync(path.join(snap.dir, 'hooks'), { recursive: true });
  fs.rmSync(path.join(snap.dir, 'info'), { recursive: true, force: true });
  fs.mkdirSync(path.join(snap.dir, 'info'), { recursive: true });
  if (snap.infoExclude !== null) fs.writeFileSync(path.join(snap.dir, 'info', 'exclude'), snap.infoExclude);
}
