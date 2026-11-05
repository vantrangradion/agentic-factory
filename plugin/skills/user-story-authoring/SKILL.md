---
name: user-story-authoring
description: Procedures and verification rules for decomposing product specifications into sprint-aligned epics, atomic user stories with BDD acceptance criteria, and maintaining clean backlog documentation.
---

# User Story Authoring & Backlog Management

Use this skill whenever translating product specifications (such as `docs/spec.md`) into agile user stories, defining acceptance criteria, structuring epics across delivery sprints, or auditing backlog consistency.

---

## 1. Core Principles: Traceability & Persona Grounding

A production-grade user story catalog must bridge high-level product specifications and low-level code implementation without ambiguity.

1. **Strict Spec Traceability:**
   - Every user story must explicitly map back to feature codes in the spec (e.g., `C-1`..`C-9`, `S-1`..`S-3`, `K-0`..`K-5`, `I-1`..`I-5`, `R-1`..`R-2`, `L-1`).
   - Group stories under sprint-aligned Epics to establish clear milestone delivery boundaries.

2. **Persona Grounding:**
   Every story must be authored from the perspective of an authentic project persona:
   - **Charlotte (Primary Persona — Non-Technical Sales Rep):** Focuses on friction-free onboarding, zero technical jargon, background performance preservation (<2% CPU, <250 MB RAM), and peace-of-mind privacy controls.
   - **Marcus (Secondary Persona — Operations Lead & Technical Power User):** Focuses on multi-destination pipeline integrity (Google Sheets, SQLite, webhooks, MCP), schema stability, and fault isolation between sinks.
   - **Dylan (Internal Persona — Software Engineer / Intern):** Focuses on strict Test-Driven Development (TDD), CLI feature parity with `--json` outputs, and deterministic testing harnesses (fake fixtures, local mock servers).

---

## 2. Sprint-Aligned Epic Hierarchy

To eliminate tracking friction and prevent cross-sprint epic fragmentation:
- **1:1 Epic-to-Sprint Alignment:** Every Epic belongs to exactly **one** delivery sprint. Epics must never span multiple sprints.
- **Naming Convention:** `## Epic <Number>: <Descriptive Name> (Sprint <Number>)`
- **Milestone Grouping:**
  - **Sprint 1 (Core Pipeline & Live Joint Demo):** Foundational harnesses, core engine pipeline, encrypted outbox, and Margince signed push delivery.
  - **Sprint 2 (Usability, Polish & Sinks):** Guided setup wizard, multi-destination fan-out sinks, history backfill, and system telemetry.
  - **Sprint 3 (Post-Acceptance Extensions):** High-value "Should" scope including human-in-the-loop CRM replies, bilingual UI, and local MCP server.

---

## 3. Backlog Structure & Two-Tier Layout

Maintain a clean, non-competing two-tier structure in `docs/user-stories.md`:

```
[ Executive Summary & Personas ]
       │
[ Mermaid Sprint & Milestone Flowchart ]
       │
[ Tier 1: High-Level Epic Architecture Table ] (Scope, Features, Milestones)
       │
[ Tier 2: Sprint Execution Backlogs ] (Grouped by Sprint, Story IDs, Priority, Dependencies)
       │
[ Detailed Story Sections by Epic ] (Persona, Given/When/Then BDD Acceptance Criteria)
       │
[ Global Definition of Done (DoD) ]
```

### Table Standards:
1. **Tier 1 (Epic Architecture):** Columns: `Epic`, `Features`, `Scope`, `Target Sprint`, `Milestone & Core Deliverable`.
2. **Tier 2 (Sprint Execution Backlog):** Columns: `User Story ID`, `Epic`, `Feature`, `Title`, `Priority`, `Immediate Dependencies`. Grouped under markdown headers by sprint (`#### Sprint 1 — ...`).

---

## 4. User Story Specification Standard

Every user story section must follow this exact structure:

```markdown
### US-<FeatureCode>-<Seq>: <Action-Oriented Story Title>
* **Feature ID:** `<Feature>` | **Priority:** Must | Should
* **User Persona:** Charlotte (Sales Rep) | Marcus (Ops Lead) | Dylan (Software Engineer)
* **Dependencies:** None (Foundational) | `US-...`
* **User Story:**
  > As a <persona>,  
  > I want <capability>,  
  > So that <business benefit>.
* **Acceptance Criteria:**
  - **Scenario 1: <Descriptive Scenario Name>**
    - **Given** <precondition>,
    - **When** <trigger or user action>,
    - **Then** <expected outcome>,
    - **And** <additional verification>.
```

### Acceptance Criteria Rules:
- **Pure BDD Syntax:** Every scenario must contain explicit `**Given**` (optional if stateless), `**When**`, and `**Then**` clauses.
- **Both Paths:** Always specify both the happy path and critical edge cases (e.g., rate-limiting backoff, expired sessions, oversized payloads, network timeouts).
- **Plain Language & Zero Jargon:** Charlotte-facing scenarios must use plain English and never expose developer terms (*"sink"*, *"outbox"*, *"JID"*, *"regex"*).

---

## 5. Repository Markdown & Diagramming Hygiene

To ensure documents render cleanly across GitHub, IDE previews, and CI runners:

1. **Relative Links Only (Zero Local Path Leaks):**
   - **NEVER** use local absolute paths (`file:///Users/...`) in repository markdown files.
   - Always use repository-relative links: e.g., `[`docs/spec.md`](spec.md)` or `[`AGENTS.md`](../.agents/rules/AGENTS.md)`.
2. **Mermaid Subgraph Container Guards:**
   - **Concise Subgraph Titles:** Use simple container titles like `subgraph S1["Sprint 1"]` rather than multi-clause descriptions to avoid container label overflow.
   - **Direction:** Always specify `direction TB` inside subgraphs.
   - **Container-to-Container Milestone Edges:** Connect milestone dependencies between subgraph containers (`S1 ==>|Milestone 1 Demo Passed| S2`), not across inner nodes in different subgraphs (which triggers Mermaid/Dagre bounding box collision bugs).

---

## 6. Global Definition of Done (DoD)

Every story must pass the 6-point DoD checklist before release sign-off:
1. **Functional & BDD Scenarios:** Passes all story-specific BDD acceptance criteria with automated red-to-green test coverage (TDD per `AGENTS.md`).
2. **CLI Parity (Dylan):** Corresponding headless CLI commands pass with `--json` output support and standard exit codes (`0` success, `1` user error, `2` fatal) per Spec §7.
3. **Plain-Language & Zero Jargon:** UI screens, labels, and dialogs pass the CI AST/DOM text linter with zero forbidden developer terms (*"sink"*, *"outbox"*, *"JID"*, *"regex"*) per `AGENTS.md`.
4. **Actionable Error Feedback:** All user-facing error messages clearly describe what happened and state the exact next click or action to resolve it.
5. **Performance & Resource Budgets:** Passes cold startup (<5.0 s), idle memory (<250 MB RSS), idle CPU (<2%), and 500-message backfill (<5.0 s/msg, <400 MB peak) budgets defined in `docs/spec.md` §11.
6. **Privacy & Security Integrity:** Zero plaintext credentials, zero customer PII in fixtures/logs, encrypted storage at rest (AES-GCM/SQLCipher), strictly localhost binding (`127.0.0.1`), and unticked conversations are dropped before entering outbound queues.

---

## 7. Automated Backlog Verification

Run the automated verification script to audit any backlog document:

```bash
python3 .agents/skills/user-story-authoring/scripts/verify_backlog.py docs/user-stories.md
```

The script automatically verifies:
- Zero local absolute file paths (`file://` or `/Users/`).
- 100% of user stories have dependencies, user personas, and Given/When/Then BDD acceptance criteria.
- 1:1 parity between high-level matrix tables and detailed story blocks.
- 100% sprint-aligned Epics without cross-sprint fragmentation.

