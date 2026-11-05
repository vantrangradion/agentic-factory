import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockHttpHarness, RecordedExchange } from './mock-http.js';
import { MockClock } from './mock-clock.js';

describe('MockHttpHarness', () => {
  let harness: MockHttpHarness;

  beforeEach(() => {
    harness = new MockHttpHarness();
    harness.install();
  });

  afterEach(() => {
    harness.restore();
  });

  it('intercepts fetch requests and returns mocked JSON response', async () => {
    harness.get('https://api.example.com/users', {
      status: 200,
      body: [{ id: 1, name: 'Alice' }],
    });

    const res = await fetch('https://api.example.com/users');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual([{ id: 1, name: 'Alice' }]);
  });

  it('matches routes by regex and method', async () => {
    harness.post(/\/api\/items/, async (req) => {
      const payload = await req.json();
      return {
        status: 201,
        body: { id: 99, ...payload },
      };
    });

    const res = await fetch('https://api.example.com/api/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Widget' }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data).toEqual({ id: 99, title: 'Widget' });
  });

  it('records exchange history and exports replay fixture', async () => {
    harness.get('https://api.example.com/status', {
      status: 200,
      body: { ok: true },
    });

    await fetch('https://api.example.com/status');

    const history = harness.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0]?.request.url).toBe('https://api.example.com/status');
    expect(history[0]?.request.method).toBe('GET');
    expect(history[0]?.response.status).toBe(200);

    const replayData = harness.exportReplay();
    expect(replayData).toHaveLength(1);
  });

  it('replays pre-recorded network exchanges deterministically', async () => {
    const recordedFixture: RecordedExchange[] = [
      {
        request: {
          url: 'https://api.example.com/profile',
          method: 'GET',
          headers: {},
        },
        response: {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'synthetic_agent' }),
        },
        timestamp: 1000,
      },
    ];

    harness.loadReplay(recordedFixture);

    const res = await fetch('https://api.example.com/profile');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ username: 'synthetic_agent' });
  });

  it('simulates network errors when configured', async () => {
    harness.on('https://api.example.com/unstable', {
      error: new TypeError('Network connection reset'),
    });

    await expect(fetch('https://api.example.com/unstable')).rejects.toThrow('Network connection reset');
  });

  it('supports deterministic latency with MockClock', async () => {
    const clock = new MockClock(0);
    harness.setClock(clock);
    harness.get('https://api.example.com/slow', {
      status: 200,
      body: 'done',
      latencyMs: 100,
    });

    const fetchPromise = fetch('https://api.example.com/slow');
    clock.advanceBy(100);

    const res = await fetchPromise;
    expect(await res.text()).toBe('done');
  });

  it('restores original fetch on restore()', async () => {
    const originalFetch = globalThis.fetch;
    harness.restore();
    expect(globalThis.fetch).not.toBe(originalFetch); // It restores back to the native fetch before install
  });
});

