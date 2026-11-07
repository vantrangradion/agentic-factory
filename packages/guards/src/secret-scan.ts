import * as fs from 'node:fs';
import * as path from 'node:path';
import { SecretScanConfig } from './config.js';
import { collectSourceFiles } from './fs-walk.js';

export interface SecretViolation {
  file: string;
  pattern: string;
  line: number;
}

export interface SecretScanResult {
  hasViolations: boolean;
  violations: SecretViolation[];
  summary: string;
}

const DEFAULT_PATTERNS = [
  /(?:^|[^a-zA-Z0-9])(sk_live_[a-zA-Z0-9]{24,})/i,
  /(?:^|[^a-zA-Z0-9])(ghp_[a-zA-Z0-9]{36})/i,
  /(?:^|[^a-zA-Z0-9])(xox[baprs]-[0-9a-zA-Z]{10,})/i,
  /-----BEGIN\s+(RSA|EC|DSA|OPENSSH|PRIVATE)\s+KEY-----/i,
  /(?:^|[^a-zA-Z0-9])(bearer\s+[a-zA-Z0-9_\-\.]{30,})/i,
];

function calculateEntropy(str: string): number {
  const map: Record<string, number> = {};
  for (let i = 0; i < str.length; i++) {
    const char = str[i]!;
    map[char] = (map[char] || 0) + 1;
  }
  let entropy = 0;
  for (const char in map) {
    const p = map[char]! / str.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const SCANNED_FILE = /\.(ts|tsx|js|jsx|py|pyi|json|yaml|yml|toml|ini|cfg|md|env)$/;
const LOCK_FILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb', 'poetry.lock'];

function collectFiles(dir: string): string[] {
  return collectSourceFiles(dir, {
    include: (name) => SCANNED_FILE.test(name) && !LOCK_FILES.includes(name),
    skipDirs: ['.gemini', 'coverage'],
  });
}

export function checkSecrets(projectRoot: string, config?: SecretScanConfig): SecretScanResult {
  if (config?.enabled === false) {
    return { hasViolations: false, violations: [], summary: 'PASS: Secret scanner disabled' };
  }

  const customPatterns = (config?.patterns || []).map((p) => new RegExp(p, 'i'));
  const allPatterns = [...DEFAULT_PATTERNS, ...customPatterns];
  const files = collectFiles(projectRoot);
  const violations: SecretViolation[] = [];

  for (const file of files) {
    // Skip test fixtures or guard configs that mention the patterns themselves
    if (file.endsWith('.factoryrc.json') || file.includes('packages/guards/src/')) {
      continue;
    }

    const isDoc = file.endsWith('.md');
    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n');

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx]!;

      for (const pattern of allPatterns) {
        if (pattern.test(line)) {
          violations.push({
            file: path.relative(projectRoot, file),
            pattern: pattern.source,
            line: idx + 1,
          });
          break;
        }
      }

      // Check high entropy for token-like substrings (> 32 chars) in non-doc code files
      if (!isDoc && !line.includes('import ') && !line.includes('mock')) {
        const tokens = line.match(/[a-zA-Z0-9_\-]{32,}/g);
        if (tokens) {
          for (const token of tokens) {
            if (calculateEntropy(token) > 4.5 && !line.includes('sha256') && !line.includes('base64')) {
              violations.push({
                file: path.relative(projectRoot, file),
                pattern: 'high-entropy-token',
                line: idx + 1,
              });
              break;
            }
          }
        }
      }
    }
  }

  const hasViolations = violations.length > 0;
  const summary = hasViolations
    ? `FAIL: Found ${violations.length} potential secret/PII violation(s)`
    : `PASS: 0 secrets or sensitive tokens detected across repository`;

  return { hasViolations, violations, summary };
}
