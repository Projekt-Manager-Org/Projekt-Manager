# E2E triage

A red E2E run on `main` opens _E2E is red on main_ ([`notify.yml`](../../.github/workflows/notify.yml)); later runs comment on it. A green run does not close it: a flake passes on the next run, so green explains nothing. For the same reason Playwright runs with `retries: 0`.

Triage each red run to the first row that matches. Comment the cause with the failing test and `test.step`, then close the issue.

| Cause                    | Recognised by                                                                                                             | Do                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Defect                   | The same `test.step` fails in another run: a re-run, a later run on this issue, or an earlier incident                    | Fix the test or the app; close once a run is green |
| Flake in a `[crit]` test | The test cites a `[crit]` AC                                                                                              | Investigate on the first incident, within 14 days  |
| Runner noise             | A one-off with runner symptoms: setup, service container, network, the job hitting `timeout-minutes` — not a test timeout | Close as runner noise                              |
| Other flake              | A one-off, none of the above                                                                                              | Close; a second incident makes it a defect         |

Evidence: the run's `playwright-report-<run id>` artifact, kept 14 days (`npx playwright show-trace <zip>`). Earlier incidents: closed issues titled _E2E is red on main_.
