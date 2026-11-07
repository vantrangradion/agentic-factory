import { MockClock } from './mock-clock.js';

export type RouteUrlMatcher = string | RegExp | ((url: string) => boolean);

export interface MockResponseOptions {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: any;
  latencyMs?: number;
  error?: Error;
}

export type RouteHandler =
  | MockResponseOptions
  | ((req: Request) => Promise<MockResponseOptions | Response> | MockResponseOptions | Response);

export interface RecordedExchange {
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string | undefined;
  };
  response: {
    status: number;
    statusText?: string | undefined;
    headers: Record<string, string>;
    body?: string | undefined;
  };
  timestamp: number;
}

interface RouteEntry {
  matcher: RouteUrlMatcher;
  handler: RouteHandler;
  method?: string | undefined;
}

interface PendingLatency {
  targetTime: number;
  resolve: () => void;
}

export class MockHttpHarness {
  private originalFetch: typeof globalThis.fetch | null = null;
  private installed: boolean = false;
  private routes: RouteEntry[] = [];
  private history: RecordedExchange[] = [];
  private replayQueue: RecordedExchange[] = [];
  private mockClock: MockClock | null = null;
  private defaultLatencyMs: number = 0;
  private pendingLatencies: PendingLatency[] = [];
  private restoreClockHook: (() => void) | null = null;

  constructor(options?: { defaultLatencyMs?: number; clock?: MockClock }) {
    if (options?.defaultLatencyMs !== undefined) {
      this.defaultLatencyMs = options.defaultLatencyMs;
    }
    if (options?.clock) {
      this.setClock(options.clock);
    }
  }

  install(): this {
    if (this.installed) return this;
    this.originalFetch = globalThis.fetch;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      return this.handleFetch(input, init);
    };

    this.installed = true;
    return this;
  }

  restore(): void {
    if (!this.installed) return;
    if (this.originalFetch) {
      globalThis.fetch = this.originalFetch;
      this.originalFetch = null;
    }
    if (this.restoreClockHook) {
      this.restoreClockHook();
      this.restoreClockHook = null;
    }
    this.installed = false;
  }

  setClock(clock: MockClock): this {
    if (this.restoreClockHook) {
      this.restoreClockHook();
    }
    this.mockClock = clock;
    const origAdvanceBy = clock.advanceBy.bind(clock);

    clock.advanceBy = (ms: number) => {
      origAdvanceBy(ms);
      this.checkPendingLatencies();
    };

    this.restoreClockHook = () => {
      clock.advanceBy = origAdvanceBy;
    };

    return this;
  }

  setLatency(ms: number): this {
    this.defaultLatencyMs = Math.max(0, ms);
    return this;
  }

  on(matcher: RouteUrlMatcher, handler: RouteHandler, method?: string): this {
    this.routes.push({
      matcher,
      handler,
      method: method ? method.toUpperCase() : undefined,
    });
    return this;
  }

  get(matcher: RouteUrlMatcher, handler: RouteHandler): this {
    return this.on(matcher, handler, 'GET');
  }

  post(matcher: RouteUrlMatcher, handler: RouteHandler): this {
    return this.on(matcher, handler, 'POST');
  }

  put(matcher: RouteUrlMatcher, handler: RouteHandler): this {
    return this.on(matcher, handler, 'PUT');
  }

  delete(matcher: RouteUrlMatcher, handler: RouteHandler): this {
    return this.on(matcher, handler, 'DELETE');
  }

  getHistory(): RecordedExchange[] {
    return [...this.history];
  }

  clearHistory(): void {
    this.history = [];
  }

  exportReplay(): RecordedExchange[] {
    return JSON.parse(JSON.stringify(this.history));
  }

  loadReplay(fixtures: RecordedExchange[] | string): void {
    const list = typeof fixtures === 'string' ? JSON.parse(fixtures) : fixtures;
    this.replayQueue.push(...JSON.parse(JSON.stringify(list)));
  }

  reset(): void {
    this.routes = [];
    this.history = [];
    this.replayQueue = [];
    this.pendingLatencies = [];
    this.defaultLatencyMs = 0;
  }

  [Symbol.dispose](): void {
    this.restore();
  }

  private checkPendingLatencies(): void {
    if (!this.mockClock) return;
    const now = this.mockClock.now();
    const ready: PendingLatency[] = [];
    const remaining: PendingLatency[] = [];

    for (const pending of this.pendingLatencies) {
      if (pending.targetTime <= now) {
        ready.push(pending);
      } else {
        remaining.push(pending);
      }
    }

    this.pendingLatencies = remaining;
    for (const r of ready) {
      r.resolve();
    }
  }

  private async delay(ms: number): Promise<void> {
    if (ms <= 0) return;
    if (this.mockClock) {
      const now = this.mockClock.now();
      const targetTime = now + ms;
      return new Promise<void>((resolve) => {
        this.pendingLatencies.push({ targetTime, resolve });
      });
    }
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private matchesRoute(matcher: RouteUrlMatcher, url: string): boolean {
    if (typeof matcher === 'string') {
      return url === matcher || url.startsWith(matcher);
    }
    if (matcher instanceof RegExp) {
      return matcher.test(url);
    }
    if (typeof matcher === 'function') {
      return matcher(url);
    }
    return false;
  }

  private async handleFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const req = new Request(input, init);
    const url = req.url;
    const method = req.method.toUpperCase();

    // Check Replay Queue first
    if (this.replayQueue.length > 0) {
      const replayIdx = this.replayQueue.findIndex(
        (ex) => ex.request.method === method && ex.request.url === url
      );
      if (replayIdx !== -1) {
        const [exchange] = this.replayQueue.splice(replayIdx, 1);
        if (exchange) {
          const resp = new Response(exchange.response.body, {
            status: exchange.response.status,
            ...(exchange.response.statusText ? { statusText: exchange.response.statusText } : {}),
            headers: exchange.response.headers,
          });
          return resp;
        }
      }
    }

    // Match registered route
    const matched = this.routes.find((r) => {
      if (r.method && r.method !== method) return false;
      return this.matchesRoute(r.matcher, url);
    });

    if (!matched) {
      throw new Error(`[MockHttpHarness] No mock route handler configured for [${method}] ${url}`);
    }

    let responseOptions: MockResponseOptions | Response;
    if (typeof matched.handler === 'function') {
      responseOptions = await matched.handler(req);
    } else {
      responseOptions = matched.handler;
    }

    if (responseOptions instanceof Response) {
      return responseOptions;
    }

    if (responseOptions.error) {
      throw responseOptions.error;
    }

    const latency = responseOptions.latencyMs ?? this.defaultLatencyMs;
    if (latency > 0) {
      await this.delay(latency);
    }

    const status = responseOptions.status ?? 200;
    const statusText = responseOptions.statusText ?? (status === 200 ? 'OK' : '');
    const headers: Record<string, string> = { ...responseOptions.headers };

    let bodyText: string = '';
    if (responseOptions.body !== undefined && responseOptions.body !== null) {
      if (typeof responseOptions.body === 'string') {
        bodyText = responseOptions.body;
      } else {
        bodyText = JSON.stringify(responseOptions.body);
        if (!headers['content-type']) {
          headers['content-type'] = 'application/json';
        }
      }
    }

    // Clone request body for history
    let reqBodyText: string | undefined;
    try {
      reqBodyText = init?.body ? String(init.body) : undefined;
    } catch {
      // Ignore
    }

    const recorded: RecordedExchange = {
      request: {
        url,
        method,
        headers: Object.fromEntries(req.headers.entries()),
        body: reqBodyText,
      },
      response: {
        status,
        statusText,
        headers,
        body: bodyText,
      },
      timestamp: this.mockClock ? this.mockClock.now() : Date.now(),
    };
    this.history.push(recorded);

    return new Response(bodyText, {
      status,
      ...(statusText ? { statusText } : {}),
      headers,
    });
  }
}
