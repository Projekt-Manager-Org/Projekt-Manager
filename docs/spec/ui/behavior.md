# UI: Behavior

Section 9 of the [product spec](../index.md) — cross-cutting behavioral rules that apply across views.

---

## 9. Behavioral Rules

### 9.5 Asynchronous Mutation Behavior

Mutations (state transitions, date updates, creates, edits) go through the API (see [API](../api.md)). The UI must handle:

- **Loading state**: brief indicator (disabled button, spinner) while mutation is in flight. No double-submit on the same project.
- **Optimistic update**: the UI may update locally before the server responds, but must reconcile with the server response (revert on failure).
- **Error feedback**: failed mutation shows German-language error message, reverts local state. `"Änderung fehlgeschlagen. Bitte erneut versuchen."` **[C]**
- **In-flight mutation lock**: while a create, edit, or state-changing request is in flight for a form or dialog, the submit action is disabled, every input in the form is disabled, and the enclosing modal cannot be closed by the user (Escape, close button, backdrop). The lock also covers any user-confirmation dialog that precedes the request dispatch, so a submit initiated behind an open confirmation dialog cannot fire a second time. The lock releases when the request resolves (success or failure).
- **Stale-write recovery**: a versioned edit ([data-model.md §6.4](../data-model.md#64-concurrency)) carries the entity version its edit started from — the version displayed when the form or the confirmation dialog opened, advanced only by the form's own successful save. A background refresh (realtime invalidation, refetch) never advances it. A `VERSION_CONFLICT` response (see [api.md §14.4](../api.md#144-error-handling)) refetches the entity, resets the form to the refetched values, and surfaces `"Inzwischen geändert. Die aktuelle Fassung wurde geladen – bitte erneut versuchen."` **[C]** via the mutation error banner. No auto-retry, no merge.
- **Idempotency-conflict recovery**: a response with the idempotency-conflict error code (see [api.md §14.4](../api.md#144-error-handling)) closes the create form, refreshes the affected list so the stored row becomes visible, and surfaces the German error message via the mutation error banner. The form does not auto-retry.

### 9.7 Modal Interaction

All modals close on Escape (equivalent to the cancel action). Form modals submit the primary action on Enter when focus is within the form. Modals without a primary action — read-only detail views, success-state confirmations — accept Escape but do not submit on Enter.

Form modals and confirmation dialogs do not close on backdrop click — only via Escape or the explicit cancel action. Non-editing side panels close on backdrop click as the cancel equivalent.

While a mutation is in flight, close paths (Escape, explicit cancel, close button, backdrop) are suspended per the in-flight mutation lock in [§9.5](#95-asynchronous-mutation-behavior).
