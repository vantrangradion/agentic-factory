#!/usr/bin/env node
import { loadFactoryConfig } from './config.js';
import { checkNoCycles } from './no-cycles.js';
import { checkBoundaries } from './boundary-guard.js';
import { checkPlainLanguage } from './plain-language.js';
import { checkSecrets } from './secret-scan.js';

const command = process.argv[2] || 'run';
const projectRoot = process.cwd();

console.log(`\n🛡️  [Agentic Factory Guardrail Engine]`);
console.log(`Directory: ${projectRoot}`);
console.log(`Command:   ${command}\n`);

let hasAnyFailure = false;
const config = loadFactoryConfig(projectRoot);

if (command === '--help' || command === '-h') {
  console.log(`Usage: agentic-guards <command>\n`);
  console.log(`Commands:`);
  console.log(`  run         Execute all enabled guards (cycles, boundaries, jargon, secrets)`);
  console.log(`  cycles      Verify zero circular dependencies in code`);
  console.log(`  boundaries  Enforce cross-package or architectural boundary rules`);
  console.log(`  jargon      Scan user-facing strings for prohibited internal jargon`);
  console.log(`  secrets     Scan for leaked API keys, tokens, or customer PII\n`);
  process.exit(0);
}

if (command === 'run' || command === 'cycles') {
  const result = checkNoCycles(projectRoot, config.guards?.noCycles);
  if (result.hasCycles) {
    hasAnyFailure = true;
    console.error(`❌ ${result.summary}`);
    result.cycles.forEach((c, idx) => {
      console.error(`   Cycle ${idx + 1}: ${c.join(' -> ')}`);
    });
  } else {
    console.log(`✅ ${result.summary}`);
  }
}

if (command === 'run' || command === 'boundaries') {
  const result = checkBoundaries(projectRoot, config.guards?.boundaries);
  if (result.hasViolations) {
    hasAnyFailure = true;
    console.error(`❌ ${result.summary}`);
    result.violations.forEach((v) => {
      console.error(`   ${v.file}:${v.line} forbidden import '${v.imported}' (rule: ${v.sourcePackage} cannot import ${v.forbiddenTarget})`);
    });
  } else {
    console.log(`✅ ${result.summary}`);
  }
}

if (command === 'run' || command === 'jargon') {
  const result = checkPlainLanguage(projectRoot, config.guards?.plainLanguage);
  if (result.hasViolations) {
    hasAnyFailure = true;
    console.error(`❌ ${result.summary}`);
    result.violations.forEach((v) => {
      console.error(`   ${v.file}:${v.line} prohibited term '${v.term}' in "${v.snippet}"`);
    });
  } else {
    console.log(`✅ ${result.summary}`);
  }
}

if (command === 'run' || command === 'secrets') {
  const result = checkSecrets(projectRoot, config.guards?.secrets);
  if (result.hasViolations) {
    hasAnyFailure = true;
    console.error(`❌ ${result.summary}`);
    result.violations.forEach((v) => {
      console.error(`   ${v.file}:${v.line} potential secret match (${v.pattern})`);
    });
  } else {
    console.log(`✅ ${result.summary}`);
  }
}

console.log('');
if (hasAnyFailure) {
  console.error(`🚫 Factory Quality Gates FAILED. Review violations above.\n`);
  process.exit(1);
} else {
  console.log(`🎉 All Factory Quality Gates PASSED with 0 violations.\n`);
  process.exit(0);
}
