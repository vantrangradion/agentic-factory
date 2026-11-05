---
name: factory-harness
description: Harness engineering procedures for constructing the CapEx foundation (workspace topology, AST guardrails, synthetic testing frameworks, contract runners, and mock servers) before product code implementation.
---

# Factory Model & Harness Engineering Skill

Use this skill whenever setting up a new repository foundation, scaffolding monorepo packages, building deterministic AST guardrails, constructing synthetic testing harnesses, or preparing the testing environment for autonomous agent implementation.

---

## 1. The 5 Harness Scaffolding Phases

```mermaid
flowchart TD
    P1["Phase 1: Workspace Topology & Types"] --> P2["Phase 2: Deterministic Guardrails (AST)"]
    P2 --> P3["Phase 3: Synthetic Testing Harness"]
    P3 --> P4["Phase 4: Contract Runners & Mocks"]
    P4 --> P5["Phase 5: Factory Verification"]
```

### Phase 1: Workspace Topology & Shared Types
* Define workspace topology (e.g. `pnpm-workspace.yaml`).
* Configure TypeScript project references with `composite: true` for sub-second incremental compilation.
* Centralize domain contracts and event interfaces in `packages/types` before implementing any feature package.

### Phase 2: Deterministic Guardrails & AST Linters
* Never rely solely on LLM prompt obedience for hard architectural rules. Enforce via deterministic AST scripts:
  * **Zero Circular Dependencies:** Run `agentic-guards cycles`.
  * **Strict Boundary Isolation:** Run `agentic-guards boundaries`.
  * **Plain Language UX Linter:** Run `agentic-guards jargon`.
  * **Secret & PII Scanner:** Run `agentic-guards secrets`.

### Phase 3: Synthetic Testing Harness
* Implement scenario builders with seeded PRNG (`ScenarioBuilder`) and virtual clocks (`MockClock`).
* **Privacy Boundary:** Never use real customer data or credentials in fixtures. Generate synthetic streams.

### Phase 4: Parameterized Contract Runners & Mock Servers
* Build reusable contract test suites (`executeContractSuite`) executed against any adapter implementation.
* Build local mock servers for third-party HTTP/WebSocket APIs.

### Phase 5: Factory Self-Verification Run
Execute the complete verification pipeline before writing any production feature code:
```bash
pnpm clean && pnpm build && pnpm guard && pnpm test
```
All packages must compile with zero warnings, all guards pass, and test suite completes in under 2 seconds.

---

## 2. Operational Story Execution Runbook

Once the factory floor is verified, execute user stories using the **6-Step Orchestrator <-> Agent Lifecycle**:

1. **Story Trigger, Context Loading & Implementation Plan:**
   - Developer specifies target user story.
   - Agent loads BDD scenarios, ADRs, and boundary rules.
   - Agent outlines an implementation plan (affected files, interfaces, synthetic test scenarios, edge cases) before modifying code.
2. **Red Phase (Test First):**
   - Agent authors unit or contract tests matching Gherkin acceptance criteria.
   - Runs tests and confirms expected failure (`Red`) using synthetic data.
3. **Green Phase & Autonomous Feedback Loop:**
   - Agent implements minimal production code.
   - If tests or compiler fail, agent autonomously diagnoses error traces and iterates to `Green`.
4. **Deterministic Guard Verification:**
   - Agent runs `pnpm guard` to enforce AST cycle limits, package boundaries, UX language rules, and secret scanning.
5. **Adversarial Audit & Trajectory Review:**
   - The decoupled `AdversarialReviewer` agent audits the git diff against acceptance criteria, ADR compliance, and the 20% edge cases (unhandled errors, rate limits, resource cleanup).
6. **Definition of Done & Human Sign-Off:**
   - Agent marks story completed in backlog.
   - Agent presents clean diff and adversarial audit report for human developer approval.

