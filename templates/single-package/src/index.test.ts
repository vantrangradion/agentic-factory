import { describe, it, expect } from 'vitest';
import { helloFactory } from './index.js';

describe('Factory Entrypoint', () => {
  it('returns greeting', () => {
    expect(helloFactory()).toContain('Agentic');
  });
});

