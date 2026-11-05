import { describe, it, expect, beforeEach } from 'vitest';
import { MockSecureStorage, SecureStorageLockedError, SecureStorageFaultError } from './mock-secure-storage.js';

describe('MockSecureStorage', () => {
  let storage: MockSecureStorage;

  beforeEach(() => {
    storage = new MockSecureStorage();
  });

  it('stores, retrieves, and deletes sensitive credentials', async () => {
    await storage.set('api_key', 'secret_value_123');
    expect(await storage.has('api_key')).toBe(true);
    expect(await storage.get('api_key')).toBe('secret_value_123');

    const keys = await storage.listKeys();
    expect(keys).toEqual(['api_key']);

    const deleted = await storage.delete('api_key');
    expect(deleted).toBe(true);
    expect(await storage.get('api_key')).toBeNull();
  });

  it('returns null for nonexistent keys', async () => {
    expect(await storage.get('nonexistent')).toBeNull();
    expect(await storage.has('nonexistent')).toBe(false);
  });

  it('throws SecureStorageLockedError when storage is locked', async () => {
    await storage.set('session_token', 'token_xyz');
    storage.lock();

    expect(storage.isLocked()).toBe(true);
    await expect(storage.get('session_token')).rejects.toThrow(SecureStorageLockedError);
    await expect(storage.set('other', 'val')).rejects.toThrow(SecureStorageLockedError);
    await expect(storage.delete('session_token')).rejects.toThrow(SecureStorageLockedError);
    await expect(storage.has('session_token')).rejects.toThrow(SecureStorageLockedError);
    await expect(storage.listKeys()).rejects.toThrow(SecureStorageLockedError);
    await expect(storage.clear()).rejects.toThrow(SecureStorageLockedError);

    storage.unlock();
    expect(storage.isLocked()).toBe(false);
    expect(await storage.get('session_token')).toBe('token_xyz');
  });

  it('injects faults for error testing', async () => {
    storage.injectFault('unavailable');
    await expect(storage.get('key')).rejects.toThrow(SecureStorageFaultError);

    storage.injectFault(null);
    await storage.set('key', 'val');
    expect(await storage.get('key')).toBe('val');
  });

  it('allows seed and raw storage inspection for test verification', async () => {
    storage.seed({
      tokenA: 'valA',
      tokenB: 'valB',
    });

    expect(await storage.listKeys()).toEqual(['tokenA', 'tokenB']);
    const raw = storage.dumpRaw();
    expect(raw).toEqual({ tokenA: 'valA', tokenB: 'valB' });
  });

  it('clears all entries on clear()', async () => {
    await storage.set('a', '1');
    await storage.set('b', '2');
    await storage.clear();
    expect(await storage.listKeys()).toEqual([]);
  });
});

