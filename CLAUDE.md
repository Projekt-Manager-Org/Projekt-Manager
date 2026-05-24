<!-- READ-ONLY for AI -->

# Projekt-Manager

## Context

This project is an exercise in LLM-based development. Because LLMs do not always produce reliable output, and there is no practical way to predict when such slips will happen, we treat every artifact skeptically. Everything in the project is LLM-generated: docs, specs, code, tests, ADRs. The fact that all of it was produced under human supervision does not make the output substantially more reliable — a reviewer's attention is easily saturated when a large number of changes land in a small amount of time.

The methodology is therefore to arrive at confidence in sequential steps. Each artifact is trusted in proportion to the number of rounds of _independent_ reviews it has survived. In other words, we are _converging_ on the truth one step at a time.

## References, trust categories

- **Repo**: Projekt-Manager-Org/Projekt-Manager (private)

**Human-made** - ultimate source of truth, can still be questioned and discussed:

- **Kickoff**: [docs/project/kickoff.md](docs/project/kickoff.md) - the guiding light of the project, the ultimate truth
- **Conventions**: [CONTRIBUTING.md](CONTRIBUTING.md) and category-specific: `review/conventions-*.md`

**AI-made, human scrutiny** - second level truth/trust, can be questioned and discussed:

- **Decisions**: [docs/adr/](docs/adr/index.md)

**AI-made, AI-reviewed, some human scrutiny** - third level truth/trust, often still errors, needs regular cleanup and correction:

- **Spec**: [docs/spec/](docs/spec/index.md).

**AI-made, not reviewed** - a matter of pure luck to contain good data:

- **Scratch space**: `docs/wip/` - just a place for temporary files.
- **GitHub Issues, Comments**: main point stands, description and proposed solution might be BS, often wrong.

## Question everything

You may notice that even the Kickoff got couple revisions during development. Everything beneath it should be treated as a draft, a temporal solution, until a better option presents itself.

## Workflow

Follow [CONTRIBUTING.md § Workflow](CONTRIBUTING.md#workflow).

## Principles

Data integrity, security and quality defaults are the baseline, **not open questions.** When an established professional practice applies (HTTPS everywhere, input validation, auth on every mutation, CSRF protection, test isolation, ...), the default is to do it. The discussion — when there is one — is about _how_ to implement it cleanly in the current topology, not _whether_ to.

If the environment cannot meet a data integrity, security or quality requirement, the correct behavior is to **refuse to serve, fail the deploy, or block the merge** — not to downgrade the requirement. When the implementation lags behind a safety criterion in the spec or an AC, fix the implementation. Do not rewrite the criterion to match the stub.

## Working with documentation

When working with documentation - including docs, spec, ADRs, GH issues and comments, code comments - aim for concise, focused and clear statements. If the statement can be written shorter, without losing the meaning, go for it. Long prose hurts readability.

Where possible, prefer a simple diagram over a long explanation.

## Undecided Specifics

Many details are deliberately left open until their iteration. When work hits something undefined:

1. Stop — do not assume.
2. Flag what is undefined and why it blocks.
3. When decided — suggest recording it in its proper place.
