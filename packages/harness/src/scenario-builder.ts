import { PRNG } from './prng.js';
import { MockClock } from './mock-clock.js';

export interface SyntheticItem<T> {
  id: string;
  timestamp: number;
  data: T;
}

export class ScenarioBuilder<T> {
  private prng: PRNG;
  private clock: MockClock;
  private items: SyntheticItem<T>[] = [];

  constructor(seed: number = 100) {
    this.prng = new PRNG(seed);
    this.clock = new MockClock();
  }

  getClock(): MockClock {
    return this.clock;
  }

  getPRNG(): PRNG {
    return this.prng;
  }

  /**
   * Generates N synthetic items using a generator function
   */
  generate(count: number, generator: (index: number, prng: PRNG, clock: MockClock) => T, intervalMs: number = 1000): this {
    for (let i = 0; i < count; i++) {
      this.clock.advanceBy(intervalMs);
      const data = generator(i, this.prng, this.clock);
      this.items.push({
        id: this.prng.uuid(),
        timestamp: this.clock.now(),
        data,
      });
    }
    return this;
  }

  /**
   * Returns all generated items
   */
  build(): SyntheticItem<T>[] {
    return [...this.items];
  }

  /**
   * Resets the builder state
   */
  reset(): void {
    this.items = [];
  }
}
