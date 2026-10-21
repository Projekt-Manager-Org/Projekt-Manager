<!-- READ-ONLY for AI -->

# Test Conventions

Rules for tests (non-negotiable):

- **T-TAUT** — Tautology: test tests nothing.
- **T-ACBS** — Miss: test does not really test what it claims to test, including the AC it cites.

Guidelines for tests (judgement is required):

- **T-REDU** — Redundancy: test duplicates another test's coverage.
- **T-BLOA** — Bloat: test tests some minute, non-critical details of the implementation, which are not covered by the AC it belongs to. See "reasonable assumptions" in the Kickoff and "minute details" in the spec.
- **T-COMM** — Miss: comments are stale, wrong or useless.

Note: All tests in the project are written by AI agents and may contain errors, inaccuracies and/or omissions.
