import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ScaffoldOptions {
  projectName: string;
  targetDir: string;
  architecture: 'modular-monorepo' | 'hexagonal' | 'microservice';
  forbiddenJargon?: string[];
}

export function copyDirSync(src: string, dest: string, replacements: Record<string, string> = {}) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath, replacements);
    } else {
      let content = fs.readFileSync(srcPath, 'utf-8');
      for (const [key, val] of Object.entries(replacements)) {
        content = content.split(key).join(val);
      }
      fs.writeFileSync(destPath, content, 'utf-8');
    }
  }
}

export function scaffoldProject(options: ScaffoldOptions): void {
  const { projectName, targetDir, architecture, forbiddenJargon = [] } = options;
  fs.mkdirSync(targetDir, { recursive: true });

  // Locate template path relative to package root
  const templateDir = path.resolve(__dirname, '../../templates/modular-monorepo');

  if (fs.existsSync(templateDir)) {
    copyDirSync(templateDir, targetDir, {
      '{{PROJECT_NAME}}': projectName,
      '{{ARCHITECTURE}}': architecture,
    });
  }

  // Write tailored .factoryrc.json
  const factoryConfig = {
    $schema: 'https://agentic-factory.dev/schema.json',
    project: {
      name: projectName,
      architecture,
    },
    guards: {
      noCycles: {
        enabled: true,
        rootDir: 'packages',
      },
      boundaries: [
        {
          package: 'packages/types',
          disallowImportsFrom: ['packages/testing'],
        },
      ],
      plainLanguage: {
        enabled: true,
        targetDirs: ['packages', 'src'],
        forbiddenTerms: forbiddenJargon.length > 0 ? forbiddenJargon : ['internal_id', 'mutex_lock', 'deadlock'],
      },
      secrets: {
        enabled: true,
      },
    },
    testing: {
      targetCoverage: 85,
      maxSuiteDurationMs: 2000,
      requireSyntheticScenarios: true,
    },
  };

  fs.writeFileSync(path.join(targetDir, '.factoryrc.json'), JSON.stringify(factoryConfig, null, 2), 'utf-8');
}

