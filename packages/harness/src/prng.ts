/**
 * Deterministic Pseudo-Random Number Generator (Mulberry32)
 */
export class PRNG {
  private state: number;

  constructor(seed: number = 42) {
    this.state = seed >>> 0;
  }

  /**
   * Generates a random float in [0, 1)
   */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let z = this.state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Generates a random integer in [min, max]
   */
  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /**
   * Generates a random boolean with specified probability of true
   */
  nextBoolean(probabilityTrue: number = 0.5): boolean {
    return this.next() < probabilityTrue;
  }

  /**
   * Randomly selects an element from an array
   */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Cannot pick from empty array');
    const index = Math.floor(this.next() * items.length);
    return items[index]!;
  }

  /**
   * Generates a deterministic synthetic UUID-like string
   */
  uuid(): string {
    const s4 = () => this.nextInt(0x1000, 0xffff).toString(16);
    return `${s4()}${s4()}-${s4()}-4${s4().substr(0, 3)}-8${s4().substr(0, 3)}-${s4()}${s4()}${s4()}`;
  }
}

