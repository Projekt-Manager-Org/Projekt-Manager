# Verification Exceptions

Tests are the test spec: an AC is covered when a test file cites its ID (`grep -rn AC-397 src e2e scripts`). This file lists only what a test citation cannot show. [`scripts/check-traceability.sh`](../../scripts/check-traceability.sh) enforces it ([S-ACTR, S-TRAC](../../review/conventions-spec.md)).

| Status    | Meaning                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------- |
| `infra`   | An `[infra]` AC verified outside the test suite — the column names how                            |
| `gap`     | No test covers the AC yet — the column names what is missing                                      |
| `retired` | The ID no longer exists and is never reused; every number up to the highest is defined or retired |

A row goes when a test starts citing its AC; the check fails on a stale row.

| AC     | Status  | Verified by / missing                                                                                    |
| ------ | ------- | -------------------------------------------------------------------------------------------------------- |
| AC-2   | retired | —                                                                                                        |
| AC-3   | retired | —                                                                                                        |
| AC-4   | retired | —                                                                                                        |
| AC-5   | retired | —                                                                                                        |
| AC-6   | retired | —                                                                                                        |
| AC-8   | retired | —                                                                                                        |
| AC-9   | retired | —                                                                                                        |
| AC-10  | retired | —                                                                                                        |
| AC-11  | gap     | needs an e2e that renders both column types                                                              |
| AC-12  | gap     | needs an e2e walking Kanban dot + calendar bar + detail badge for one project                            |
| AC-13  | retired | —                                                                                                        |
| AC-14  | retired | —                                                                                                        |
| AC-15  | retired | —                                                                                                        |
| AC-16  | retired | —                                                                                                        |
| AC-17  | retired | —                                                                                                        |
| AC-18  | retired | —                                                                                                        |
| AC-19  | retired | —                                                                                                        |
| AC-20  | retired | —                                                                                                        |
| AC-30  | infra   | deployment review — reverse-proxy TLS                                                                    |
| AC-31  | infra   | deploy procedure — `scripts/deploy.sh`                                                                   |
| AC-32  | infra   | ESLint import zones — `eslint.config.js`, CI `lint`                                                      |
| AC-33  | infra   | ESLint import zones — `eslint.config.js`, CI `lint`                                                      |
| AC-34  | infra   | code review                                                                                              |
| AC-35  | infra   | ESLint import zones — `eslint.config.js`, CI `lint`                                                      |
| AC-36  | infra   | CI `lint` — ESLint, Prettier                                                                             |
| AC-37  | infra   | CI `check` job; nightly `e2e.yml`                                                                        |
| AC-38  | gap     | needs an e2e that flips the config value and checks header + footer                                      |
| AC-40  | retired | —                                                                                                        |
| AC-41  | retired | —                                                                                                        |
| AC-42  | retired | —                                                                                                        |
| AC-43  | retired | —                                                                                                        |
| AC-46  | infra   | deploy procedure — `scripts/deploy.sh`                                                                   |
| AC-47  | infra   | deploy procedure — `scripts/deploy.sh <sha>`                                                             |
| AC-48  | infra   | deploy procedure — `scripts/smoke-app-health.sh`                                                         |
| AC-49  | infra   | deployment review — VPN-only reachability                                                                |
| AC-50  | infra   | deployment review — persistent volumes                                                                   |
| AC-51  | infra   | deploy procedure — `scripts/deploy.sh` takes a commit SHA                                                |
| AC-70  | retired | —                                                                                                        |
| AC-71  | retired | —                                                                                                        |
| AC-72  | retired | —                                                                                                        |
| AC-73  | retired | —                                                                                                        |
| AC-74  | gap     | the navigation walk misses Daten, Aktivität, Benachrichtigungen, Meine Projekte; no-reload is unasserted |
| AC-80  | gap     | needs an e2e walking the customer table + project-count column                                           |
| AC-86  | retired | —                                                                                                        |
| AC-87  | retired | —                                                                                                        |
| AC-88  | retired | —                                                                                                        |
| AC-89  | retired | —                                                                                                        |
| AC-90  | retired | —                                                                                                        |
| AC-105 | gap     | needs an e2e confirming the entry is visible only with `customer:write`                                  |
| AC-106 | gap     | needs an e2e covering the textarea and the action disabled while empty / in flight                       |
| AC-107 | gap     | needs an e2e walking the extraction-review form + existing-customer match                                |
| AC-108 | infra   | CI `lint` — `scripts/check-theme-tokens.sh`                                                              |
| AC-109 | gap     | needs an e2e that flips `data-theme` and walks the surfaces                                              |
| AC-110 | gap     | needs an e2e walking dark-mode surfaces, plus a WCAG AA contrast check                                   |
| AC-113 | infra   | CI `lint` — `scripts/check-theme-tokens.sh`                                                              |
| AC-114 | gap     | needs an e2e that swaps the accent and walks primary, link, focus, selection                             |
| AC-126 | retired | —                                                                                                        |
| AC-128 | gap     | needs an e2e of the create-form dropdown flows (`CustomerManagement.test.tsx` is mock-based)             |
| AC-129 | gap     | needs an e2e covering soft-confirm + "Trotzdem erstellen"                                                |
| AC-130 | gap     | needs an e2e covering blur → verdict → edit clears verdict (`ProjectManagement.test.tsx` is mock-based)  |
| AC-143 | retired | —                                                                                                        |
| AC-144 | retired | —                                                                                                        |
| AC-162 | retired | —                                                                                                        |
| AC-163 | retired | —                                                                                                        |
| AC-172 | infra   | compose-file review                                                                                      |
| AC-173 | infra   | provider-side review against the recovery runbook                                                        |
| AC-175 | infra   | repo scan of `scripts/backup/load-drill-key.sh` (tmpfs-only); runbook review                             |
| AC-181 | retired | —                                                                                                        |
| AC-191 | retired | —                                                                                                        |
| AC-194 | retired | —                                                                                                        |
| AC-208 | gap     | `ProjectDetailPage.test.tsx` pins the read surface only; edit gating per permission is unasserted        |
| AC-212 | retired | —                                                                                                        |
| AC-213 | retired | —                                                                                                        |
| AC-214 | retired | —                                                                                                        |
| AC-215 | retired | —                                                                                                        |
| AC-216 | retired | —                                                                                                        |
| AC-217 | retired | —                                                                                                        |
| AC-218 | retired | —                                                                                                        |
| AC-219 | retired | —                                                                                                        |
| AC-220 | retired | —                                                                                                        |
| AC-221 | retired | —                                                                                                        |
| AC-222 | retired | —                                                                                                        |
| AC-223 | retired | —                                                                                                        |
| AC-224 | retired | —                                                                                                        |
| AC-226 | retired | —                                                                                                        |
| AC-227 | retired | —                                                                                                        |
| AC-229 | infra   | CI `lint` — `scripts/check-env-drift.sh`                                                                 |
| AC-232 | retired | —                                                                                                        |
| AC-233 | retired | —                                                                                                        |
| AC-234 | retired | —                                                                                                        |
| AC-235 | retired | —                                                                                                        |
| AC-238 | retired | —                                                                                                        |
| AC-239 | retired | —                                                                                                        |
| AC-241 | retired | —                                                                                                        |
| AC-242 | retired | —                                                                                                        |
| AC-243 | retired | —                                                                                                        |
| AC-245 | retired | —                                                                                                        |
| AC-246 | retired | —                                                                                                        |
| AC-248 | retired | —                                                                                                        |
| AC-249 | retired | —                                                                                                        |
| AC-250 | retired | —                                                                                                        |
| AC-251 | retired | —                                                                                                        |
| AC-252 | retired | —                                                                                                        |
| AC-255 | retired | —                                                                                                        |
| AC-256 | retired | —                                                                                                        |
| AC-257 | retired | —                                                                                                        |
| AC-258 | retired | —                                                                                                        |
| AC-259 | retired | —                                                                                                        |
| AC-260 | retired | —                                                                                                        |
| AC-261 | retired | —                                                                                                        |
| AC-262 | retired | —                                                                                                        |
| AC-263 | retired | —                                                                                                        |
| AC-264 | retired | —                                                                                                        |
| AC-265 | retired | —                                                                                                        |
| AC-266 | retired | —                                                                                                        |
| AC-267 | retired | —                                                                                                        |
| AC-271 | retired | —                                                                                                        |
| AC-272 | retired | —                                                                                                        |
| AC-273 | retired | —                                                                                                        |
| AC-274 | retired | —                                                                                                        |
| AC-313 | retired | —                                                                                                        |
| AC-314 | retired | —                                                                                                        |
| AC-315 | retired | —                                                                                                        |
| AC-348 | infra   | CI `lint` — lychee, `lychee.toml`                                                                        |
| AC-350 | retired | —                                                                                                        |
| AC-368 | infra   | review of `docs/ops/backup/recovery.md`                                                                  |
| AC-372 | retired | —                                                                                                        |
| AC-373 | retired | —                                                                                                        |
| AC-374 | infra   | monthly binary-key drill — `docs/ops/binary-key/drills.md`                                               |
| AC-401 | gap     | needs an e2e asserting the stored object is not the uploaded plaintext                                   |
| AC-405 | gap     | no test drives the client-side cap block or the missing retry action                                     |
| AC-423 | gap     | no test drives a restore whose storage copy fails with a non-410 error                                   |
| AC-445 | infra   | `scripts/binary-key/load-binary-key.sh` refuses a non-tmpfs target; runbook review                       |
| AC-452 | gap     | needs an e2e asserting the column order                                                                  |
| AC-453 | gap     | e2e asserts nine columns; card placement per state is unasserted                                         |
| AC-454 | gap     | needs an e2e asserting the oldest-first card order                                                       |
| AC-455 | gap     | e2e asserts a bar is visible, not that it spans the planned dates                                        |
| AC-456 | gap     | needs an e2e with a start-only project                                                                   |
| AC-460 | gap     | needs a component test of the card buttons in the first, middle and last state                           |
| AC-461 | gap     | needs a card test past the threshold; `aging.test.ts` covers only the helper                             |
| AC-462 | gap     | needs a card test past the threshold; `aging.test.ts` covers only the helper                             |
| AC-463 | gap     | e2e asserts the expanded header; the collapsed marker is unasserted                                      |
| AC-464 | gap     | e2e asserts the counter label, not the count                                                             |
| AC-466 | gap     | needs an e2e clicking "Filter aufheben"                                                                  |
| AC-467 | gap     | needs an e2e switching views with the filter active                                                      |
| AC-468 | gap     | needs a unit test of the date and range formatters                                                       |
| AC-469 | gap     | needs an e2e asserting a Monday-start week                                                               |
| AC-470 | gap     | needs an e2e below each tier width; `useCollapseTier.test.tsx` covers only the hook                      |
| AC-471 | gap     | needs a panel test clearing the start while an end is set                                                |
| AC-472 | gap     | `ProjectDetailPanel.test.tsx` asserts only the route change, not the back action                         |
| AC-473 | gap     | e2e opens the panel from a card; no test opens it from a calendar bar                                    |
| AC-474 | gap     | needs an e2e at phone width opening a project from the board and the calendar                            |
