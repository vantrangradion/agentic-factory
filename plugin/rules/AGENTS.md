# Agentic Factory: Universal Agent Rules & Core Invariants

These invariants govern all agentic software development across any project using the Factory Model:

1. **The Core Formula:** Agent = Model + Harness. Always invest in the harness (CapEx) before feature coding (OpEx).
2. **Deterministic Verification over Vibes:** Never rely on model memory or LLM self-assessment. Every change must be verified via automated unit/contract tests and deterministic AST guardrails (`pnpm guard`). Skills and subagents refer to "the project's guards" generically and never assume a language, framework, or house style; project-specific rules belong in `.factoryrc.json`.
3. **Test-Driven Development (TDD):** Red run (verified failing test) -> Green run (minimal passing implementation) -> Guard verification.
4. **Privacy & Security by Design:** Never request, store, or log real customer PII, phone numbers, or credentials. Use synthetic generators (`@agentic-factory/harness`).
5. **No Architectural Bypass:** Never bypass package boundaries or introduce circular dependencies.
6. **No Icons, Emojis, or Em Dashes:** Never output emojis, icons, or em dashes in CLI outputs, UI text, logs, code comments, documentation, or user communication. Use standard Unix conventions (PASS, FAIL, WARN) and clean punctuation (hyphens or colons).
7. **Autonomous Delivery & Automated PR Flow:** When assigned a task or user story, the agent executes the complete cycle autonomously (Red -> Green -> Guard -> Adversarial Audit). It creates a dedicated feature branch, pushes to the remote, and opens a Pull Request via GitHub CLI (`gh pr create`) containing verified Red/Green test logs, guard passes, and audit summary for developer review and sign-off.
8. **Story Batching and Milestone Execution:**
   - **Topological Ordering:** When assigned a multi-story batch or milestone, analyze the dependency graph and execute stories sequentially in strict topological order (foundations before dependents).
   - **Atomic PR per Story:** Never bundle multiple user stories into a single monolithic PR. Each story must independently complete the 6-step lifecycle (Red -> Green -> Guard -> Audit), with its own dedicated feature branch and pull request opened via GitHub CLI (`gh pr create`).
   - **Autonomous Progression:** After opening the PR for story N, automatically branch for story N+1 from the prior verified state and continue execution without waiting unless blocked.
   - **Human Gate Detection:** If a story hits a non-automatable gate (such as physical mobile phone QR scanning or 2FA credentials), pause and report to the developer instead of mocking or bypassing real user authentication.
   - **Context Compaction:** For long-running batches, use subagents for heavy checks and recommend `/compact` between epic milestones.

