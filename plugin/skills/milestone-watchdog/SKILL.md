---
name: milestone-watchdog
description: Inspect a multi-story milestone batch, classify each story's delivery state, report what needs attention, and safely resume interrupted or rejected work. Use when resuming a batch after an interruption, a crash, or a context reset, when asked "where are we", or before starting the next story in a milestone.
---

# Milestone Watchdog Skill

Long milestone batches get interrupted: sessions end, context is compacted, CI fails while the agent has moved on, or a reviewer rejects a plan in a draft PR. This skill rebuilds the true state of the batch from git and GitHub (never from memory), reports it, and resumes only work that is safe to resume.

It separates two things that must never be conflated:
* **Attention:** facts about the batch that someone should look at. Reporting is always allowed.
* **Authorization:** permission to act on them. Recovery actions are limited to stories in the batch the developer assigned to this agent.

---

## 1. Inventory (read-only)

Collect state from the source of truth. Do not trust previous session summaries.

```bash
# Story PRs authored by this agent, with draft, review, and CI state
gh pr list --author @me --state all --limit 50 \
  --json number,title,headRefName,isDraft,state,reviewDecision,mergedAt,updatedAt,statusCheckRollup

# Local branches and uncommitted work
git fetch --prune
git branch -vv
git status --short
```

Also read the batch's story list and dependency order from the backlog (for example `docs/user-stories.md`), and validate it with the `user-story-authoring` backlog script when one exists.

---

## 2. Classify Every Story

Assign each story in the batch exactly one state, checking in this order:

| State | Signal |
| :--- | :--- |
| `MERGED` | PR merged. |
| `PLAN_REJECTED` | Draft PR with `reviewDecision` = `CHANGES_REQUESTED`, or a review comment rejecting the `## Plan`. |
| `CHANGES_REQUESTED` | Ready PR with `reviewDecision` = `CHANGES_REQUESTED`. |
| `CI_FAILING` | Any required check in `statusCheckRollup` is failing. |
| `AWAITING_REVIEW` | Ready PR, checks passing, no decision yet. |
| `INTERRUPTED` | Draft PR or branch exists, but the lifecycle did not reach step 7 (no audit report in the PR body, or uncommitted changes on the branch). |
| `BLOCKED` | Story failed the Definition of Ready, or hit a non-automatable human gate. |
| `NOT_STARTED` | No branch and no PR. |

A story is also `STALE` (reported alongside its state) when its dependency was revised after the story branched: the story branch does not contain the dependency branch's latest commit.

---

## 3. Report

Print one line per story in dependency order, using PASS, WARN, or FAIL prefixes only:

```text
PASS US-C1-01 MERGED            #11
WARN US-C1-02 AWAITING_REVIEW   #12  checks green, waiting on reviewer
FAIL US-C1-03 PLAN_REJECTED     #13  reviewer: "split the store from the dispatcher"
WARN US-C1-04 INTERRUPTED STALE #14  built on the rejected plan of US-C1-03
WARN US-C1-05 NOT_STARTED            blocked by US-C1-03
NEXT: revise US-C1-03, then rebase US-C1-04
```

End with a single `NEXT:` line naming the first action. If nothing is actionable by the agent, say who it is waiting on.

---

## 4. Recover (authorized stories only)

Act on the earliest story in dependency order whose state the agent can fix. Before touching any branch, all preconditions must hold:
1. The story belongs to the batch assigned to this agent.
2. The branch was created by this agent, and no one else has pushed to it (`git log` authors match).
3. The working tree is clean, or its uncommitted changes clearly belong to this story's branch.

Then apply the matching recovery:

| State | Recovery |
| :--- | :--- |
| `PLAN_REJECTED` | Revise the `## Plan` in the PR body to address every review comment, reply on the PR summarizing the change, then restart the lifecycle at step 3 (Red). |
| `CHANGES_REQUESTED` | Address each comment with a new commit, then re-run steps 4 to 6 and update the PR body. |
| `CI_FAILING` | Reproduce locally, fix, and re-run steps 4 to 6. |
| `INTERRUPTED` | Resume at the earliest step without verified evidence in the PR body. Always re-run the tests and the project's guards; a previous green run does not count after an interruption. |
| `STALE` | Rebase onto the dependency's latest commit, then re-run the tests and guards. Use `git push --force-with-lease` only on the agent's own story branch. |
| `BLOCKED` | Do nothing; restate what is needed and from whom. |

After a recovery, re-run the inventory and report again before continuing the batch.

---

## 5. Never

* Merge, close, approve, or mark ready a PR whose required checks are failing.
* Push to, rebase, or force-push a branch another person has committed to.
* Mark a story done in the backlog before its PR is merged.
* Skip the tests or guards to "catch up" a batch.
* Infer state from memory or an earlier summary when git or GitHub can answer.
