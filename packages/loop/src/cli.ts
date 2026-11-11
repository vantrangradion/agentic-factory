#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadFactoryConfig } from '@agentic-factory/guards';
import { resolveAgentConfig, type ResolvedAgentConfig } from './config.js';
import { readRecords } from './ledger.js';
import { renderBudgetReport } from './render.js';
import { loginCommands } from './agent-sandbox.js';
import { vendorFor } from './vendors/index.js';
import { spawnSync } from 'node:child_process';
import { createLocalDeps, watch } from './local.js';
import { runIssue } from './run-issue.js';
import { printTrace } from './trace.js';
import { wasInterrupted } from './interrupt.js';

const HELP = `
Usage: agentic-loop <command> [options]

Commands:
  check-config                 Validate the "agent" section of .factoryrc.json
  report --ledger <dir> [--out <file>]
                               Render the budget and metrics page from the ledger

The loop runs on your machine with your own gh login and agent login.
--base clones that branch and targets PRs at it instead of the default branch:
  run-issue <number> [--base <branch>] [--repo owner/name] [--work-dir <dir>]
                               Claim one issue, run it in a fresh clean clone, push, open the PR
  watch [--interval 60] [--take-unassigned] [--once] [--base <branch>] [--repo owner/name] [--work-dir <dir>]
                               Poll for ready issues assigned to you and run each one

  login                        Sign the agent in inside Docker, once per machine (needs sandbox.agent)

  trace <file> [--follow]      Show an agent session trace as readable lines; --follow while it runs
`;

const args = process.argv.slice(2);
const command = args[0];

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

function requireFlag(name: string): string {
  const v = flag(name);
  if (!v) fail(`Missing ${name}. Run 'agentic-loop --help'.`);
  return v;
}

function fail(message: string): never {
  console.error(`\nFAILED: ${message}\n`);
  process.exit(1);
}

function loadConfig(cwd: string): ResolvedAgentConfig {
  try {
    return resolveAgentConfig(loadFactoryConfig(cwd).agent);
  } catch (err) {
    fail((err as Error).message);
  }
}

const cwd = process.cwd();

if (!command || command === '--help' || command === '-h') {
  console.log(HELP);
  process.exit(0);
}

switch (command) {
  case 'check-config': {
    const config = loadConfig(cwd);
    console.log(JSON.stringify(config, null, 2));
    console.log('\nPASS: agent config is valid');
    break;
  }

  case 'report': {
    const config = loadConfig(cwd);
    const { records, skipped } = readRecords(requireFlag('--ledger'));
    if (skipped.length > 0) console.warn(`WARN: skipped unreadable ledger files: ${skipped.join(', ')}`);
    const md = renderBudgetReport(records, config, new Date());
    const out = flag('--out');
    if (out) {
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      fs.writeFileSync(out, md);
      console.log(`PASS: wrote ${out} from ${records.length} run(s)`);
    } else {
      process.stdout.write(md);
    }
    break;
  }

  case 'login': {
    const config = loadConfig(cwd);
    if (!config.sandbox?.agent) fail('login is only needed with "sandbox": { "image": "...", "agent": true } in the agent section of .factoryrc.json.');
    const vendor = vendorFor(config.runner);
    console.log(`Signing ${vendor.label} in inside ${config.sandbox.image}. The login is saved to the Docker volume "${config.sandbox.authVolume}"; your own ${vendor.label} login is not used or changed.`);
    console.log(`${vendor.sandbox.signInHint}\n`);
    for (const dockerArgs of loginCommands(config.sandbox, undefined, vendor)) {
      const res = spawnSync('docker', dockerArgs, { stdio: 'inherit' });
      if (res.status !== 0) fail(`docker exited with code ${res.status ?? res.signal}. Is Docker running, and does the image have ${vendor.binary}?`);
    }
    console.log(`\nPASS: agent login saved to volume ${config.sandbox.authVolume}`);
    break;
  }

  case 'trace': {
    const file = args[1];
    if (!file || file.startsWith('-')) fail('Usage: agentic-loop trace <session trace file> [--follow]');
    printTrace(file, args.includes('--follow'), (l) => console.log(l)).then(
      () => process.exit(0),
      (err: Error) => fail(err.message),
    );
    break;
  }

  case 'run-issue':
  case 'watch': {
    let stopping = false;
    // A child that died from Ctrl+C counts too: this handler cannot run while the loop waits on a child.
    const shouldStop = () => stopping || wasInterrupted();
    process.on('SIGINT', () => {
      if (stopping) process.exit(130);
      stopping = true;
      console.log('\nStopping after the current step. Press Ctrl+C again to quit now (labels may be left as working).');
    });
    const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
    const repo = flag('--repo');
    const workDir = flag('--work-dir');
    const baseBranch = flag('--base');
    let deps;
    try {
      deps = createLocalDeps({ cwd, log, shouldStop, ...(repo ? { repo } : {}), ...(workDir ? { workDir } : {}), ...(baseBranch ? { baseBranch } : {}) });
    } catch (err) {
      fail((err as Error).message);
    }
    const labelConfig = loadConfig(cwd);

    if (command === 'run-issue') {
      const n = Number(args[1]);
      if (!Number.isInteger(n) || n <= 0) fail('Usage: agentic-loop run-issue <issue number>');
      const res = runIssue(n, labelConfig, deps, { takeUnassigned: true, explicit: true });
      log(`#${n}: ${res.outcome.toUpperCase()}: ${res.reason}${res.prUrl ? ` ${res.prUrl}` : ''}`);
      process.exit(res.outcome === 'passed' || res.outcome === 'plan-ready' ? 0 : res.outcome === 'skipped' || res.outcome === 'over-budget' ? 3 : 2);
    }

    const interval = Number(flag('--interval') ?? '60');
    if (!(interval >= 10)) fail('--interval must be at least 10 seconds');
    watch(deps, labelConfig, { intervalSec: interval, takeUnassigned: args.includes('--take-unassigned'), once: args.includes('--once'), shouldStop }).then(
      () => process.exit(0),
      (err: Error) => fail(err.message),
    );
    break;
  }

  default:
    fail(`Unknown command '${command}'. Run 'agentic-loop --help'.`);
}
