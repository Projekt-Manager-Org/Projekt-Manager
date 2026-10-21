<!-- READ-ONLY for AI -->

# Spec Conventions

**IMPORTANT:** All of [conventions-docs-general.md](conventions-docs-general.md) apply here as well.

Rules for the [product specification](../docs/spec/index.md) (non-negotiable):

- **S-KICK** — The spec fully follows and extends the [kickoff](../docs/project/kickoff.md). No discrepancy with the stated baseline (scope, "Not Doing", assumptions).
- **S-CONS** — The spec is consistent with itself; no contradictions between files or sections.
- **S-COMP** — The spec is logically complete. Every observable behavior has a defined trigger, outcome, and boundary condition. Adherence to _D-SSOT_ is still required!
- **S-ERRP** — Error paths are defined. For every mutation, the spec states what happens when it fails, conflicts, or is unauthorized.
- **S-NDET** — Each statement in the spec exists only if removing it would let two conforming implementations differ observably (to a user, operator, attacker, or in data leaving the system). Everything else is left to the implementers.
- **S-NLOG** — The spec is a contract for the code. It contains no historical references, iteration mentions, roadmap notes, or plans.
- **S-REFS** — The spec can stand on its own — only acceptable external references are [kickoff](../docs/project/kickoff.md), [ADRs](../docs/adr/index.md), [`CONTRIBUTING.md`](../CONTRIBUTING.md) and [`ARCHITECTURE.md`](../ARCHITECTURE.md). References must work — no dead links, no references to moved or removed sections.
- **S-ACS1** — Every AC carries exactly one tier marker as defined in the [verification.md AC legend](../docs/spec/verification.md).
- **S-ACS2** — Each AC is testable, not vague.
- **S-CONF** — Every configurable value — carrying `[C]` — appears in the `[C]` catalogue ([architecture.md "Company Configurable Settings"](../docs/spec/architecture.md)).
- **S-ACTR** — Every AC is cited by at least one test, or has an infra (verification method) or gap row in the verification-exceptions file.
- **S-TRAC** — Every AC citation outside the verification-exceptions file names exactly one defined AC — no ranges, list each ID; the file’s retired rows record IDs that are never cited or reused. Enforced repo-wide by `scripts/check-traceability.sh` — review covers only the citations a change touches.

Guidelines for the specification (judgement is required):

- **S-TECH** — The spec strives to be tech-agnostic. _Test_: if swapping the tech would change the statement, it belongs in an [ADR](../docs/adr/index.md) or in [`ARCHITECTURE.md`](../ARCHITECTURE.md). Code snippets as examples are permitted for clarity and are not violations on their own, as long as the swapping test passes.

Note: The specification documents are all written by AI agents and may contain errors, inaccuracies and/or omissions.
