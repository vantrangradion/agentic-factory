import { PRNG } from './prng.js';

export interface FaultConfig {
  errorRate: number; // 0.0 to 1.0 probability of error
  latencyMs?: number; // Simulated latency
  errorMessage?: string;
}

export class FaultInjector {
  private prng: PRNG;
  private config: FaultConfig;

  constructor(config: FaultConfig, seed: number = 1337) {
    this.config = config;
    this.prng = new PRNG(seed);
  }

  /**
   * Evaluates if a fault should trigger. Throws error if triggered.
   */
  async maybeThrow(): Promise<void> {
    if (this.config.latencyMs && this.config.latencyMs > 0) {
      await new Promise((res) => setTimeout(res, this.config.latencyMs));
    }
    if (this.prng.nextBoolean(this.config.errorRate)) {
      throw new Error(this.config.errorMessage || 'Simulated synthetic system fault');
    }
  }

  /**
   * Wraps an async function with fault injection
   */
  async wrap<T>(operation: () => Promise<T>): Promise<T> {
    await this.maybeThrow();
    return await operation();
  }
}
