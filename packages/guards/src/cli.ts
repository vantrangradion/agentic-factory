#!/usr/bin/env node
import { loadFactoryConfig } from './config.js';
import { checkNoCycles } from './no-cycles.js';
import { checkBoundaries } from './boundary-guard.js';
import { checkPlainLanguage } from './plain-language.js';
import { checkSecrets } from './secret-scan.js';
import { checkTodoIssueLinks } from './todo-issue-links.js';
import { checkCommentedCode } from './commented-code.js';
import { checkDeadExports } from './dead-exports.js';
import { formatGitHubAnnotation } from './github-annotations.js';
import { initFactoryConfig } from './init.js';

const args = process.argv.slice(2);
const isHelp = args.includes('--help') || args.includes('-h');
const isGitHubActions = process.env.GITHUB_ACTIONS === 'true' || args.includes('--github');
const positionalArgs = args.filter((a) => !a.startsWith('-'));
const command = positionalArgs[0] || 'run';
const projectRoot = process.cwd();

if (isHelp) {
  console.log(`\nUsage: agentic-guards <command> [options]\n`);
  console.log(`Commands:`);
  console.log(`  run             Execute all enabled guards`);
  console.log(`  init            Auto-detect workspace structure and generate .factoryrc.json`);
  console.log(`  cycles          Verify zero circular dependencies in code`);
  console.log(`  boundaries      Enforce cross-package or architectural boundary rules`);
  console.log(`  jargon          Scan user-facing strings for prohibited internal jargon`);
  console.log(`  secrets         Scan for leaked API keys, tokens, or customer PII`);
  console.log(`  todos           Enforce issue tracker links on all TODO/FIXME comments`);
  console.log(`  commented-code  Detect and reject commented-out code blocks`);
  console.log(`  dead-exports    Scan and report unused/dead exports\n`);
  console.log(`Options:`);
  console.log(`  --github        Emit GitHub Actions ::error:: annotations`);
  console.log(`  --force         Overwrite existing files when running init\n`);
  process.exit(0);
}

const VALID_COMMANDS = new Set([
  'run',
  'init',
  'cycles',
  'boundaries',
  'jargon',
  'secrets',
  'todos',
  'commented-code',
  'dead-exports',
]);

if (!VALID_COMMANDS.has(command)) {
  console.error(`\nFAILED: Unknown command '${command}'. Run 'agentic-guards --help' for available commands.\n`);
  process.exit(1);
}

if (command === 'init') {
  const force = args.includes('--force');
  const result = initFactoryConfig(projectRoot, { force });
  if (result.created) {
    console.log(`\nPASS: ${result.message}\n`);
    process.exit(0);
  } else {
    console.error(`\nWARN: ${result.message}\n`);
    process.exit(1);
  }
}

console.log(`\n[Agentic Factory Guardrail Engine]`);
console.log(`Directory: ${projectRoot}`);
console.log(`Command:   ${command}\n`);

let hasAnyFailure = false;
const config = loadFactoryConfig(projectRoot);

function reportError(file: string, line: number, col: number, message: string) {
  if (isGitHubActions) {
    console.error(formatGitHubAnnotation('error', { file, line, col, message }));
  }
}

if (command === 'run' || command === 'cycles') {
  const result = checkNoCycles(projectRoot, config.guards?.noCycles);
  if (result.hasCycles) {
    hasAnyFailure = true;
    console.error(result.summary);
    result.cycles.forEach((c, idx) => {
      console.error(`   Cycle ${idx + 1}: ${c.join(' -> ')}`);
      if (isGitHubActions && c[0]) {
        reportError(c[0], 1, 1, `Circular dependency: ${c.join(' -> ')}`);
      }
    });
  } else {
    console.log(result.summary);
  }
}

if (command === 'run' || command === 'boundaries') {
  const result = checkBoundaries(projectRoot, config.guards?.boundaries);
  if (result.hasViolations) {
    hasAnyFailure = true;
    console.error(result.summary);
    result.violations.forEach((v) => {
      const msg = `forbidden import '${v.imported}' (rule: ${v.sourcePackage} cannot import ${v.forbiddenTarget})`;
      console.error(`   ${v.file}:${v.line} ${msg}`);
      reportError(v.file, v.line, 1, msg);
    });
  } else {
    console.log(result.summary);
  }
}

if (command === 'run' || command === 'jargon') {
  const result = checkPlainLanguage(projectRoot, config.guards?.plainLanguage);
  if (result.hasViolations) {
    hasAnyFailure = true;
    console.error(result.summary);
    result.violations.forEach((v) => {
      const msg = `prohibited term '${v.term}' in "${v.snippet}"`;
      console.error(`   ${v.file}:${v.line} ${msg}`);
      reportError(v.file, v.line, 1, msg);
    });
  } else {
    console.log(result.summary);
  }
}

if (command === 'run' || command === 'secrets') {
  const result = checkSecrets(projectRoot, config.guards?.secrets);
  if (result.hasViolations) {
    hasAnyFailure = true;
    console.error(result.summary);
    result.violations.forEach((v) => {
      const msg = `potential secret match (${v.pattern})`;
      console.error(`   ${v.file}:${v.line} ${msg}`);
      reportError(v.file, v.line, 1, msg);
    });
  } else {
    console.log(result.summary);
  }
}

if (command === 'run' || command === 'todos') {
  const result = checkTodoIssueLinks(projectRoot, config.guards?.todoIssueLinks);
  if (result.hasViolations) {
    hasAnyFailure = true;
    console.error(result.summary);
    result.violations.forEach((v) => {
      const msg = `TODO/FIXME missing issue tracker link: "${v.text}"`;
      console.error(`   ${v.file}:${v.line}:${v.col} ${msg}`);
      reportError(v.file, v.line, v.col, msg);
    });
  } else {
    console.log(result.summary);
  }
}

if (command === 'run' || command === 'commented-code') {
  const result = checkCommentedCode(projectRoot, config.guards?.commentedCode);
  if (result.hasViolations) {
    hasAnyFailure = true;
    console.error(result.summary);
    result.violations.forEach((v) => {
      const msg = `Commented-out code detected: "${v.snippet}"`;
      console.error(`   ${v.file}:${v.line}:${v.col} ${msg}`);
      reportError(v.file, v.line, v.col, msg);
    });
  } else {
    console.log(result.summary);
  }
}

if (command === 'run' || command === 'dead-exports') {
  const result = checkDeadExports(projectRoot, config.guards?.deadExports);
  if (result.hasViolations) {
    hasAnyFailure = true;
    console.error(result.summary);
    result.violations.forEach((v) => {
      const msg = `Unused/dead export '${v.symbol}'`;
      console.error(`   ${v.file}:${v.line}:${v.col} ${msg}`);
      reportError(v.file, v.line, v.col, msg);
    });
  } else {
    console.log(result.summary);
  }
}

console.log('');
if (hasAnyFailure) {
  console.error(`FAILED: Quality gates failed. Review violations above.\n`);
  process.exit(1);
} else {
  console.log(`SUCCESS: All quality gates passed with 0 violations.\n`);
  process.exit(0);
}
