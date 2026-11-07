# {{PROJECT_NAME}}: Factory Model & Harness Engineering Setup Checklist

**Milestone:** Sprint 0 / Foundation Setup  
**Core Law:** $\mathbf{Agent = Model + Harness}$

---

## The 5 Scaffolding Phases

```mermaid
flowchart TD
    P1["Phase 1: Workspace Topology & Types"] --> P2["Phase 2: Deterministic Guardrails (AST)"]
    P2 --> P3["Phase 3: Synthetic Testing Harness"]
    P3 --> P4["Phase 4: Contract Runners & Test Doubles"]
    P4 --> P5["Phase 5: Factory Verification Run"]
```

### Phase 1: Workspace Topology & Types
- [ ] Root `pnpm-workspace.yaml` and `tsconfig.base.json` configured.
- [ ] `packages/types` defined with zero runtime dependencies.
- [ ] TypeScript project references wired with `composite: true`.

### Phase 2: Deterministic Guardrails & Linters
- [ ] `.factoryrc.json` configured with architectural boundaries.
- [ ] `pnpm guard` passes: zero circular dependencies, zero secret leaks.
- [ ] Plain-language UX linter checks user-facing surfaces.

### Phase 3: Synthetic Testing Harness
- [ ] `ScenarioBuilder` with seeded PRNG initialized in `packages/testing`.
- [ ] Virtual clock (`MockClock`) implemented for time-dependent operations.
- [ ] Zero production customer data or PII used in fixtures.

### Phase 4: Parameterized Contract Runners
- [ ] Reusable contract test suites defined for external ports/adapters.
- [ ] Mock servers configured for third-party HTTP/WebSocket dependencies.

### Phase 5: Self-Verification
- [ ] Run full pipeline: `pnpm clean && pnpm build && pnpm guard && pnpm test`.
- [ ] Total execution under 2 seconds. Ready for autonomous story implementation.

---

## Operational Runbook: The 7-Step Story Lifecycle

When picking up a user story from `docs/user-stories.md`:

```mermaid
flowchart TD
    Dev["Developer (Orchestrator)"] -->|Assigns Story| Step1["1. Accept (Definition of Ready)"]
    Step1 --> Step2["2. Plan in Draft PR"]
    Step2 --> Step3["3. Red Phase (Test First)"]
    Step3 --> Step4["4. Green Phase (Self-Healing Code)"]
    Step4 --> Step5["5. Guard Phase (pnpm guard)"]
    Step5 --> Step6["6. Adversarial Audit (Decoupled Review)"]
    Step6 --> Step7["7. Ready for Review"]
    Step7 --> DevSignOff["Developer: Review and Merge"]
    Step2 -.->|Async plan review| DevPlan["Developer: Request Changes on Plan"]
```

### The 7 Steps:
1. **Accept (Definition of Ready):** Load BDD criteria, ADRs, and boundary rules. Confirm every criterion is testable, dependencies are merged or are the base branch, and no human gate remains. Otherwise report what is missing and do not start.
2. **Plan in a Draft PR:** Push a plan commit and open a draft PR whose body starts with `## Plan` (affected files, interfaces, test scenarios, edge cases, risks). Continue without waiting.
3. **Red Phase (Test First):** Write tests with synthetic doubles; verify failure (`Red`).
4. **Green Phase & Feedback Loop:** Write minimal production code; autonomously diagnose and patch test failures until passing (`Green`).
5. **Deterministic Guardrails:** Execute `pnpm guard` to enforce zero circular dependencies, boundary isolation, and secret scanning.
6. **Adversarial Audit:** The decoupled `AdversarialReviewer` audits the diff against BDD acceptance criteria, ADR compliance, the plan, and edge-case failure paths.
7. **Ready for Review:** Add test logs, guard results, the audit report, and `## Deviations from Plan` to the PR, then mark it ready. The backlog checkbox is ticked only after merge.

---

## Responsibility Matrix: Automation vs. Human Control

| Lifecycle Phase | Autonomous (Agent & Harness) | Human Control (Developer) |
| :--- | :--- | :--- |
| **Story Selection** | None | Selects target story from backlog based on priority |
| **Accept** | Checks the Definition of Ready and reports gaps | Assigns stories and resolves open questions |
| **Plan (Draft PR)** | Publishes the plan in a draft PR and continues | Requests changes on the draft if the plan is wrong |
| **Test Authoring (Red)** | Generates Vitest assertions from Gherkin specifications | Reviews test strategy if architecture changes |
| **Implementation (Green)**| Writes minimal production code | Steers trade-offs if multiple paths exist |
| **Self-Healing** | Parses error traces, diagnoses bugs, and iterates code | Steps in only if an external spec flaw is discovered |
| **Quality Gates** | Runs AST linters, cycle detectors, and boundary guards | Configures project tolerances in .factoryrc.json |
| **Adversarial Audit** | Evaluates diff against edge cases and acceptance criteria | Validates audit findings and assesses business risk |
| **Final Sign-Off** | Marks the PR ready with logs, audit, and plan deviations | Reviews, approves, and merges; backlog is ticked after merge |

