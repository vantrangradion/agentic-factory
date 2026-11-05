# Agentic Factory: Universal Agent Rules & Core Invariants

These invariants govern all agentic software development across any project using the Factory Model:

1. **The Core Formula:** Agent = Model + Harness. Always invest in the harness (CapEx) before feature coding (OpEx).
2. **Deterministic Verification over Vibes:** Never rely on model memory or LLM self-assessment. Every change must be verified via automated unit/contract tests and deterministic AST guardrails (`pnpm guard`).
3. **Test-Driven Development (TDD):** Red run (verified failing test) -> Green run (minimal passing implementation) -> Guard verification.
4. **Privacy & Security by Design:** Never request, store, or log real customer PII, phone numbers, or credentials. Use synthetic generators (`@agentic-factory/harness`).
5. **No Architectural Bypass:** Never bypass package boundaries or introduce circular dependencies.
6. **No Icons, Emojis, or Em Dashes:** Never output emojis, icons, or em dashes in CLI outputs, UI text, logs, code comments, documentation, or user communication. Use standard Unix conventions (PASS, FAIL, WARN) and clean punctuation (hyphens or colons).

