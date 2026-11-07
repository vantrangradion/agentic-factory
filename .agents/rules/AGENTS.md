# Agentic Factory: Project Rules & Engineering Guidelines

This document defines the development rules, architectural contracts, and delivery standards for the **Agentic Factory** framework repository.

---

## 1. Context Window & Conversation Hygiene

To keep the agent context window lean and fast:
* **No Raw Dumps:** Never output large raw test streams, multi-thousand-line archives, or bulky logs into the chat context.
* **Filter & Paginate:** Pipe test outputs or JSON inspection through `head`, `tail`, or `jq` before reporting back.
* **Subagent Delegation:** Delegate deep exploratory tasks or long-running checks to subagents to isolate noise from the main conversation.
* **Periodic Compaction:** Recommend the `/compact` command after completing major feature milestones.

---

## 2. Core Architecture & Monorepo Contracts

* **Workspace Packages:**
  - `@agentic-factory/guards`: Language-agnostic guardrail engine with per-language adapters (`packages/guards/src/languages`).
  - `@agentic-factory/harness`: Synthetic test doubles, virtual clocks, and contract runners (`packages/harness`).
  - `create-agentic-factory`: CLI scaffolder for generating modular monorepos (`packages/create-agentic-factory`).
* **Deterministic AST Boundaries:** All package and layer boundaries are enforced via `pnpm guard`.
* **Zero External Native Dependencies:** Guards and harness utilities must remain lightweight, fast, and cross-platform.

---

## 3. Engineering Quality Rules & Guards

* **Test-Driven Development (TDD):**
  - Always write the unit/integration test first (`Red`), verify it fails, then implement the minimal code to pass (`Green`).
  - All features and bug fixes must prove a red run followed by a green run.
* **Code Hygiene & Guards:**
  - Zero import cycles (`pnpm guard`).
  - Zero dead code or unused exports.
  - No commented-out code.
  - No `TODO` comments without an associated issue tracker link.
  - Zero icons, emojis, or em dashes in CLI output, UI text, code comments, documentation, and agent communication.
* **Automated PR & Review Workflow:**
  - When assigned a task or user story, the agent executes the complete 7-step lifecycle autonomously (Accept -> Plan -> Red -> Green -> Guard -> Adversarial Audit -> Ready for Review).
  - Publishes the plan in a draft PR (`gh pr create --draft`) before writing code, then continues without waiting.
  - Before marking the PR ready (`gh pr ready`), the PR description must include Red-to-Green test logs, guard passes, the adversarial audit summary, and deviations from the plan.
  - Commit messages are one conventional-commit subject line (`feat(scope): ...`) with no body; details belong in the PR description.
* **Story Batching and Milestone Execution:**
  - When assigned a multi-story batch or sprint milestone, execute stories sequentially in topological dependency order.
  - Never bundle multiple stories into a single monolithic PR; each story must deliver an isolated feature branch and dedicated PR.
  - If a story hits a non-automatable human gate (such as physical device login or QR code scanning), pause and notify the developer.
  - Recommend `/compact` between major milestones to maintain conversation hygiene.

