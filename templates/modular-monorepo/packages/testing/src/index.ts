import { ScenarioBuilder, PRNG, MockClock } from '@agentic-factory/harness';
import type { BaseEvent } from '@{{PROJECT_NAME}}/types';

export function createSyntheticEventScenario(count: number = 5, seed: number = 42) {
  const builder = new ScenarioBuilder<BaseEvent<string>>(seed);
  return builder.generate(count, (idx, prng, clock) => ({
    eventId: prng.uuid(),
    timestamp: clock.now(),
    type: 'SYNTHETIC_DATA_PROCESSED',
    payload: `synthetic-payload-${idx}`,
  })).build();
}
