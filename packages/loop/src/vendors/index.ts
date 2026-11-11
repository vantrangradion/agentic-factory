import type { AgentVendor } from '../vendor.js';
import { antigravity } from './antigravity.js';
import { claudeCode } from './claude-code.js';

/** Every agent CLI the loop can drive, by its `runner` id. Add a vendor here and in RUNNERS. */
export const VENDORS: Record<string, AgentVendor> = {
  [antigravity.id]: antigravity,
  [claudeCode.id]: claudeCode,
};

export function vendorFor(runner: string): AgentVendor {
  const v = VENDORS[runner];
  if (!v) throw new Error(`Unknown runner "${runner}"; use one of: ${Object.keys(VENDORS).join(', ')}`);
  return v;
}

export { antigravity, claudeCode };
