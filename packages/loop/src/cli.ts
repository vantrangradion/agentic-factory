#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadFactoryConfig } from '@agentic-factory/guards';
import { decideBudget } from './budget.js';
import { modelFor, resolveAgentConfig, type ResolvedAgentConfig } from './config.js';
import { makeShellExecutor } from './gates.js';
import { restoreGitDir, snapshotGitDir } from './git-safety.js';
import { agentEnv } from './safe-env.js';
import { createGitOps } from './git.js';
import { parseIssue } from './issue.js';
import { readRecords, writeRecord } from './ledger.js';
import { runLoop } from './loop.js';
import { renderBudgetReport, renderFailureComment, renderPrBody } from './render.js';
import { createRunner } from './runner.js';
import { createLocalDeps, watch } from './local.js';
import { runIssue } from './run-issue.js';
import { printTrace } from './trace.js';
import { wasInterrupted } from './interrupt.js';

const HELP = `
Usage: agentic-loop <command> [options]

Commands:
  check-config                 Validate the "agent" section of .factoryrc.json
  budget --ledger <dir> [--labels a,b]
                               Decide whether an issue may run under the weekly budget
  run --issue-file <file> [--out-dir <dir>]
                               Run the red and green phases for one issue
  report --ledger <dir> [--out <file>]
                               Render the budget and metrics page from the ledger

Local mode (uses your own gh login and agent login on this machine).
--base clones that branch and targets PRs at it instead of the default branch:
  run-issue <number> [--base <branch>] [--repo owner/name] [--work-dir <dir>]
                               Claim one issue, run it in a fresh clean clone, push, open the PR
  watch [--interval 60] [--take-unassigned] [--once] [--base <branch>] [--repo owner/name] [--work-dir <dir>]
                               Poll for ready issues assigned to you and run each one

  trace <file> [--follow]      Show an agent session trace as readable lines; --follow while it runs

Outputs go to stdout, and to $GITHUB_OUTPUT when it is set.
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

function setOutput(values: Record<string, string>): void {
  const file = process.env['GITHUB_OUTPUT'];
  if (!file) return;
  for (const [k, v] of Object.entries(values)) {
    if (v.includes('\n')) {
      const delim = `EOF_${Math.random().toString(36).slice(2)}`;
      fs.appendFileSync(file, `${k}<<${delim}\n${v}\n${delim}\n`);
    } else {
      fs.appendFileSync(file, `${k}=${v}\n`);
    }
  }
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
    setOutput({ 'ready-label': config.labels.ready, 'working-label': config.labels.working, 'pr-open-label': config.labels.prOpen, 'needs-human-label': config.labels.needsHuman });
    break;
  }

  case 'budget': {
    const config = loadConfig(cwd);
    const { records, skipped } = readRecords(requireFlag('--ledger'));
    if (skipped.length > 0) console.warn(`WARN: skipped unreadable ledger files: ${skipped.join(', ')}`);
    const labels = (flag('--labels') ?? '').split(',').map((l) => l.trim()).filter(Boolean);
    const decision = decideBudget(records, config.budget, labels, new Date());
    console.log(`${decision.allowed ? 'PASS' : 'STOP'}: ${decision.reason}`);
    setOutput({ allowed: String(decision.allowed), mode: decision.mode, reason: decision.reason, 'spent-usd': String(decision.spentUsd) });
    break;
  }

  case 'run': {
    const config = loadConfig(cwd);
    const issue = parseIssue(JSON.parse(fs.readFileSync(requireFlag('--issue-file'), 'utf-8')));
    const outDir = path.resolve(flag('--out-dir') ?? '.agentic-loop');
    fs.mkdirSync(outDir, { recursive: true });

    const contextFiles = config.context.filter((f) => {
      const ok = fs.existsSync(path.join(cwd, f));
      if (!ok) console.warn(`WARN: context file not found, skipping: ${f}`);
      return ok;
    });

    if (config.plan.approval === 'required') {
      fail('plan.approval is "required", which the GitHub Actions workflow does not support yet. Use local mode (run-issue or watch), or set plan.approval to "none" for CI.');
    }
    const model = modelFor(issue.labels, config);
    console.log(`Runner: ${config.runner}. Model: ${model}${model === config.model ? ' (default)' : ' (routed by label)'}`);

    // CI: the agent and its gates must not see the runner's file commands or tokens; git must not run anything from .git.
    const env = agentEnv(process.env, path.join(outDir, 'agent-env'));
    const snapshot = snapshotGitDir(cwd);
    const result = runLoop(issue, config, contextFiles, {
      runner: createRunner(config.runner, { model, timeoutMs: config.sessionTimeoutMs, env, logDir: path.join(outDir, 'sessions'), ...(process.env['AGENTIC_LOOP_AGENT_BIN'] ? { binary: process.env['AGENTIC_LOOP_AGENT_BIN'] } : {}) }),
      git: createGitOps(cwd, { beforeCommand: () => restoreGitDir(snapshot) }),
      exec: makeShellExecutor(env),
      cwd,
      now: () => new Date(),
      log: (m) => console.log(m),
    }, { stage: 'full' });

    const recordFile = writeRecord(path.join(outDir, 'records'), result.record);
    const bodyFile = path.join(outDir, result.passed ? 'pr-body.md' : 'failure.md');
    fs.writeFileSync(bodyFile, result.passed ? renderPrBody(issue, result) : renderFailureComment(issue, result, config));

    console.log(`\n${result.passed ? 'PASS' : 'NEEDS HUMAN'}: ${result.passed ? `branch ${result.branch} is ready for a pull request` : result.stopReason}`);
    setOutput({
      passed: String(result.passed),
      branch: result.branch,
      'has-commits': String(result.commits.length > 0),
      'pr-title': result.prTitle,
      'body-file': bodyFile,
      'record-file': recordFile,
    });
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
