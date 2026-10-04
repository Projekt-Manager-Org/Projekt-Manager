<!-- READ-ONLY for AI -->

# Code Conventions

Rules for the code (non-negotiable):

- **C-DATA** — Ensuring data integrity, preventing data loss or stale data — **CRITICAL**.
- **C-SPEC** — Adherence to the specification.
- **C-ARCH** — Adherence to `ARCHITECTURE.md` at the project's root.
- **C-EXTE** — No "silent extensions" — behavior the spec does not describe.
- **C-INPU** — Input validation at system boundaries (API, DB, file I/O); trust internals.
- **C-DEAD** — No dead code — commented-out blocks, unreachable branches.
- **C-SECU** — Authorization checked before sensitive data is accessed.
- **C-BWCO** — Backward-compatibility is not a concern and should be treated as technical debt. This statement will be adjusted when real data is started being used.

Guidelines for the code (judgement is required):

- **C-COMM** — The comments correspond to the reality of the code.
- **C-HARD** — No magic strings/numbers — named constants or enums.
- **C-SRES** — Single responsibility.
- **C-DRYY** — DRY.
- **C-NAME** — Naming of variables, functions, files, etc. is clear.
- **C-SIZE** — File size. Propose a split on files bigger than 200 LOC. Argumented exceptions are accepted (tests, reference lists,...).
- **C-BUYB** — Buy before build. Prefer boring, well-maintained dependencies; own only what is differentiating.

Note: All code in the project is written by AI agents and may contain errors, inaccuracies and/or omissions.
