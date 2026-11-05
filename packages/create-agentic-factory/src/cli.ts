#!/usr/bin/env node
import * as path from 'node:path';
import { scaffoldProject, promptOptions, ScaffoldOptions } from './scaffolder.js';

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`\nUsage: npx create-agentic-factory [target-directory] [options]\n`);
    console.log(`Options:`);
    console.log(`  --arch <architecture>   Architecture preset: 'modular-monorepo' (default), 'single-package'`);
    console.log(`  --single-package        Shortcut for '--arch single-package'`);
    console.log(`  --jargon <terms>        Comma-separated list of prohibited UI/CLI jargon terms`);
    console.log(`  --interactive, -i       Force interactive configuration prompts`);
    console.log(`  --help, -h              Show this help message\n`);
    process.exit(0);
  }

  const isExplicitInteractive = args.includes('--interactive') || args.includes('-i');
  const isNoArgsInteractive = args.length === 0 && Boolean(process.stdin.isTTY);

  let options: ScaffoldOptions;

  if (isExplicitInteractive || isNoArgsInteractive) {
    console.log(`\n🏭 Interactive Setup: Project-Agnostic Agentic Software Factory\n`);
    options = await promptOptions();
  } else {
    const targetInput = args.find((a) => !a.startsWith('-')) || 'my-agentic-app';
    const targetDir = path.resolve(process.cwd(), targetInput);
    const projectName = path.basename(targetDir);

    let architecture: ScaffoldOptions['architecture'] = 'modular-monorepo';
    if (args.includes('--single-package')) {
      architecture = 'single-package';
    } else {
      const archIndex = args.indexOf('--arch');
      if (archIndex !== -1 && args[archIndex + 1]) {
        const chosen = args[archIndex + 1] as ScaffoldOptions['architecture'];
        if (['modular-monorepo', 'single-package', 'hexagonal', 'microservice'].includes(chosen)) {
          architecture = chosen;
        }
      }
    }

    const forbiddenJargon: string[] = [];
    const jargonIndex = args.indexOf('--jargon');
    if (jargonIndex !== -1 && args[jargonIndex + 1]) {
      forbiddenJargon.push(...args[jargonIndex + 1]!.split(',').map((t) => t.trim()));
    }

    options = {
      projectName,
      targetDir,
      architecture,
      forbiddenJargon,
    };
  }

  console.log(`\n🏭 Initializing Project-Agnostic Agentic Factory...`);
  console.log(`Target:       ${options.targetDir}`);
  console.log(`Project:      ${options.projectName}`);
  console.log(`Architecture: ${options.architecture}\n`);

  scaffoldProject(options);

  console.log(`✨ Successfully scaffolded Agentic Factory in ${options.targetDir}`);
  console.log(`\nNext steps:`);
  console.log(`  cd ${path.relative(process.cwd(), options.targetDir) || '.'}`);
  console.log(`  pnpm install`);
  console.log(`  pnpm guard      # Run deterministic AST boundary and cycle checks`);
  console.log(`  pnpm test       # Run synthetic scenario and contract test suites\n`);
}

main().catch((err) => {
  console.error(`\n❌ Error: ${err.message}\n`);
  process.exit(1);
});
