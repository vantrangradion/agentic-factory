---
name: architecture-decision
description: Procedure for critically analyzing technical trade-offs, questioning spec assumptions, evaluating scalability and security, guiding architectural choices with stakeholders, and authoring Architecture Decision Records (ADRs) in docs/decisions/.
---

# Architecture Decision & ADR Workflow

Use this skill whenever evaluating technical options, choosing libraries or protocols, designing database schemas, or authoring/updating Architecture Decision Records (ADRs).

---

## Core Principle: Never Blindly Trust the Spec

A product specification defines the **problem domain, business requirements, user expectations, and non-functional budgets**. However, technical solutions or implementation suggestions mentioned in the spec must be **critically analyzed and questioned**, never blindly accepted:

1. **Distinguish Requirements from Implementation Suggestions:**
   - *Requirement:* "Messages must be securely encrypted at rest using keys from the OS Keystore, without data loss during crashes."
   - *Implementation Suggestion:* "Encrypted SQLite." (e.g., SQLCipher vs SQLite + Envelope Encryption).
2. **Challenge Prescriptive Choices Against First Principles:**
   - *Does the suggested library or pattern scale under high load and burst ingestion?*
   - *Does it introduce CPU/memory bottlenecks, native compilation fragility, or high IPC latency?*
   - *Is there a more scalable, reliable, or maintainable architecture that fulfills the exact security and business constraints?*
3. **Bring Evidence & Alternatives:**
   - When a spec suggestion has hidden pitfalls (e.g. SQLCipher page-level crypto overhead on queue polling vs envelope encryption, or Google Apps Script 90-min limits vs REST API v4), articulate the trade-offs clearly and guide stakeholders to the superior architecture.

---

## 1. The 4-Step Decision Framework

Every architectural decision follows a rigorous 4-step process:

```
[ 1. Anchor & Critique Spec ] ---> [ 2. Analyze Trade-offs ] ---> [ 3. Stakeholder Alignment ] ---> [ 4. Record ADR & Index ]
```

### Step 1: Anchor in the Spec & Critically Challenge Assumptions
- Extract the core problem, user needs, functional goals, and non-functional budgets from `docs/spec.md`.
- Identify hard constraints:
  - Memory & CPU budgets (e.g., <250 MB idle RSS, <400 MB burst).
  - Security & privacy rules (encryption at rest, OS keystore, zero PII in repo).
  - Target user constraints (non-technical sales rep, no terminal, no config files).
  - Timeline & scope commitments (Must vs Should).
- **Critically audit any technical hints in the spec:** Check for performance bottlenecks, platform portability issues, or maintenance traps before treating them as decisions.

### Step 2: Compare Viable Alternatives Fairly
Always compare 2–3 realistic options across standard evaluation dimensions:

1. **Scalability & Throughput:**
   - **Resource Scalability:** Idle RAM vs burst memory headroom under high volume.
   - **Event-Loop & CPU:** Single-process native execution vs cross-process IPC serialization overhead.
   - **Long-Running Stability:** Memory growth over continuous multi-hour runs.
2. **Security & Privacy:**
   - Key derivation (OS Keystore: Keychain/DPAPI).
   - Encryption at rest (AEAD AES-256-GCM / SQLCipher).
   - Tamper-resistance and metadata leakage.
3. **User Experience (UX Guard):**
   - Impact on the non-technical user install and configuration flow.
   - Absence of internal jargon on user-facing screens.
4. **Implementation Risk & Maintainability:**
   - Zero compilation/native packaging fragility across platforms (macOS Intel/Apple Silicon, Windows x64, Linux CI).
   - Dependency footprint and maintenance overhead.

### Step 3: Interactive Alignment
- Summarize the options concisely with a comparison table.
- Provide a clear, justified recommendation prefixed with `(Recommended)`.
- Confirm the choice with the user/stakeholder before writing code or finalizing the record.

### Step 4: Author the ADR & Update Index
1. Create a new markdown document under `docs/decisions/` using the sequential numbering format: `docs/decisions/NNNN-<kebab-case-slug>.md` (e.g., `0004-web-ui-transport.md`).
2. Follow the standard ADR template below.
3. Update the master index table in `docs/decisions.md`.
4. Ensure no orphaned, duplicate, or superseded drafts remain.

---

## 2. Standard ADR Markdown Template

When writing an ADR, adhere to this structure:

```markdown
# ADR NNNN: <Short Title>

* **Status:** Accepted | Proposed | Superseded
* **Date:** YYYY-MM-DD
* **Deciders:** Team / Project Lead
* **Consulted:** docs/spec.md (Section X, Feature IDs)

---

## 1. Context and Problem Statement
[Describe the context, the user need, and the technical problem being solved. Quote relevant spec requirements.]

We evaluated:
1. Option 1: ...
2. Option 2: ...
3. Option 3: ...

---

## 2. Decision
[State the chosen architecture and detail its technical specifications, components, and configurations.]

---

## 3. Rationale and Comparison
[Explain why this option was chosen over alternatives. Include a comparison matrix and justify across scalability, security, complexity, and performance.]

| Metric / Dimension | Option 1 | Option 2 | Option 3 |
| :--- | :--- | :--- | :--- |
| ... | ... | ... | ... |

---

## 4. Consequences and Mitigations
* **Trade-off 1:** [Negative or risky implication]
  * *Mitigation:* [How we solve or mitigate it]
* **Trade-off 2:** [Second trade-off]
  * *Mitigation:* [Mitigation strategy]
```

---

## 3. ADR Hygiene Rules

- **Strict Immutability:** Once an ADR is marked `Accepted`, do not silently alter its fundamental decision. If a decision is reversed or redesigned, mark the old ADR as `Superseded by ADR XXXX` and write a new ADR.
- **Index Sync:** Every addition, rename, or status change must be immediately reflected in `docs/decisions.md`.
- **No Duplicate Drafts:** Never leave conflicting draft versions of the same ADR ID in the `docs/decisions/` directory.

