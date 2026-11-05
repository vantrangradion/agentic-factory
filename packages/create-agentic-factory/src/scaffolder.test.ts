import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PassThrough, Writable } from 'node:stream';
import { scaffoldProject, promptOptions } from './scaffolder.js';

describe('Scaffolder Engine', () => {
  it('scaffolds a complete project-agnostic factory structure (modular-monorepo)', () => {
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
    expect(config.guards.todoIssueLinks.enabled).toBe(true);
    expect(config.guards.commentedCode.enabled).toBe(true);
    expect(config.guards.deadExports.enabled).toBe(true);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('scaffolds a single-package preset with dedicated topology', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-single-test-'));
    const targetDir = path.join(tempDir, 'single-app');

    scaffoldProject({
      projectName: 'single-app',
      targetDir,
      architecture: 'single-package',
    });

    expect(fs.existsSync(targetDir)).toBe(true);
    expect(fs.existsSync(path.join(targetDir, '.factoryrc.json'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'src/index.ts'))).toBe(true);

    const configContent = fs.readFileSync(path.join(targetDir, '.factoryrc.json'), 'utf-8');
    const config = JSON.parse(configContent);
    expect(config.project.architecture).toBe('single-package');
    expect(config.guards.noCycles.rootDir).toBe('src');
    expect(config.guards.boundaries).toEqual([]);
    expect(config.guards.todoIssueLinks.enabled).toBe(true);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('collects options via interactive prompts stream', async () => {
    const inputStream = new PassThrough();
    const outputStream = new Writable({
      write(chunk, _encoding, callback) {
        const text = chunk.toString();
        if (text.includes('Project directory name')) {
          inputStream.write('my-interactive-project\n');
        } else if (text.includes('Choice (1/2)')) {
          inputStream.write('2\n');
        } else if (text.includes('Forbidden plain language terms')) {
          inputStream.write('foo_jargon,bar_jargon\n');
        }
        callback();
      },
    });

    const options = await promptOptions({
      input: inputStream,
      output: outputStream,
    });

    expect(options.projectName).toBe('my-interactive-project');
    expect(options.architecture).toBe('single-package');
    expect(options.forbiddenJargon).toEqual(['foo_jargon', 'bar_jargon']);
  });
});
