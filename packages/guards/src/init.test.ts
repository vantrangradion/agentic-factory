import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { initFactoryConfig } from './init.js';

describe('agentic-guards init', () => {
  const tmpDir = path.join(os.tmpdir(), `guard-init-test-${Date.now()}`);

  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects a monorepo workspace from pnpm-workspace.yaml and generates config', () => {
    const monoDir = path.join(tmpDir, 'monorepo-proj');
    fs.mkdirSync(monoDir, { recursive: true });
    fs.writeFileSync(
      path.join(monoDir, 'package.json'),
      JSON.stringify({ name: '@acme/monorepo' }, null, 2)
    );
    fs.writeFileSync(
      path.join(monoDir, 'pnpm-workspace.yaml'),
      "packages:\n  - 'packages/*'\n"
    );
    fs.mkdirSync(path.join(monoDir, 'packages/types/src'), { recursive: true });
    fs.mkdirSync(path.join(monoDir, 'packages/core/src'), { recursive: true });

    const result = initFactoryConfig(monoDir);
    expect(result.created).toBe(true);
    expect(fs.existsSync(result.path)).toBe(true);

    const generated = JSON.parse(fs.readFileSync(result.path, 'utf-8'));
    expect(generated.project.name).toBe('@acme/monorepo');
    expect(generated.project.architecture).toBe('modular-monorepo');
    expect(generated.guards.noCycles.rootDir).toBe('packages');
    expect(generated.guards.todoIssueLinks.enabled).toBe(true);
    expect(generated.guards.commentedCode.enabled).toBe(true);
    expect(generated.guards.deadExports.enabled).toBe(true);
  });

  it('detects a single-package structure and generates config', () => {
    const singleDir = path.join(tmpDir, 'single-proj');
    fs.mkdirSync(singleDir, { recursive: true });
    fs.writeFileSync(
      path.join(singleDir, 'package.json'),
      JSON.stringify({ name: 'single-service' }, null, 2)
    );
    fs.mkdirSync(path.join(singleDir, 'src'), { recursive: true });

    const result = initFactoryConfig(singleDir);
    expect(result.created).toBe(true);

    const generated = JSON.parse(fs.readFileSync(result.path, 'utf-8'));
    expect(generated.project.name).toBe('single-service');
    expect(generated.project.architecture).toBe('single-package');
    expect(generated.guards.noCycles.rootDir).toBe('src');
    expect(generated.guards.todoIssueLinks.enabled).toBe(true);
  });

  it('does not overwrite existing config unless force is true', () => {
    const existingDir = path.join(tmpDir, 'existing-proj');
    fs.mkdirSync(existingDir, { recursive: true });
    const configPath = path.join(existingDir, '.factoryrc.json');
    fs.writeFileSync(configPath, JSON.stringify({ custom: true }));

    const res1 = initFactoryConfig(existingDir, { force: false });
    expect(res1.created).toBe(false);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toEqual({ custom: true });

    const res2 = initFactoryConfig(existingDir, { force: true });
    expect(res2.created).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).not.toEqual({ custom: true });
  });
});

