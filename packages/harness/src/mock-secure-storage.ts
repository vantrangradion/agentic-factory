export class SecureStorageLockedError extends Error {
  constructor(message: string = 'Secure storage is locked') {
    super(message);
    this.name = 'SecureStorageLockedError';
  }
}

export class SecureStorageFaultError extends Error {
  constructor(fault: string) {
    super(`Secure storage operation failed due to simulated fault: ${fault}`);
    this.name = 'SecureStorageFaultError';
  }
}

export type SecureStorageFault = 'unavailable' | 'corrupt' | 'io-error' | null;

export interface ISecureStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
  listKeys(): Promise<string[]>;
  clear(): Promise<void>;
}

export class MockSecureStorage implements ISecureStorage {
  private store: Map<string, string> = new Map();
  private locked: boolean = false;
  private currentFault: SecureStorageFault = null;

  lock(): void {
    this.locked = true;
  }

  unlock(): void {
    this.locked = false;
  }

  isLocked(): boolean {
    return this.locked;
  }

  injectFault(fault: SecureStorageFault): void {
    this.currentFault = fault;
  }

  seed(entries: Record<string, string>): void {
    for (const [key, value] of Object.entries(entries)) {
      this.store.set(key, value);
    }
  }

  dumpRaw(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [k, v] of this.store.entries()) {
      result[k] = v;
    }
    return result;
  }

  private assertAccessible(): void {
    if (this.currentFault) {
      throw new SecureStorageFaultError(this.currentFault);
    }
    if (this.locked) {
      throw new SecureStorageLockedError();
    }
  }

  async get(key: string): Promise<string | null> {
    this.assertAccessible();
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  async set(key: string, value: string): Promise<void> {
    this.assertAccessible();
    this.store.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    this.assertAccessible();
    return this.store.delete(key);
  }

  async has(key: string): Promise<boolean> {
    this.assertAccessible();
    return this.store.has(key);
  }

  async listKeys(): Promise<string[]> {
    this.assertAccessible();
    return Array.from(this.store.keys());
  }

  async clear(): Promise<void> {
    this.assertAccessible();
    this.store.clear();
  }
}

