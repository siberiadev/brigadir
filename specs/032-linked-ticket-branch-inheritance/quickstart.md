# Quickstart: Validating Linked-Ticket Branch Inheritance + Dependency Release Status

**Feature**: 032 | Prerequisites: pnpm install done; Docker running for integration tests.

## 1. Static gates + unit tests

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Must be green. Feature-specific units to watch:
- `libs/pipeline/src/dependency-gate.spec.ts` — decision table incl. case-insensitivity, OR-done
  guard, `allBlockedByKeys`.
- `libs/executors/src/claude-cli/prior-work.spec.ts` — precedence levels, per-repo claims,
  multi-blocker ordering.
- `libs/executors/src/claude-cli/worktree.spec.ts` — real-git merge cases (clean, conflict,
  unwind, startSha-after-merge).
- `libs/executors/src/claude-cli/wrapper.spec.ts` — provenance lines + Linked tickets block.
- `libs/human-tasks` — title-keyed dedup.

## 2. Integration suite (testcontainers)

```bash
pnpm test:integration
```

Feature suites (see contracts/*.md §test contract for the full matrices):
- `test/integration/dependency-gate.spec.ts` — configured-status release + early-release event.
- `test/integration/blocker-inheritance.spec.ts` (new) — blocker branch → dependent worktree HEAD;
  diamond merge; missing-branch matrix; task dedup.
- Regressions that MUST stay green untouched: `sprint-sequencing.spec.ts`,
  `claude-cli-branch-handoff.spec.ts`, `completion-gate.spec.ts`.

## 3. Manual end-to-end walk (dev stack)

1. `docker compose up --build` (postgres, redis, backend, worker); dashboard on the usual port.
2. Workspace settings → General → **Edit** → set **Dependency release status** to `In Review` →
   Save. (Read-only in the descriptions block; edited only in the modal, per the Settings-tab
   convention.)
   - Type a nonsense status → warning chip appears in the modal ("not observed on this board"),
     save still allowed; clear it back to `In Review`.
   - Clear the field entirely → the setting is removed (back to the done-category rule).
3. On the Jira board create A ← blocked-by — B (B "is blocked by" A), both with Components /
   statuses matching one agent's trigger flow.
4. Move A into the agent's trigger status; let its run finish (agent pushes `run/A`, reports it).
5. Move A to **In Review** (NOT Done). Within one reconcile cycle B's run starts:
   - B's run timeline: `dependency-release` event with `early: true, matched_status: "In Review"`;
   - per-repo `start-ref` event with decision `inherited_from_blocker` naming A and `run/A`;
   - B's wrapper (`.brigadir/wrapper.txt` of a kept worktree, or the timeline) shows the
     provenance line and the `## Linked tickets` block.
6. Negative check: unset the setting, repeat with a fresh pair → dependent waits until A is Done
   (today's behaviour).
7. Diamond check: two blockers pushing different branches of the same repo → dependent's
   `start-ref` shows `merged_blockers`; `git log` of the kept worktree shows the `--no-ff` merge
   commit as start point.
8. Lost-branch check: delete the blocker's branch on origin while blocker is In Review → next
   dependent run starts from default, timeline shows `blocker_no_artifact`, ONE
   `[blocker_branch_lost]` task in the human queue; re-trigger → no duplicate task.

## 4. Documentation gates

- `docs/architecture.md`: §3 `tickets.blocked_by` semantics note; §4 prepare pipeline (blocker
  resolution + merge step); admin-plane section unchanged.
- `docs/progress.md`: iteration entry appended.

## 5. Definition of Done checklist

- [X] All FR-001…FR-017 traceable to code + a test (spec ↔ contracts test matrices)
- [X] Setting unset ⇒ full suite green with zero behavioural diff (FR-016) — asserted
      explicitly by the last case of `test/integration/blocker-inheritance.spec.ts` and by the
      unchanged `sprint-sequencing` / `claude-cli-branch-handoff` / `completion-gate` suites
- [X] `pnpm typecheck && pnpm lint && pnpm test` and `pnpm test:integration` green
      (pre-existing, unrelated: 2 web `deepseek_api` indicative-cost cases fail on a clean tree too)
- [X] Constitution re-check: no new violations beyond the two justified in plan.md
- [ ] §3 manual walk against the dev stack + a live Jira board (needs a real board and
      credentials — not runnable from the automated environment)
