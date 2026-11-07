# Agentic Factory: Universal Agent Rules & Core Invariants

These invariants govern all agentic software development across any project using the Factory Model:

1. **The Core Formula:** Agent = Model + Harness. Always invest in the harness (CapEx) before feature coding (OpEx).
2. **Deterministic Verification over Vibes:** Never rely on model memory or LLM self-assessment. Every change must be verified via automated unit/contract tests and deterministic AST guardrails (`pnpm guard`). Skills and subagents refer to "the project's guards" generically and never assume a language, framework, or house style; project-specific rules belong in `.factoryrc.json`.
3. **Test-Driven Development (TDD):** Red run (verified failing test) -> Green run (minimal passing implementation) -> Guard verification.
4. **Privacy & Security by Design:** Never request, store, or log real customer PII, phone numbers, or credentials. Use synthetic generators (`@agentic-factory/harness`).
5. **No Architectural Bypass:** Never bypass package boundaries or introduce circular dependencies.
6. **No Icons, Emojis, or Em Dashes:** Never output emojis, icons, or em dashes in CLI outputs, UI text, logs, code comments, documentation, or user communication. Use standard Unix conventions (PASS, FAIL, WARN) and clean punctuation (hyphens or colons).
7. **Autonomous Delivery & Automated PR Flow:** When assigned a task or user story, the agent executes the 7-step lifecycle autonomously (Accept -> Plan -> Red -> Green -> Guard -> Adversarial Audit -> Ready for Review; see the `factory-harness` skill). Accepting checks the Definition of Ready; a story that fails it is reported, not started. The plan is published as a draft PR (`gh pr create --draft`) before any code, and work continues without waiting; reviewers reject a plan by requesting changes on the draft. When done, the agent adds Red/Green test logs, guard passes, the audit summary, and any deviations from the plan, then marks the PR ready (`gh pr ready`) for developer sign-off. **Commit messages:** one conventional-commit subject line (`feat(scope): ...`), no body, unless the project's rules say otherwise; details belong in the PR description.
8. **Story Batching and Milestone Execution:**
   - **Topological Ordering:** When assigned a multi-story batch or milestone, analyze the dependency graph and execute stories sequentially in strict topological order (foundations before dependents).
   - **Atomic PR per Story:** Never bundle multiple user stories into a single monolithic PR. Each story must independently complete the 7-step lifecycle, with its own dedicated feature branch and pull request.
   - **Autonomous Progression:** After opening the PR for story N, automatically branch for story N+1 from the prior verified state and continue execution without waiting unless blocked.
   - **State from Source of Truth:** When resuming a batch, before starting each new story, or when asked for status, run the `milestone-watchdog` skill. Rebuild batch state from git and GitHub, never from memory. A rejected plan or failing CI on story N is handled before story N+1 continues.
   - **Human Gate Detection:** If a story hits a non-automatable gate (such as physical mobile phone QR scanning or 2FA credentials), pause and report to the developer instead of mocking or bypassing real user authentication.
   - **Context Compaction:** For long-running batches, use subagents for heavy checks and recommend `/compact` between epic milestones.

