import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkTestOnlyKeys } from './test-only-keys.js';

let root: string;
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-test-only-keys-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('test-only keys', () => {
  it('flags a config key the product reads but only tests set', () => {
    // The real failure: health came from a key nothing in the product writes, so the app always looked healthy.
    write('src/status.ts', `
      export function sinkHealth(entry: Record<string, unknown>) {
        return entry['health'] === 'down' ? 'down' : entry.enabled ? 'ok' : 'off';
      }
    `);
    write('src/config.ts', `export const defaults = { enabled: true };`);
    write('src/status.test.ts', `
      import { sinkHealth } from './status.js';
      it('reports down', () => expect(sinkHealth({ enabled: true, health: 'down' })).toBe('down'));
    `);

    const result = checkTestOnlyKeys(root, { enabled: true });

    expect(result.hasViolations).toBe(true);
    expect(result.violations).toEqual([{ file: path.join('src', 'status.ts'), key: 'health', line: 3, col: 22 }]);
  });

  it('accepts keys the product declares in a type, a literal, an assignment or a config file', () => {
    write('src/status.ts', `
      interface Sink { retries?: number }
      export function read(s: Sink, o: any, p: any, q: any) {
        o.timeout = 5;
        const { region } = p;
        return [s.retries, o.timeout, region, q.color, q.label];
      }
      export const labels = { label: 'x' };
    `);
    write('config/default.json', JSON.stringify({ sinks: [{ region: 'eu' }] }));
    write('config/theme.yaml', 'theme:\n  color: blue\n');
    write('src/status.test.ts', `const fake = { retries: 1, timeout: 2, region: 'x', color: 'red', label: 'y' };`);

    expect(checkTestOnlyKeys(root, { enabled: true }).violations).toEqual([]);
  });

  it('treats fixtures and test folders as test code, and honours ignoreKeys', () => {
    write('src/http.ts', `export const ok = (res: any) => res.statusCode === 200 && res.debugMode;`);
    write('tests/helpers/fake-response.ts', `export const fake = { statusCode: 200 };`);
    write('src/__fixtures__/x.json', '{}');
    write('test/fixtures/config.json', JSON.stringify({ debugMode: true }));

    const flagged = checkTestOnlyKeys(root, { enabled: true }).violations.map((v) => v.key);
    expect(flagged).toEqual(['statusCode', 'debugMode']);
    expect(checkTestOnlyKeys(root, { enabled: true, ignoreKeys: ['statusCode'] }).violations.map((v) => v.key)).toEqual(['debugMode']);
  });

  it('ignores method calls and keys that tests never set', () => {
    write('src/a.ts', `export const run = (svc: any) => { svc.start(); return svc['stop']() && svc.unknownField; };`);
    write('src/a.test.ts', `const svc = { start() {}, stop: () => true };`);
    expect(checkTestOnlyKeys(root, { enabled: true }).hasViolations).toBe(false);
  });

  it('is off unless the config turns it on', () => {
    write('src/a.ts', `export const f = (o: any) => o.secretKnob;`);
    write('src/a.test.ts', `f({ secretKnob: 1 });`);
    expect(checkTestOnlyKeys(root).summary).toContain('disabled');
    expect(checkTestOnlyKeys(root, { enabled: true }).hasViolations).toBe(true);
  });
});
