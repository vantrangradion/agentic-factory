#!/usr/bin/env node
import * as path from 'node:path';
import { scaffoldProject, ScaffoldOptions } from './scaffolder.js';

const args = process.argv.slice(2);
const targetInput = args[0] || 'my-agentic-app';

if (args.includes('--help') || args.includes('-h')) {
  console.log(`\nUsage: npx create-agentic-factory <target-directory> [options]\n`);
  console.log(`Options:`);
  console.log(`  --arch <architecture>   Architecture pattern: 'modular-monorepo' (default), 'hexagonal', 'microservice'`);
  console.log(`  --jargon <terms>        Comma-separated list of prohibited UI/CLI jargon terms`);
  console.log(`  --help, -h              Show this help message\n`);
  process.exit(0);
}

const targetDir = path.resolve(process.cwd(), targetInput);
const projectName = path.basename(targetDir);

let architecture: ScaffoldOptions['architecture'] = 'modular-monorepo';
const archIndex = args.indexOf('--arch');
if (archIndex !== -1 && args[archIndex + 1]) {
  const chosen = args[archIndex + 1] as ScaffoldOptions['architecture'];
  if (['modular-monorepo', 'hexagonal', 'microservice'].includes(chosen)) {
    architecture = chosen;
  }
}

const forbiddenJargon: string[] = [];
const jargonIndex = args.indexOf('--jargon');
if (jargonIndex !== -1 && args[jargonIndex + 1]) {
  forbiddenJargon.push(...args[jargonIndex + 1]!.split(',').map((t) => t.trim()));
}

console.log(`\n🏭 Initializing Project-Agnostic Agentic Factory...`);
console.log(`Target:       ${targetDir}`);
console.log(`Project:      ${projectName}`);
console.log(`Architecture: ${architecture}\n`);

scaffoldProject({
  projectName,
  targetDir,
  architecture,
  forbiddenJargon,
});

console.log(`✨ Successfully scaffolded Agentic Factory in ${targetDir}`);
console.log(`\nNext steps:`);
console.log(`  cd ${targetInput}`);
console.log(`  pnpm install`);
console.log(`  pnpm guard      # Run deterministic AST boundary and cycle checks`);
console.log(`  pnpm test       # Run synthetic scenario and contract test suites\n`);
