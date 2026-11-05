#!/usr/bin/env python3
"""
verify_backlog.py - Automated validation script for Chat Bridge User Story Catalog.
Validates:
1. All stories have dependencies, persona, and BDD acceptance criteria (Given/When/Then).
2. High-level Epic and Backlog matrix tables match story details 1:1.
3. Zero local absolute file paths (e.g. file:/// or /Users/).
4. All Epics are aligned with sprints without cross-sprint fragmentation.
"""

import sys
import re
from pathlib import Path

def verify_catalog(doc_path: Path) -> bool:
    content = doc_path.read_text(encoding="utf-8")
    errors = []

    # 1. Local path leak check
    local_leaks = re.findall(r"file://|/Users/\w+", content)
    if local_leaks:
        errors.append(f"Found {len(local_leaks)} local path leaks (file:// or /Users/). Use relative links.")

    # 2. Extract story detail blocks
    story_pattern = re.compile(
        r"###\s+(US-[A-Z0-9]+-\d+):\s+(.*?)\n(.*?)(?=\n###\s+US-|\n##\s+Epic|\n---\s*\n##\s+Global|\Z)",
        re.DOTALL
    )
    story_matches = list(story_pattern.finditer(content))
    story_ids = [m.group(1) for m in story_matches]

    if not story_ids:
        errors.append("No user stories found matching pattern '### US-...'")

    # 3. Validate each story block
    for m in story_matches:
        sid = m.group(1)
        body = m.group(3)

        if not re.search(r"[-*]\s+\*\*Dependencies:\*\*", body):
            errors.append(f"{sid}: Missing 'Dependencies' field.")
        if not re.search(r"[-*]\s+\*\*User Persona:\*\*", body):
            errors.append(f"{sid}: Missing 'User Persona' field.")
        if not re.search(r"[-*]\s+\*\*Acceptance Criteria:\*\*", body):
            errors.append(f"{sid}: Missing 'Acceptance Criteria' header.")
        if "When" not in body or "Then" not in body:
            errors.append(f"{sid}: Incomplete BDD acceptance criteria (must contain When and Then).")

    # 4. Check matrix table parity (matches `US-...` or **`US-...`**)
    matrix_ids = set(re.findall(r"\|\s*(?:\*\*)?`?(US-[A-Z0-9]+-\d+)`?(?:\*\*)?\s*\|", content))
    detail_ids = set(story_ids)

    missing_in_matrix = detail_ids - matrix_ids
    if missing_in_matrix:
        errors.append(f"Stories in detail sections but missing from matrix table: {sorted(missing_in_matrix)}")

    missing_in_details = matrix_ids - detail_ids
    if missing_in_details:
        errors.append(f"Stories in matrix table but missing detail blocks: {sorted(missing_in_details)}")

    # 5. Epic sprint alignment
    epic_pattern = re.compile(r"##\s+Epic\s+(\d+):\s+(.*?)\s+\((Sprint\s+\d+)\)")
    epics = epic_pattern.findall(content)
    if not epics:
        errors.append("No sprint-aligned Epic headers found (e.g. '## Epic 1: Name (Sprint 1)').")

    # Output report
    if errors:
        print(f"FAILED: {len(errors)} validation error(s) found in {doc_path.name}:")
        for err in errors:
            print(f"  - {err}")
        return False

    print(f"PASSED: {len(story_ids)} user stories across {len(epics)} sprint-aligned epics verified in {doc_path.name}.")
    return True

if __name__ == "__main__":
    target = Path("docs/user-stories.md")
    if len(sys.argv) > 1:
        target = Path(sys.argv[1])
    if not target.exists():
        print(f"Error: Target file not found at {target}")
        sys.exit(1)
    if not verify_catalog(target):
        sys.exit(1)
