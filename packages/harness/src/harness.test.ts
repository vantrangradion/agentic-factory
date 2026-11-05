import { describe, it, expect } from 'vitest';
import { PRNG } from './prng.js';
import { MockClock } from './mock-clock.js';
import { ScenarioBuilder } from './scenario-builder.js';
import { FaultInjector } from './fault-injector.js';
import { executeContractSuite, ContractSuite } from './contract-runner.js';

describe('Factory Testing Harness', () => {
  it('PRNG generates deterministic pseudo-random sequence with seeds', () => {
    const prng1 = new PRNG(12345);
    const prng2 = new PRNG(12345);
    expect(prng1.nextInt(1, 100)).toBe(prng2.nextInt(1, 100));
    expect(prng1.uuid()).toBe(prng2.uuid());
  });

  it('MockClock advances deterministically without real setTimeout', () => {
    const clock = new MockClock(1000);
    expect(clock.now()).toBe(1000);
    clock.advanceBy(500);
    expect(clock.now()).toBe(1500);
  });

  it('ScenarioBuilder synthesizes deterministic events with virtual time', () => {
    const builder = new ScenarioBuilder<{ msg: string }>(999);
    const scenario = builder.generate(3, (idx) => ({ msg: `item-${idx}` })).build();

    expect(scenario).toHaveLength(3);
    expect(scenario[0]!.data.msg).toBe('item-0');
    expect(scenario[1]!.data.msg).toBe('item-1');
  });

  it('FaultInjector throws when error probability is 1.0', async () => {
    const injector = new FaultInjector({ errorRate: 1.0, errorMessage: 'Fault' });
    await expect(injector.wrap(async () => 'ok')).rejects.toThrow('Fault');
  });

  it('ContractRunner verifies implementations against contract suites', async () => {
    interface KVStore {
      set: (k: string, v: string) => void;
      get: (k: string) => string | undefined;
    }

    const kvSuite: ContractSuite<KVStore> = {
      name: 'KVStore Contract',
      tests: [
        {
          description: 'stores and retrieves values',
          run: (getStore) => {
            const store = getStore();
            store.set('key', 'val');
            expect(store.get('key')).toBe('val');
          },
        },
      ],
    };

    const inMemoryImpl = {
      name: 'InMemoryKV',
      create: () => {
        const map = new Map<string, string>();
        return {
          set: (k: string, v: string) => map.set(k, v),
          get: (k: string) => map.get(k),
        };
      },
    };

    const result = await executeContractSuite(kvSuite, inMemoryImpl);
    expect(result.passed).toBe(true);
    expect(result.total).toBe(1);
    expect(result.failures).toBe(0);
  });
});

