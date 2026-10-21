# EN 16931 CII validation rules (test-only)

The CEN EN 16931 business rules for the CII syntax, as the precompiled Schematron XSLT. Tests run them over rendered `factur-x.xml` ([AC-293](../../../docs/spec/verification.md#1530-invoices)). They never run at render time ([ADR-0026 §E-invoice format](../../../docs/adr/0026-invoices-immutability-and-zugferd.md#e-invoice-format)).

|         |                                                                                                                                                                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source  | [ConnectingEurope/eInvoicing-EN16931](https://github.com/ConnectingEurope/eInvoicing-EN16931) release `validation-1.3.17`, asset `en16931-cii-1.3.17.zip` (sha256 `e5f3235824b6b38454b1d54cf3f14e01efb5b33971fbefc4e64997d0ef619e89`) |
| File    | `EN16931-CII-validation.xslt` from the zip's `xslt` folder, unchanged (sha256 `0757f07909938b1b297b8356ab7b66406c89f1b342325385d6a2def998c817f0`)                                                                                     |
| License | EUPL-1.2 ([LICENSE.txt](LICENSE.txt), from the repository at the same tag)                                                                                                                                                            |

**Update:** replace the XSLT and `LICENSE.txt` from the new release, update this table, and run the Schematron test. Respect the project's minimum release age ([dep-management.md](../../../docs/ops/dep-management.md)).
