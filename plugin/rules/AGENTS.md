# Agentic Factory — Universal Agent Rules & Core Invariants

These invariants govern all agentic software development across any project using the Factory Model:

1. **The Core Formula:** $\text{Agent} = \text{Model} + \text{Harness}$. Always invest in the harness (CapEx) before feature coding (OpEx).
2. **Deterministic Verification over Vibes:** Never rely on model memory or LLM self-assessment. Every change must be verified via automated unit/contract tests and deterministic AST guardrails (`pnpm guard`).
3. **Test-Driven Development (TDD):** Red run (verified failing test) $\rightarrow$ Green run (minimal passing implementation) $\rightarrow$ Guard verification.
4. **Privacy & Security by Design:** Never request, store, or log real customer PII, phone numbers, or credentials. Use synthetic generators (`@agentic-factory/harness`).
5. **No Architectural Bypass:** Never bypass package boundaries or introduce circular dependencies.

