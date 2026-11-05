import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { scaffoldProject } from './scaffolder.js';

describe('Scaffolder Engine', () => {
  it('scaffolds a complete project-agnostic factory structure', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-test-'));
    const targetDir = path.join(tempDir, 'demo-app');

    scaffoldProject({
      projectName: 'demo-app',
      targetDir,
      architecture: 'modular-monorepo',
      forbiddenJargon: ['custom_forbidden_term'],
    });

    expect(fs.existsSync(targetDir)).toBe(true);
    expect(fs.existsSync(path.join(targetDir, '.factoryrc.json'))).toBe(true);

    const configContent = fs.readFileSync(path.join(targetDir, '.factoryrc.json'), 'utf-8');
    const config = JSON.parse(configContent);
    expect(config.project.name).toBe('demo-app');
    expect(config.project.architecture).toBe('modular-monorepo');
    expect(config.guards.plainLanguage.forbiddenTerms).toContain('custom_forbidden_term');

    // Clean up
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

