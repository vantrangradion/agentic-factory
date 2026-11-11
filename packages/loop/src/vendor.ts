import type { TraceState } from './trace-format.js';
import type { ParsedSession } from './usage.js';

/**
 * Everything the loop needs to know about one agent CLI. The loop itself is
 * vendor-agnostic: it sends a prompt, lets the agent edit files, and then
 * decides what is kept. A vendor only says how to start a headless session,
 * how to read its trace, and how to sign it in inside the agent container.
 */
export interface AgentVendor {
  /** The `runner` value in .factoryrc.json. */
  readonly id: string;
  /** Name for people, e.g. "agy" or "Claude Code". */
  readonly label: string;
  /** The CLI program. */
  readonly binary: string;
  /**
   * Arguments for one headless session with every tool permission
   * auto-approved and one JSON event per line on stdout.
   */
  args(promptArg: string, model: string, seconds: number): string[];
  /**
   * True when `args` makes the CLI stop itself at `seconds`. Otherwise the
   * loop kills the session at its time limit.
   */
  readonly enforcesTimeout: boolean;
  /** Reads a finished (or cut-off) session trace. */
  parse(ndjson: string): ParsedSession;
  /** An error for a vendor-specific exit code, or undefined to use the generic message. */
  exitError?(status: number, seconds: number, stderrTail: string): string | undefined;
  /** One trace line for people to read; null when the line is not this vendor's or not worth showing. */
  formatTraceEvent(line: string, state: TraceState): string | null;
  /** True for the line that ends a session. */
  isEndEvent(line: string): boolean;
  readonly sandbox: VendorSandbox;
}

/** How the agent signs in inside its container. The login lives in one file on a Docker volume. */
export interface VendorSandbox {
  /** File name in the login volume. */
  readonly authFile: string;
  /** Docker volume used when `sandbox.authVolume` is not set. */
  readonly defaultAuthVolume: string;
  /**
   * Shell lines run at container start, before the agent, that make the login
   * at `${authPath}` usable (copy it into $HOME, or export it as a variable).
   */
  useLogin(authPath: string): string[];
  /**
   * Shell lines for `agentic-loop login`, run in an interactive container with
   * network, that sign in and write the login to `${authPath}`.
   */
  signIn(authPath: string): string[];
  /** What `agentic-loop login` tells the person before signing in. */
  readonly signInHint: string;
  /** How to add the CLI to the image, shown when it is missing. */
  readonly installHint: string;
}
