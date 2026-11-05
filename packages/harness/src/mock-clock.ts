export class MockClock {
  private currentTime: number;

  constructor(initialEpochMs: number = 1700000000000) {
    this.currentTime = initialEpochMs;
  }

  /**
   * Returns the current virtual timestamp in milliseconds
   */
  now(): number {
    return this.currentTime;
  }

  /**
   * Returns current virtual time as an ISO string
   */
  toISOString(): string {
    return new Date(this.currentTime).toISOString();
  }

  /**
   * Advances virtual clock by specified milliseconds
   */
  advanceBy(ms: number): void {
    if (ms < 0) throw new Error('Cannot advance clock backward');
    this.currentTime += ms;
  }

  /**
   * Sets the virtual clock to a specific timestamp
   */
  setTime(timestamp: number): void {
    this.currentTime = timestamp;
  }
}

