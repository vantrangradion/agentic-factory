import { describe, it, expect } from 'vitest';
import { createSyntheticEventScenario } from './index.js';

describe('Synthetic Scenario Harness', () => {
  it('generates deterministic synthetic event sequences', () => {
    const events1 = createSyntheticEventScenario(5, 12345);
    const events2 = createSyntheticEventScenario(5, 12345);

    expect(events1).toHaveLength(5);
    expect(events1).toEqual(events2);
    expect(events1[0]!.payload).toBe('synthetic-payload-0');
  });
});

