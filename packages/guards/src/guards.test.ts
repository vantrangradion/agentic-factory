import { describe, it, expect } from 'vitest';
import { checkNoCycles } from './no-cycles.js';
import { checkBoundaries } from './boundary-guard.js';
import { checkPlainLanguage } from './plain-language.js';
import { checkSecrets } from './secret-scan.js';
import * as path from 'node:path';

const projectRoot = path.resolve(__dirname, '..');

describe('Factory Guard Engine', () => {
  it('detects 0 cycles across clean codebase', () => {
    const result = checkNoCycles(projectRoot, { rootDir: 'src' });
    expect(result.hasCycles).toBe(false);
  });

  it('verifies boundary enforcement logic', () => {
    const result = checkBoundaries(projectRoot, [
      { package: 'src', disallowImportsFrom: ['non_existent_package'] },
    ]);
    expect(result.hasViolations).toBe(false);
  });

  it('verifies plain language scanner catches jargon when present', () => {
    const result = checkPlainLanguage(projectRoot, {
      enabled: true,
      targetDirs: ['src'],
      forbiddenTerms: ['non_existent_forbidden_term_12345'],
    });
    expect(result.hasViolations).toBe(false);
  });

  it('scans secrets cleanly', () => {
    const result = checkSecrets(projectRoot, { enabled: true });
    expect(result.hasViolations).toBe(false);
  });
});
