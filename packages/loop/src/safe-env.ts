import * as fs from 'node:fs';
import * as path from 'node:path';

/** Variables that carry credentials the agent and its gates never need. */
const CREDENTIAL_VARS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'AGENTIC_LOOP_WORKSPACE_TOKEN',
  'SSH_AUTH_SOCK',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  // GitHub Actions: files later steps read (an agent could inject env, PATH or outputs) and the OIDC and runtime tokens.
  'GITHUB_ENV',
  'GITHUB_PATH',
  'GITHUB_OUTPUT',
  'GITHUB_STATE',
  'GITHUB_STEP_SUMMARY',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_RUNTIME_TOKEN',
  'ACTIONS_RUNTIME_URL',
  'ACTIONS_RESULTS_URL',
  'ACTIONS_CACHE_URL',
];

/**
 * The environment for agent sessions and gates on a developer machine.
 *
 * The agent runs as the user, so this cannot stop a determined agent. It
 * removes the easy paths to the user's GitHub access so a confused agent
 * cannot push, merge or comment: `gh` sees an empty config, git ignores the
 * user's and system credential helpers, SSH agent forwarding is gone, and
 * git never prompts. The loop itself pushes later, with the normal environment.
 */
export function agentEnv(base: NodeJS.ProcessEnv, scratchDir: string): NodeJS.ProcessEnv {
  fs.mkdirSync(path.join(scratchDir, 'gh'), { recursive: true });
  const gitconfig = path.join(scratchDir, 'gitconfig');
  fs.writeFileSync(gitconfig, '[user]\n\tname = agentic-loop\n\temail = agentic-loop@users.noreply.github.com\n');

  const env: NodeJS.ProcessEnv = { ...base };
  for (const v of CREDENTIAL_VARS) delete env[v];
  return {
    ...env,
    GH_CONFIG_DIR: path.join(scratchDir, 'gh'),
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityFile=/dev/null',
    GCM_INTERACTIVE: 'never',
  };
}
