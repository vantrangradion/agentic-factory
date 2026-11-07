/**
 * Built-in presets referenced from `.factoryrc.json` via `"extends"`.
 * `recommended` is style-neutral and safe for any project. House-style
 * rules live in opt-in presets so no project inherits another's taste.
 */
/** Shape matches FactoryConfig; kept untyped here so config.ts can import it without a cycle. */
export type PresetConfig = Record<string, unknown>;

export const BUILTIN_PRESETS: Record<string, PresetConfig> = {
  'agentic-factory/recommended': {
    guards: {
      noCycles: { enabled: true },
      secrets: { enabled: true },
      todoIssueLinks: { enabled: true },
      commentedCode: { enabled: true },
      deadExports: { enabled: true },
    },
  },
  'agentic-factory/plain-ux': {
    guards: {
      plainLanguage: {
        enabled: true,
        forbiddenTerms: ['internal_id', 'mutex_lock', 'deadlock', 'ast_node', 'llm_hallucination'],
        disallowEmDashes: true,
        disallowEmojis: true,
      },
    },
  },
};

export const PRESET_NAMES = Object.keys(BUILTIN_PRESETS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep-merges objects; arrays and scalars in `override` replace `base`. */
export function deepMerge<T>(base: T, override: T): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : override) as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in out ? deepMerge(out[key], value) : value;
  }
  return out as T;
}
