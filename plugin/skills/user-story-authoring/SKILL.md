---
name: user-story-authoring
description: Procedures and verification rules for decomposing product specifications into sprint-aligned epics, atomic user stories with BDD acceptance criteria, and maintaining clean backlog documentation.
---

# User Story Authoring & Backlog Management

Use this skill whenever translating product specifications (such as `docs/spec.md`) into agile user stories, defining acceptance criteria, structuring epics across delivery sprints, or auditing backlog consistency.

This skill defines the method. Everything project-specific (personas, feature codes, sprint themes, forbidden terms, budgets) comes from the project's own documents. Never invent it and never carry it over from another project.

---

## 0. Load Project Context First

Before writing or auditing any story, read:
- **The spec** (e.g. `docs/spec.md`): feature codes, personas, non-functional budgets.
- **The project rules** (`.agents/rules/AGENTS.md`): project-specific Definition of Done items.
- **The guard config** (`.factoryrc.json`): `guards.plainLanguage.forbiddenTerms` is the jargon list user-facing scenarios must avoid.

If the spec defines no personas or feature codes, stop and ask for them; do not make them up.

---

## 1. Core Principles: Traceability & Persona Grounding

A production-grade user story catalog must bridge high-level product specifications and low-level code implementation without ambiguity.

1. **Strict Spec Traceability:**
   - Every user story must explicitly map back to a feature code defined in the spec (for example `C-1`, `S-2`, `K-0`).
   - Group stories under sprint-aligned Epics to establish clear milestone delivery boundaries.

2. **Persona Grounding:**
   - Every story is written from the perspective of a persona defined in the spec, never a generic "user".
   - Each persona's stated priorities (for example zero jargon for non-technical users, CLI parity for engineers) become acceptance criteria, not just context.
   - Include an internal engineering persona when the spec has one, so developer-facing capabilities (CLI, test harnesses) get stories too.

---

## 2. Sprint-Aligned Epic Hierarchy

To eliminate tracking friction and prevent cross-sprint epic fragmentation:
- **1:1 Epic-to-Sprint Alignment:** Every Epic belongs to exactly **one** delivery sprint. Epics must never span multiple sprints.
- **Naming Convention:** `## Epic <Number>: <Descriptive Name> (Sprint <Number>)`
- **Milestone Grouping:** Each sprint ends in a demonstrable milestone. A common shape:
  - **Early sprint:** foundational harnesses and the thinnest end-to-end path, ending in a live demo.
  - **Middle sprint:** usability, setup flows, and breadth of integrations.
  - **Late sprint:** post-acceptance "Should" scope.

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
2. **Tier 2 (Sprint Execution Backlog):** Columns: `User Story ID`, `Epic`, `Feature`, `Title`, `Priority`, `Immediate Dependencies`. Grouped under markdown headers by sprint (`#### Sprint 1: ...`).

---

## 4. User Story Specification Standard

Every user story section must follow this exact structure:

```markdown
### US-<FeatureCode>-<Seq>: <Action-Oriented Story Title>
* **Feature ID:** `<Feature>` | **Priority:** Must | Should
* **User Persona:** <Persona name from the spec> (<role>)
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
- **Plain Language & Zero Jargon:** Scenarios for non-technical personas use plain language and never contain any term from the project's `forbiddenTerms` list.

---

## 5. Repository Markdown & Diagramming Hygiene

To ensure documents render cleanly across GitHub, IDE previews, and CI runners:

1. **Relative Links Only (Zero Local Path Leaks):**
   - **NEVER** use local absolute paths (`file:///...`, `/Users/...`, `/home/...`, `C:\Users\...`) in repository markdown files.
   - Always use repository-relative links: e.g., `[`docs/spec.md`](spec.md)` or `[`AGENTS.md`](../.agents/rules/AGENTS.md)`.
2. **Mermaid Subgraph Container Guards:**
   - **Concise Subgraph Titles:** Use simple container titles like `subgraph S1["Sprint 1"]` rather than multi-clause descriptions to avoid container label overflow.
   - **Direction:** Always specify `direction TB` inside subgraphs.
   - **Container-to-Container Milestone Edges:** Connect milestone dependencies between subgraph containers (`S1 ==>|Milestone 1 Demo Passed| S2`), not across inner nodes in different subgraphs (which triggers Mermaid/Dagre bounding box collision bugs).

---

## 6. Global Definition of Done (DoD)

Every story must pass these universal checks, plus any project-specific items in `.agents/rules/AGENTS.md` or the spec:
1. **Functional & BDD Scenarios:** Passes all story-specific BDD acceptance criteria with automated red-to-green test coverage (TDD per `AGENTS.md`).
2. **Deterministic Guards:** The project's guards pass, including plain-language rules on user-facing surfaces.
3. **Actionable Error Feedback:** All user-facing error messages clearly describe what happened and state the exact next action to resolve it.
4. **Non-Functional Budgets:** Meets every performance and resource budget the spec defines for the affected flows.
5. **Privacy & Security Integrity:** Zero plaintext credentials and zero customer PII in fixtures or logs (use synthetic generators), plus any storage and network constraints the spec defines.

Typical project-specific additions: CLI parity with `--json` output and standard exit codes, accessibility levels, localization parity.

---

## 7. Automated Backlog Verification

Run the verification script that ships with this skill against any backlog document (adjust the path to where the skill is installed):

```bash
python3 .agents/skills/user-story-authoring/scripts/verify_backlog.py docs/user-stories.md
```

The script automatically verifies:
- Zero local absolute file paths (`file://`, `/Users/`, `/home/`, `C:\Users\`).
- 100% of user stories have dependencies, user personas, and Given/When/Then BDD acceptance criteria.
- 1:1 parity between high-level matrix tables and detailed story blocks.
- 100% sprint-aligned Epics without cross-sprint fragmentation.
