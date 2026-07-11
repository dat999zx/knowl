# Autonomous Memory Execution Roadmap

> Execute one plan at a time. Do not start the next plan until the current plan passes focused tests, full tests, build, `git diff --check`, and stores a concise Knowl implementation outcome.

Design source: `docs/superpowers/specs/2026-07-11-autonomous-project-memory-design.md`

## Order

1. [Memory Trust Foundation](2026-07-11-memory-trust-foundation.md)
2. [Evidence and Provenance](2026-07-11-evidence-provenance.md)
3. [Retrieval Quality](2026-07-11-retrieval-quality.md)
4. [Automatic Memory Core](2026-07-11-automatic-memory-core.md)
5. [Session Candidate Promotion](2026-07-11-candidate-promotion.md)
6. [Agent Automation](2026-07-11-agent-automation.md)
7. [Knowledge Intelligence](2026-07-11-knowledge-intelligence.md)
8. [Product Layer](2026-07-11-product-layer.md)

## Dependencies

```text
1 Trust Foundation
├── 2 Evidence
│   ├── 5 Candidate Promotion ──┐
│   └── 7 Intelligence         ├── 8 Product Layer
├── 3 Retrieval Quality ───────┘
└── 4 Automatic Memory Core
    ├── 5 Candidate Promotion
    └── 6 Agent Automation
```

Plan 7 requires Plans 2 and 3. Plan 8 requires Plans 2, 5, and 7. Plans 3 and 4 may be developed independently after Plan 1, but execute sequentially in this repository to minimize schema conflicts.

## Per-Plan Start Checklist

- Read the entire selected plan.
- Run `knowl_recent` and a focused `knowl_query` for that subsystem.
- Confirm the working tree and current branch.
- Use the required execution skill named in the plan header.
- Mark checkboxes as tasks complete.
- Use TDD: failing test, minimal implementation, passing test.
- Commit at the checkpoints in the plan.

## Per-Plan Completion Checklist

Run:

```powershell
rtk npm.cmd test
rtk npm.cmd run build
rtk git diff --check
rtk git status --short
```

Then:

- inspect the final diff for unrelated changes;
- update README/doctor only where behavior changed;
- store one concise Knowl state item with files, behavior, verification, and commit;
- update this roadmap by changing the completed plan checkbox below.

## Progress

- [x] Plan 1: Memory Trust Foundation
- [x] Plan 2: Evidence and Provenance
- [x] Plan 3: Retrieval Quality
- [x] Plan 4: Automatic Memory Core
- [x] Plan 5: Session Candidate Promotion
- [ ] Plan 6: Agent Automation
- [ ] Plan 7: Knowledge Intelligence
- [ ] Plan 8: Product Layer

## Scope Guard

Across all plans:

- no permanent raw transcript archive;
- no model call per tool/event;
- no cloud requirement;
- no silent conflict resolution;
- no write path bypassing universal validation;
- no retrieval change accepted without evaluation;
- no viewer-specific storage implementation;
- no team synchronization before namespaces and import/export stabilize.
