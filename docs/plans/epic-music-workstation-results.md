# Film Engine Music Workstation — Task State

Epic: `docs/plans/epic-music-workstation.md` · Jira GRD-3935 (children GRD-3936..GRD-3959, in MUS order).
Instrument-render tickets GRD-3993..GRD-3996 are NOT part of this table: they wait on a human decision.

| Task | Jira | State | Note |
|------|------|-------|------|
| MUS-001 | GRD-3936 | DONE | Migration `105_music_workstation.sql` (103/104 were taken): seven tables, every FK with a deletion rule, every lifecycle and range a CHECK, film_assets untouched. `tests/music-workstation-schema.test.js` (9, set-based over the migration file). Full suite 4197/4197. Commit fc1caa6; GRD-3936 Done. |
| MUS-002 | GRD-3937 | DONE | `lib/music-session.js`: VOCABULARY and RANGES held equal to migration 105's CHECKs in both directions; a validator per table (VALIDATORS), tempo-map and automation-point validation, lifecycle TRANSITIONS with every state present, toRow/fromRow over a JSON_COLUMNS registry, and `readScoreSession` as the one read model (SCORE_SESSION_SHAPE, project-scoped). `tests/music-session-contracts.test.js` (14, set-based over the migration's enums/ranges/JSON columns and every lifecycle). |
| MUS-003 | GRD-3938 | TODO | Compile sequence score context — dependencies done; unblocked 2026-09-11. |
| MUS-004 | GRD-3939 | WAITING ON MUS-002, MUS-003 | Add session HTTP API. |
| MUS-005 | GRD-3940 | WAITING ON MUS-004 | Add session MCP workflow. |
| MUS-006 | GRD-3941 | WAITING ON MUS-002, MUS-004 | Build aligned user stem import. |
| MUS-007 | GRD-3942 | WAITING ON MUS-004, MUS-006 | Build native multitrack editor. |
| MUS-008 | GRD-3943 | WAITING ON MUS-002, MUS-004, MUS-006 | Implement deterministic bounce. |
| MUS-009 | GRD-3944 | TODO | Expand provider capability registry — dependencies done; unblocked 2026-09-11. |
| MUS-010 | GRD-3945 | WAITING ON MUS-003, MUS-005, MUS-009 | Add MCP emotion proposals. |
| MUS-011 | GRD-3946 | WAITING ON MUS-006, MUS-008, MUS-009 | Add ElevenLabs stem separation. |
| MUS-012 | GRD-3947 | WAITING ON MUS-008, MUS-009, MUS-010 | Add part, reference, and inpaint generation. |
| MUS-013 | GRD-3948 | WAITING ON MUS-009, MUS-011, MUS-012 | Add grouped AI jobs and take lineage. |
| MUS-014 | GRD-3949 | WAITING ON MUS-007, MUS-010, MUS-011, MUS-012, MUS-013 | Add AI workstation controls. |
| MUS-015 | GRD-3950 | WAITING ON MUS-008, MUS-013 | Define portable score package. |
| MUS-016 | GRD-3951 | WAITING ON MUS-015 | Define DAW adapter interface. |
| MUS-017 | GRD-3952 | WAITING ON MUS-016 | Build AbletonOSC local sidecar. |
| MUS-018 | GRD-3953 | WAITING ON MUS-005, MUS-016, MUS-017 | Expose Ableton MCP tools. |
| MUS-019 | GRD-3954 | WAITING ON MUS-014, MUS-015, MUS-018 | Add DAW connection and sync UI. |
| MUS-020 | GRD-3955 | WAITING ON MUS-008, MUS-014 | Integrate approved score with assembly. |
| MUS-021 | GRD-3956 | WAITING ON MUS-015, MUS-020 | Extend project bundles and recovery. |
| MUS-022 | GRD-3957 | WAITING ON MUS-006, MUS-011, MUS-015, MUS-020 | Enforce rights and provenance gates. |
| MUS-023 | GRD-3958 | WAITING ON MUS-018, MUS-021, MUS-022 | Complete documentation and operations. |
| MUS-024 | GRD-3959 | WAITING ON MUS-019, MUS-020, MUS-021, MUS-022, MUS-023 | Prove the end-to-end movie workflow. |
