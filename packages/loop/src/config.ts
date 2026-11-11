import type { AgentConfig, ModelPricing } from '@agentic-factory/guards';
import { VENDORS } from './vendors/index.js';

export interface ResolvedGate {
  name: string;
  run: string;
  timeoutMs: number;
}

/** Paths the agent may never change, whatever the project config says. */
export const ALWAYS_PROTECTED = ['.factoryrc.json', '.factoryrc', 'factory.config.json', '.github/**'];

export const DEFAULT_TEST_FILES = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
  '**/test_*.py',
  '**/*_test.py',
  '**/*_test.go',
];

export interface ResolvedSandbox {
  image: string;
  env: string[];
  gateNetwork: boolean;
  memory: string | null;
  cpus: number | null;
  /** The agent session runs in a container too. */
  agent: boolean;
  /** Docker volume holding the agent's login. Default: one per vendor, e.g. "agentic-loop-agy-auth". */
  authVolume: string;
}

/** The login volume for agy, the default runner. Other vendors default to their own volume. */
export const DEFAULT_AUTH_VOLUME = 'agentic-loop-agy-auth';

export interface ResolvedPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cachedInputPerMTok: number;
}

/** Agent CLIs the loop can drive. Each has an adapter in ./vendors. */
export const RUNNERS = ['antigravity-cli', 'claude-code'] as const;
export type RunnerName = (typeof RUNNERS)[number];

export interface ResolvedAgentConfig {
  runner: RunnerName;
  /** Default model. */
  model: string;
  routes: { labels: string[]; model: string }[];
  labels: { ready: string; working: string; prOpen: string; needsHuman: string; planReview: string; planApproved: string };
  plan: { approval: 'required' | 'none' };
  review: { when: 'never' | 'labelled' | 'always'; labels: string[]; model: string | null; maxFixRounds: number };
  context: string[];
  gates: ResolvedGate[];
  tdd: { enabled: boolean; redGate: string; testFiles: string[] };
  protectedPaths: string[];
  maxAttempts: number;
  sessionTimeoutMs: number;
  branchPrefix: string;
  setup: string | null;
  ledgerBranch: string;
  /** Null: setup and gates run on the host. */
  sandbox: ResolvedSandbox | null;
  /** GitHub logins, without "@". */
  reviewers: { plan: string[]; pr: string[] };
  notify: { workspace: { url: string; channel: string; cc: { plan: string; pr: string } } | null };
  budget: {
    weeklyUsd: number | null;
    bugOnlyAt: number;
    stopAt: number;
    bugLabels: string[];
    utcOffset: string;
    /** Price per model id. Empty when no pricing is configured. */
    pricing: Record<string, ResolvedPricing>;
  };
}

/** The model for an issue: the first route with a matching label, else the default. */
export function modelFor(labels: readonly string[], config: ResolvedAgentConfig): string {
  return config.routes.find((r) => r.labels.some((l) => labels.includes(l)))?.model ?? config.model;
}

/** Every model the config can route to, default first, then the reviewer's. */
export function usedModels(config: Pick<ResolvedAgentConfig, 'model' | 'routes'> & { review?: { model: string | null } }): string[] {
  return [...new Set([config.model, ...config.routes.map((r) => r.model), ...(config.review?.model ? [config.review.model] : [])])];
}

/** Whether an issue gets the independent review. */
export function wantsReview(labels: readonly string[], config: ResolvedAgentConfig): boolean {
  if (config.review.when === 'always') return true;
  if (config.review.when === 'never') return false;
  return labels.some((l) => config.review.labels.includes(l));
}

function isSinglePrice(p: unknown): p is ModelPricing {
  return typeof p === 'object' && p !== null && 'inputPerMTok' in p;
}

export class AgentConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid "agent" config in .factoryrc.json:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
}

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const DEFAULT_GATE_TIMEOUT_MS = 10 * 60 * 1000;

/** Applies defaults and validates. Throws AgentConfigError listing every problem at once. */
export function resolveAgentConfig(raw: AgentConfig | undefined): ResolvedAgentConfig {
  const cfg = raw ?? {};
  const problems: string[] = [];

  if (cfg.runner !== undefined && !(RUNNERS as readonly string[]).includes(cfg.runner)) {
    problems.push(`runner "${String(cfg.runner)}" is not supported; use one of: ${RUNNERS.join(', ')}`);
  }
  if (!cfg.model || typeof cfg.model !== 'string') {
    problems.push('model is required: the default model for issues no route matches');
  }

  const routes = (cfg.routes ?? []).map((r, i) => {
    if (!r || typeof r.model !== 'string' || !r.model) problems.push(`routes[${i}].model is required`);
    if (!r || !Array.isArray(r.labels) || r.labels.length === 0) problems.push(`routes[${i}].labels needs at least one label`);
    return { labels: Array.isArray(r?.labels) ? r.labels : [], model: r?.model ?? '' };
  });

  const gates = (cfg.gates ?? []).map((g, i) => {
    if (!g || typeof g.name !== 'string' || !g.name) problems.push(`gates[${i}].name is required`);
    if (!g || typeof g.run !== 'string' || !g.run) problems.push(`gates[${i}].run is required`);
    return { name: g?.name ?? '', run: g?.run ?? '', timeoutMs: g?.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS };
  });
  if (gates.length === 0) {
    problems.push('gates needs at least one entry, e.g. { "name": "test", "run": "pnpm test" }');
  }
  const names = gates.map((g) => g.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length > 0) problems.push(`gate names must be unique: ${[...new Set(dupes)].join(', ')}`);

  const tddEnabled = cfg.tdd?.enabled ?? true;
  const redGate = cfg.tdd?.redGate ?? 'test';
  if (tddEnabled && gates.length > 0 && !names.includes(redGate)) {
    problems.push(`tdd.redGate "${redGate}" does not match any gate name (${names.join(', ')})`);
  }

  const maxAttempts = cfg.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) problems.push('maxAttempts must be a whole number of 1 or more');

  const b = cfg.budget ?? {};
  const bugOnlyAt = b.bugOnlyAt ?? 0.8;
  const stopAt = b.stopAt ?? 1.0;
  if (b.weeklyUsd !== undefined && !(b.weeklyUsd > 0)) problems.push('budget.weeklyUsd must be greater than 0');
  if (!(bugOnlyAt > 0 && bugOnlyAt <= stopAt)) problems.push('budget.bugOnlyAt must be above 0 and not above budget.stopAt');
  const utcOffset = b.utcOffset ?? '+00:00';
  if (!/^[+-]\d{2}:\d{2}$/.test(utcOffset)) problems.push('budget.utcOffset must look like "+07:00"');
  const planApproval = cfg.plan?.approval ?? 'required';
  if (planApproval !== 'required' && planApproval !== 'none') problems.push('plan.approval must be "required" or "none"');
  if (planApproval === 'required' && !tddEnabled) {
    problems.push('plan.approval "required" needs tdd.enabled: the failing tests are the plan. Set plan.approval to "none" or enable tdd');
  }
  const reviewWhen = cfg.review?.when ?? 'labelled';
  if (!['never', 'labelled', 'always'].includes(reviewWhen)) problems.push('review.when must be "never", "labelled" or "always"');
  const maxFixRounds = cfg.review?.maxFixRounds ?? 1;
  if (maxFixRounds !== 0 && maxFixRounds !== 1) problems.push('review.maxFixRounds must be 0 or 1');
  const reviewModel = cfg.review?.model ?? null;

  const models = usedModels({ model: cfg.model ?? '', routes, review: { model: reviewModel } }).filter(Boolean);
  const pricing: Record<string, ResolvedPricing> = {};
  const resolvePrice = (p: ModelPricing): ResolvedPricing => ({
    inputPerMTok: p.inputPerMTok,
    outputPerMTok: p.outputPerMTok,
    cachedInputPerMTok: p.cachedInputPerMTok ?? p.inputPerMTok,
  });
  if (isSinglePrice(b.pricing)) {
    for (const m of models) pricing[m] = resolvePrice(b.pricing);
  } else if (b.pricing) {
    for (const [m, p] of Object.entries(b.pricing)) pricing[m] = resolvePrice(p);
  }
  if (b.weeklyUsd !== undefined) {
    const unpriced = models.filter((m) => !pricing[m]);
    if (!b.pricing) {
      problems.push('budget.pricing is required when budget.weeklyUsd is set, or the cap cannot be checked');
    } else if (unpriced.length > 0) {
      problems.push(`budget.pricing has no price for: ${unpriced.join(', ')}`);
    }
  }

  const sb = cfg.sandbox;
  if (sb !== undefined) {
    if (!sb || typeof sb.image !== 'string' || !sb.image.trim()) problems.push('sandbox.image is required: a Docker image with the project\'s toolchain');
    if (sb?.env !== undefined && !(Array.isArray(sb.env) && sb.env.every((v) => typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v)))) {
      problems.push('sandbox.env must be a list of environment variable names');
    }
    if (sb?.memory !== undefined && !/^\d+[bkmg]?$/i.test(String(sb.memory))) problems.push('sandbox.memory must look like "4g"');
    if (sb?.cpus !== undefined && !(typeof sb.cpus === 'number' && sb.cpus > 0)) problems.push('sandbox.cpus must be greater than 0');
    if (sb?.agent !== undefined && typeof sb.agent !== 'boolean') problems.push('sandbox.agent must be true or false');
    if (sb?.authVolume !== undefined && !(typeof sb.authVolume === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]+$/.test(sb.authVolume))) {
      problems.push('sandbox.authVolume must be a Docker volume name, e.g. "agentic-loop-agy-auth"');
    }
  }

  const reviewers = { plan: [] as string[], pr: [] as string[] };
  for (const key of ['plan', 'pr'] as const) {
    const list: unknown = cfg.reviewers?.[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || !list.every((l) => typeof l === 'string' && GITHUB_LOGIN.test(l.replace(/^@/, '')))) {
      problems.push(`reviewers.${key} must be a list of GitHub logins, e.g. ["octocat"]`);
      continue;
    }
    reviewers[key] = [...new Set((list as string[]).map((l) => l.replace(/^@/, '')))];
  }

  const ws = cfg.notify?.workspace;
  if (ws !== undefined) {
    if (!ws || typeof ws.channel !== 'string' || !/^[A-Za-z0-9_-]+$/.test(ws.channel)) problems.push('notify.workspace.channel must be a channel id, e.g. "G-6jh00udb"');
    if (ws?.url !== undefined && !/^https:\/\/[^\s/]+$/.test(ws.url)) problems.push('notify.workspace.url must look like "https://workspace.gradion.com"');
    for (const k of ['plan', 'pr'] as const) {
      if (ws?.cc?.[k] !== undefined && typeof ws.cc[k] !== 'string') problems.push(`notify.workspace.cc.${k} must be text`);
    }
  }

  if (problems.length > 0) throw new AgentConfigError(problems);

  const runner: RunnerName = cfg.runner ?? 'antigravity-cli';
  return {
    runner,
    model: cfg.model as string,
    routes,
    labels: {
      ready: cfg.labels?.ready ?? 'agent:ready',
      working: cfg.labels?.working ?? 'agent:working',
      prOpen: cfg.labels?.prOpen ?? 'agent:pr-open',
      needsHuman: cfg.labels?.needsHuman ?? 'agent:needs-human',
      planReview: cfg.labels?.planReview ?? 'agent:plan-review',
      planApproved: cfg.labels?.planApproved ?? 'agent:plan-approved',
    },
    plan: { approval: planApproval },
    review: { when: reviewWhen, labels: cfg.review?.labels ?? ['risky', 'security'], model: reviewModel, maxFixRounds },
    context: cfg.context ?? ['AGENTS.md'],
    gates,
    tdd: { enabled: tddEnabled, redGate, testFiles: cfg.tdd?.testFiles ?? DEFAULT_TEST_FILES },
    protectedPaths: [...new Set([...ALWAYS_PROTECTED, ...(cfg.protectedPaths ?? [])])],
    maxAttempts,
    sessionTimeoutMs: cfg.sessionTimeoutMs ?? 30 * 60 * 1000,
    branchPrefix: cfg.branchPrefix ?? 'agent/',
    setup: cfg.setup ?? null,
    ledgerBranch: cfg.ledgerBranch ?? 'factory-ledger',
    sandbox: sb
      ? { image: sb.image, env: sb.env ?? [], gateNetwork: sb.gateNetwork ?? false, memory: sb.memory ?? null, cpus: sb.cpus ?? null, agent: sb.agent ?? false, authVolume: sb.authVolume ?? VENDORS[runner]!.sandbox.defaultAuthVolume }
      : null,
    reviewers,
    notify: {
      workspace: ws ? { url: ws.url ?? 'https://workspace.gradion.com', channel: ws.channel, cc: { plan: ws.cc?.plan ?? '', pr: ws.cc?.pr ?? '' } } : null,
    },
    budget: {
      weeklyUsd: b.weeklyUsd ?? null,
      bugOnlyAt,
      stopAt,
      bugLabels: b.bugLabels ?? ['bug'],
      utcOffset,
      pricing,
    },
  };
}
