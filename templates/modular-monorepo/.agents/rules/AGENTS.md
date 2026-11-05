# Factory Model: Agent Guidelines & Project Rules

This document defines the development rules, architectural contracts, and context hygiene standards for this project.

---

## 1. Context Window & Conversation Hygiene

To keep the agent's context window lean and fast:
* **No Raw Dumps:** Never output large raw test streams, multi-thousand-line archives, or bulky database queries into the chat context.
* **Filter & Paginate:** Pipe test outputs, logs, or JSON inspection through `head`, `tail`, or `jq` before reporting back.
* **Subagent Delegation:** Delegate deep exploratory tasks to subagents to isolate noise from the main conversation.
* **Periodic Compaction:** Recommend the `/compact` command after completing major feature milestones.

---

## 2. Core Architecture & Plug-in Contracts

* **Domain Contract Isolation:** Core domain types live in `packages/types` with zero runtime dependencies.
* **Ports & Adapters / Dependency Inversion:** Concrete adapters implement domain contracts; domain logic never imports adapters.
* **Deterministic AST Boundaries:** All architectural boundaries are verified by `pnpm guard` (`agentic-guards`). Never bypass boundaries.

---

## 3. Engineering Quality Rules & Guards

* **Test-Driven Development (TDD):**
  - Always write the unit/integration test first (`Red`), verify it fails, then implement the minimal code to pass (`Green`).
  - Feature changes must prove a red run followed by a green run.
* **Strict Privacy & Security:**
  - The AI agent **NEVER** holds production credentials, session tokens, or passwords.
  - The AI agent develops and tests **exclusively** against synthetic fixtures and local mock servers.
  - No real customer data, phone numbers, real names, or customer PII in test fixtures or logs.
* **Code Hygiene & Guards:**
  - Zero import cycles (`pnpm guard`).
  - Zero dead code or unused exports.
  - No commented-out code.
  - No `TODO` comments without an associated issue tracker link.
  - Zero icons, emojis, or em dashes in CLI output, UI text, code comments, documentation, and agent communication.
* **User-Facing Plain Language (UX Guard):**
  - Never expose internal system jargon or database errors to end users.
  - Plain language guard will fail the build if prohibited terms appear in user-facing surfaces.
* **Automated PR & Review Workflow:**
  - When assigned a task or user story, the agent executes the complete 6-step lifecycle autonomously (Red -> Green -> Guard -> Adversarial Audit).
  - Creates a dedicated feature branch, pushes to the remote, and opens a Pull Request via GitHub CLI (`gh pr create`).
  - PR descriptions must include full Red-to-Green test logs, guard passes, and adversarial audit summaries for developer sign-off.
* **Story Batching and Milestone Execution:**
  - When assigned a multi-story batch or sprint milestone, execute stories sequentially in topological dependency order.
  - Never bundle multiple stories into a single monolithic PR; each story must deliver an isolated feature branch and dedicated PR.
  - If a story hits a non-automatable human gate (such as physical device login or QR code scanning), pause and notify the developer.
  - Recommend `/compact` between major milestones to maintain conversation hygiene.

