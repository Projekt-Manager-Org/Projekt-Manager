# Verification

---

## 15. Acceptance Criteria

The system is accepted when all of the following are true. Each test cites the IDs of the criteria it verifies.

Every criterion carries exactly one tier marker:

- **`[crit]`** — **Critical**: a defect means data corruption, financial impact, authentication/authorization failure, data integrity violation, or misleading state that causes wrong user decisions. Verified by automated test. The method matches the contract's surface — unit, integration, E2E or a mix thereof.
- **`[vis]`** — **Visual / Design**: specifies expected behavior that does not guard a critical path. Verified by structural E2E as well as regular human review.
- **`[infra]`** — **Infrastructure**: a property of the deployed environment. Verified by deployment procedures or review — not by tests against the running system.

**IDs.** An ID's meaning never changes, and an ID is never reused.

- Split → the old ID retires; every part gets a new ID. A narrowed ID would keep stale citations resolving.
- Merge of duplicates → the survivor keeps its ID; the other retires.
- Delete → the ID retires.

**Shape.** One AC states one behavior, in one of these forms (EARS):

- `When <trigger>, the system <response>.`
- `If <unwanted condition>, the system <response>.`
- `While <state>, the system <response>.`
- `The system <property>.`

What an AC carries and where the rest goes: [index.md § Placement](index.md#placement).

### 15.1 Workflow Board

States, their order and per-state values: [index.md §3](index.md#3-workflow-states). What the screens show: [ui/workflow-views.md](ui/workflow-views.md).

- **AC-7** `[crit]`: When a user changes a planned date in the detail panel, the system stores it.
- **AC-11** `[vis]`: Action-state columns are visually distinct from buffer-state columns.
- **AC-12** `[vis]`: Each state has one color, the same on card dots, calendar bars and the detail panel badge.
- **AC-44** `[vis]`: When a user clicks a collapsed column, it expands; clicking its header again collapses it.
- **AC-452** `[vis]`: The board shows one column per workflow state, in [index.md §3](index.md#3-workflow-states) order.
- **AC-453** `[vis]`: Each project on the board sits in the column of its state.
- **AC-454** `[vis]`: The board orders each column's cards by entry date, oldest first.
- **AC-455** `[vis]`: The calendar shows a project with a planned start and end as a bar spanning those dates.
- **AC-456** `[vis]`: The calendar shows a project with a planned start and no end as a one-day block on its start date.
- **AC-457** `[crit]`: When a user clicks a card's forward or backward button, the system asks for confirmation, naming the current and the target state.
- **AC-458** `[crit]`: When a user confirms a transition, the system stores the target state as the project's state.
- **AC-459** `[crit]`: If a transition request breaks the transition rule of [index.md §3](index.md#3-workflow-states), the system refuses it as a validation error ([api.md §14.4.1](api.md#1441-error-categories)) and changes nothing.
- **AC-460** `[vis]`: A card offers the forward and backward buttons only where [index.md §3](index.md#3-workflow-states) allows the transition.
- **AC-461** `[vis]`: While a project has been in an action or buffer state for at least that state's aging threshold, counted in calendar days, its card shows the entry date in bold.
- **AC-462** `[vis]`: While a project has been in a buffer state for at least its aging threshold, its card shows "seit X Tagen", X being the days in that state.
- **AC-463** `[vis]`: While a buffer column holds projects at or past its aging threshold, its header signals them: with their count and the threshold when expanded, with a marker when collapsed.
- **AC-464** `[vis]`: While projects without planned dates exist, the calendar shows their count.
- **AC-465** `[vis]`: When a user clicks the calendar's no-dates counter, the system shows the board with only the projects that have no planned dates.
- **AC-466** `[vis]`: When a user clicks "Filter aufheben", the system removes the no-dates filter.
- **AC-467** `[vis]`: When a user switches views, the system removes the no-dates filter.
- **AC-468** `[vis]`: The system shows dates in the configured display format ([`[C]`](architecture.md#122-company-configurable-settings), default DD.MM.YYYY); a range within one year shortens its start to DD.MM.
- **AC-469** `[vis]`: Calendar weeks start on Monday.
- **AC-470** `[vis]`: When the board is too narrow for all its columns expanded, the system collapses columns by tier ([index.md §3](index.md#3-workflow-states)), highest tier first.
- **AC-471** `[vis]`: When a user clears the planned start in the detail panel while a planned end is set, the system clears both.
- **AC-472** `[vis]`: When a user opens the Project Detail Page from the detail panel and then navigates back, the system shows the view the panel was opened from.
- **AC-473** `[vis]`: While the viewport is wider than 768 px, when a user clicks a project on the board or in the calendar, the system opens its detail panel ([ui/workflow-views.md §8.4](ui/workflow-views.md#84-project-detail-panel)).
- **AC-474** `[vis]`: While the viewport is at most 768 px wide, when a user clicks a project on the board or in the calendar, the system opens its Project Detail Page ([ui/project-detail.md §8.15](ui/project-detail.md#815-project-detail-page)).

### 15.4 Authentication

What the login screen shows: [ui/index.md §8.1.1](ui/index.md#811-unauthenticated-state). Sessions: [data-model.md §5.4](data-model.md#54-session).

- **AC-573** `[crit]`: While a user is not signed in, the system shows only the login screen.
- **AC-574** `[crit]`: If a request to read or change protected data carries no session, the system refuses it as an authentication error.
- **AC-23** `[crit]`: If a user submits invalid credentials, the system shows a generic error message in German.
- **AC-24** `[vis]`: While a user is signed in, the header shows their display name.
- **AC-25** `[crit]`: When a user clicks "Abmelden", the system signs them out and shows the login screen.
- **AC-26** `[crit]`: If a user presses the browser back button after signing out, the system shows no project data.
- **AC-27** `[crit]`: If an open app's session expires or is ended elsewhere, the system shows the login screen with an expiry message within one heartbeat interval **[C]** ([architecture.md §12.2](architecture.md#122-company-configurable-settings)) plus 30 seconds.
- **AC-572** `[crit]`: If a request carries an expired session token, the system refuses it as an authentication error.
- **AC-28** `[crit]`: If a request carries a valid session token of a deactivated user, the system refuses it as an authentication error.
- **AC-395** `[vis]`: While a session is valid, reloading the app keeps the user signed in.
- **AC-39** `[crit]`: When a user signs in, the system issues a session that lasts the session duration **[C]** ([data-model.md §5.4](data-model.md#54-session)).
- **AC-396** `[crit]`: If a login attempt fails — unknown username, wrong password, or deactivated account — the system returns the same error.
- **AC-566** `[crit]`: When a user submits valid credentials, the system signs them in and shows the landing view of their role ([ui/index.md §8.7.1](ui/index.md#871-views)).
- **AC-547** `[crit]`: When a user submits their correct current password and a new one, the system stores the new password.
- **AC-548** `[crit]`: If the submitted current password is wrong, the system refuses the change and keeps the password.
- **AC-549** `[crit]`: When a user changes their own password, the system ends that user's other sessions and keeps the current one.
- **AC-550** `[crit]`: If a password set on create, change or reset violates the password policy ([data-model.md §5.3](data-model.md#53-user-entity)), the system refuses it as a validation error and stores nothing.
- **AC-568** `[crit]`: The system applies a self-update only to the caller's own record and only to `themePreference` and `pushMuted`.
- **AC-569** `[crit]`: If the first-run bootstrap password violates the password policy, the system refuses to start ([ADR-0010](../adr/0010-first-run-admin-bootstrap.md)).
- **AC-551** `[crit]`: When a user signs out, the system ends that session only.
- **AC-772** `[crit]`: If a client address makes more sign-in attempts, or more password-change attempts, in one minute-long window than the rate limit **[C]** ([architecture.md §12.2](architecture.md#122-company-configurable-settings)) allows, the system refuses that address's excess as rate limited ([api.md §14.4.1](api.md#1441-error-categories)).
- **AC-781** `[crit]`: The system issues each session a token of at least 128 bits from a cryptographically secure random source that carries no user data.
- **AC-784** `[crit]`: When the system accepts or rejects a sign-in's credentials, it writes a line to the operational log naming the username and the client address.
- **AC-786** `[crit]`: When a user's password is changed or reset, the system writes a line to the operational log naming the user and, for a reset, who reset it.
- **AC-552** `[crit]`: The system delivers the session token only in a cookie that page scripts cannot read and the browser withholds from cross-site requests ([ADR-0005](../adr/0005-session-management-httponly-cookies.md)).

### 15.5 Multi-User

- **AC-29** `[crit]`: When a user's change is saved, every other signed-in user who may see it sees it after reloading.

### 15.6 Deployment

- **AC-30** `[infra]`: While the HTTP-only evaluation mode is off, the deployed system serves the application only over HTTPS ([ADR-0013](../adr/0013-http-only-evaluation-mode.md)).
- **AC-31** `[infra]`: The operator can deploy a CI-built image to the hosted environment over VPN ([ADR-0012](../adr/0012-manual-pull-based-deploy-over-wireguard.md)).
- **AC-765** `[crit]`: If the HTTP-only evaluation mode is turned on in production, the system refuses to start ([ADR-0013](../adr/0013-http-only-evaluation-mode.md)).
- **AC-766** `[crit]`: While a page is loaded over plain HTTP from a host other than `localhost` or `127.0.0.1`, the system shows a non-dismissible warning banner on it ([ADR-0013](../adr/0013-http-only-evaluation-mode.md)).
- **AC-775** `[crit]`: While the HTTP-only evaluation mode is off, the deployed system marks the session cookie to be sent only over HTTPS ([ADR-0005](../adr/0005-session-management-httponly-cookies.md)).
- **AC-776** `[crit]`: While the HTTP-only evaluation mode is off, the system tells the browser in every application response to reach the site, its subdomains included, only over HTTPS for the next 180 days.
- **AC-777** `[vis]`: While the HTTP-only evaluation mode is on, the system lets a user sign in and use the application over plain HTTP ([ADR-0013](../adr/0013-http-only-evaluation-mode.md)).
- **AC-778** `[vis]`: While a page is loaded over plain HTTP from a host other than `localhost` or `127.0.0.1`, the system starts its tab title with `UNSICHER – `.
- **AC-764** `[crit]`: If seeding is turned on while the system runs in production, the system changes no stored data: it neither wipes data nor loads the demo dataset ([ADR-0010](../adr/0010-first-run-admin-bootstrap.md)).
- **AC-771** `[infra]`: If an image of the version being deployed is unavailable, the deploy aborts and the previously running version keeps running.
- **AC-47** `[infra]`: The operator can redeploy an earlier commit while its image is retained ([ADR-0011 § Retention](../adr/0011-build-images-in-ci-distribute-via-ghcr.md)).
- **AC-48** `[infra]`: If the post-deploy health check fails (database, object storage, or HTTPS through the reverse proxy), the deploy aborts and reports the failure.
- **AC-49** `[infra]`: The hosted environment is reachable only over VPN ([ADR-0008](../adr/0008-vpn-first-network-access.md)).
- **AC-50** `[infra]`: Stored data — database and object storage — survives container restarts and redeploys.
- **AC-51** `[infra]`: Every deploy is pinned to one commit SHA, never a moving tag.
- **AC-769** `[crit]`: The system logs a failed request at error level if and only if it fails it as a server error ([api.md §14.4.1](api.md#1441-error-categories)).

### 15.11 Customer Management

- **AC-518** `[crit]`: When a user creates a customer with a name, the system stores it.
- **AC-539** `[vis]`: When a user has created a customer, the customer list shows it, unless the active search excludes it.
- **AC-124** `[crit]`: When a customer create is retried after its response was lost, the system stores the customer once.
- **AC-519** `[crit]`: When a user saves the customer edit form, the system stores the entered values, an emptied phone, email, USt-IdNr. or notes as empty, and an address with all three fields emptied as no address.
- **AC-520** `[crit]`: If a save would leave a customer without a name, the system refuses it as a validation error ([api.md §14.4.1](api.md#1441-error-categories)) and changes nothing.
- **AC-537** `[crit]`: If a save would store a customer name of only whitespace, the system refuses it as a validation error ([api.md §14.4.1](api.md#1441-error-categories)) and changes nothing.
- **AC-538** `[crit]`: If a save would exceed a customer field limit ([§5.6](data-model.md#56-customer-entity)), the system refuses it as a validation error ([api.md §14.4.1](api.md#1441-error-categories)) with a German message and changes nothing.
- **AC-521** `[crit]`: If a save would store a customer address missing its street, zip or city, the system refuses it as a validation error ([api.md §14.4.1](api.md#1441-error-categories)) with a German message and changes nothing.
- **AC-522** `[vis]`: The customer create and edit forms offer USt-IdNr. and notes.
- **AC-524** `[vis]`: When a user types in the customer list search, the system shows only customers whose name contains the text, ignoring letter case.
- **AC-525** `[vis]`: When a user clicks a column header of the customer list, the system sorts the list by that column; clicking it again reverses the order.
- **AC-526** `[vis]`: When a user clicks a customer row, the system opens that customer's edit form.
- **AC-527** `[vis]`: While a user types a name in the customer create form, the system lists existing customers whose name contains the text, ignoring letter case.
- **AC-528** `[vis]`: When a user picks a customer listed in the create form, the system closes the form and opens that customer's edit form.
- **AC-529** `[vis]`: If the name search in the customer create form fails, the system lists nothing, shows no error, and the form keeps working.
- **AC-536** `[vis]`: When a user submits a name that a customer listed in the create form also has, ignoring letter case and surrounding whitespace, the system creates the customer only after the user confirms with "Trotzdem erstellen"; cancelling returns to the form and creates nothing.
- **AC-85** `[vis]`: When a user has created a customer, the system lets them create a project for it without a page reload.
- **AC-530** `[crit]`: When a user deletes a customer with no active project and no issued or cancelled invoice, the system removes it.
- **AC-531** `[crit]`: When the system removes a customer ([AC-530](#1511-customer-management)), it permanently deletes the customer's archived projects with it, with their worker assignments and draft invoices ([ADR-0017](../adr/0017-soft-delete-as-board-archive.md)).
- **AC-540** `[crit]`: When a customer delete removes archived projects, the system deletes their attachments and hides their stored objects ([ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md)).
- **AC-541** `[crit]`: If a customer delete fails part-way, the system changes nothing.
- **AC-92** `[crit]`: If a customer has an active project, the system refuses deleting the customer as a conflict ([api.md §14.4.1](api.md#1441-error-categories)) and changes nothing.
- **AC-532** `[crit]`: If a customer without an active project has an issued or cancelled invoice on an archived project, the system refuses deleting the customer as a conflict ([api.md §14.4.1](api.md#1441-error-categories)) with a German message saying why and changes nothing ([ADR-0026](../adr/0026-invoices-immutability-and-zugferd.md)).
- **AC-534** `[crit]`: When a user starts deleting a customer with archived projects, the confirmation warns that they will be permanently deleted with it and names their count.
- **AC-535** `[vis]`: When a user starts deleting a customer without archived projects, the confirmation names the customer.
- **AC-533** `[crit]`: If the archived-project count cannot be loaded when a user starts deleting a customer, the system shows the error and opens no confirmation.

### 15.12 Projects

Fields: [data-model.md §5.1](data-model.md#51-project-entity). What the screens show: [ui/management.md §8.8](ui/management.md#88-project-management-view), [ui/project-detail.md §8.15](ui/project-detail.md#815-project-detail-page). Who may do what: [api.md §14.3](api.md#143-authorization-rules).

- **AC-475** `[crit]`: When a user creates a project with a number, title and customer, the system stores it in the first workflow state.
- **AC-476** `[crit]`: If a user creates a project with a number another project already has, archived ones included, the system refuses it as a conflict ([api.md §14.4.1](api.md#1441-error-categories)) with a German message naming the number, and creates nothing.
- **AC-477** `[crit]`: When a project create is retried after its response was lost, the system stores the project once.
- **AC-478** `[vis]`: When a user leaves the number field of the create form or of the email intake review form, or that review form opens, the system shows whether another project, archived ones included, already uses the number the form would save; if the check fails, it shows no verdict.
- **AC-479** `[vis]`: The free / taken verdict of the number field always refers to the number the form would save.
- **AC-480** `[crit]`: When a user edits the title, a planned date, the estimated value or the notes on the Project Detail Page, the system stores the change.
- **AC-511** `[vis]`: When a user clears the planned start on the Project Detail Page while a planned end is set, the system clears both.
- **AC-482** `[crit]`: If a date change would leave a planned end without a planned start, or before it, the system refuses it as a validation error ([api.md §14.4.1](api.md#1441-error-categories)) with a German message and changes nothing.
- **AC-481** `[crit]`: When a user adds or removes an assigned worker on the Project Detail Page, the system stores the new assignment.
- **AC-515** `[crit]`: If a project create or edit would assign a user who is not an active worker, the system refuses it as a validation error ([api.md §14.4.1](api.md#1441-error-categories)) with a German message and changes nothing. A worker already assigned stays assigned after deactivation.
- **AC-483** `[crit]`: When a user saves the Baustelle group with "Identisch mit Kundenadresse" on, the system stores no site address for the project.
- **AC-484** `[crit]`: When a user saves the Baustelle group with the toggle off, the system stores the entered street, zip and city as the project's site address.
- **AC-485** `[crit]`: If a save would store a site address missing its street, zip or city, the system refuses it as a validation error ([api.md §14.4.1](api.md#1441-error-categories)) with a German message and changes nothing.
- **AC-486** `[vis]`: The create form's Baustelle toggle starts on.
- **AC-510** `[vis]`: When a user edits a project's Baustelle, the toggle starts off, with the address filled in, exactly when the project has its own site address.
- **AC-487** `[vis]`: While the Baustelle toggle is on, the address inputs are disabled and show the customer's address.
- **AC-488** `[vis]`: When a user switches the Baustelle toggle, the system changes nothing stored until the user saves.
- **AC-489** `[vis]`: While a project has its own site address, its Baustelle line shows it.
- **AC-490** `[vis]`: While a project has no site address and its customer has an address, the Baustelle line shows the customer's address followed by "(Kundenadresse)".
- **AC-491** `[vis]`: While neither the project nor its customer has an address, the Baustelle line reads "Keine Adresse".
- **AC-283** `[vis]`: The Baustelle line carries exactly one map link, to the address it shows; with no address shown, it carries none.
- **AC-492** `[vis]`: While "Archivierte einblenden" is on, the project list also shows archived projects.
- **AC-153** `[vis]`: While "Archivierte einblenden" is on, the project list marks each archived project with an `Archiviert` badge and muted text; active projects carry neither.
- **AC-493** `[vis]`: When a user types in the project list search, the system shows only projects whose number, title or customer name contains the text, ignoring letter case.
- **AC-494** `[vis]`: When a user clicks a sortable column header of the project list, the system sorts the list by that column; clicking it again reverses the order.
- **AC-495** `[vis]`: When a user selects workers or "Nicht zugewiesen" in the Mitarbeiter filter, the system shows only projects assigned to a selected worker, plus those without workers if "Nicht zugewiesen" is selected.
- **AC-496** `[vis]`: When a user clicks a project row in the project list, the system opens its Project Detail Page.
- **AC-497** `[crit]`: When a user archives a project, the system removes it from the board, the calendar and the default project list.
- **AC-498** `[crit]`: When a user restores an archived project, the system makes it active again, in the state it had.
- **AC-512** `[crit]`: If a user restores a project that is not archived, the system refuses it as a conflict ([api.md §14.4.1](api.md#1441-error-categories)) and changes nothing.
- **AC-499** `[crit]`: If a request would change an archived project — a transition, an edit, its dates, its workers, or archiving it again — the system refuses it as not found ([api.md §14.4.1](api.md#1441-error-categories)) and changes nothing.
- **AC-506** `[vis]`: When a user clicks `Archivieren` or `Wiederherstellen`, the system asks for confirmation naming the project.
- **AC-501** `[vis]`: The system offers `Endgültig löschen` only on archived projects.
- **AC-505** `[crit]`: When a user clicks `Endgültig löschen`, the system asks for confirmation naming the project and warning that its data is lost for good.
- **AC-502** `[crit]`: When a user permanently deletes an archived project, the system removes it with its worker assignments and draft invoices; its attachments go per [AC-428](#1526-attachments).
- **AC-503** `[crit]`: If a user permanently deletes a project that is not archived, the system refuses it as a conflict ([api.md §14.4.1](api.md#1441-error-categories)) and changes nothing.
- **AC-504** `[crit]`: If an archived project has an issued or cancelled invoice, the system refuses its permanent deletion as a conflict ([api.md §14.4.1](api.md#1441-error-categories)) with a German message giving that reason, and changes nothing.
- **AC-509** `[vis]`: When a user who may read a project ([api.md §14.3](api.md#143-authorization-rules), [AC-581](#1521-role-scoping)) opens its Project Detail Page, the system shows it.
- **AC-507** `[vis]`: If a worker opens the Project Detail Page of a project they are not assigned to, the system shows the not-permitted surface ([AC-149](#1521-role-scoping)).
- **AC-508** `[vis]`: If a user opens the Project Detail Page of a project that does not exist, the system shows a not-found message.
- **AC-500** `[vis]`: While a project is archived, its Project Detail Page shows an archived notice and offers no change other than `Wiederherstellen` and `Endgültig löschen`.
- **AC-207** `[vis]`: While the detail panel is open, it offers `Öffnen`, which opens the project's Project Detail Page.
- **AC-277** `[crit]`: When a project changes — its customer and assigned workers included — every open view showing the project shows the change within 2 seconds, without a reload.

### 15.13 User Management

Fields and password policy: [data-model.md §5.3](data-model.md#53-user-entity). What the view shows: [ui/management.md §8.10](ui/management.md#810-user-management-view).

- **AC-63** `[crit]`: When an owner creates a user with username, display name, password and roles, the system stores the account and the user can log in with those credentials.
- **AC-66** `[crit]`: When an owner reactivates a deactivated user, the system marks the account active and the user can log in again.
- **AC-68** `[crit]`: If a user tries to deactivate their own account, the system refuses it and changes nothing.
- **AC-575** `[crit]`: If a user's edit of their own roles would leave them without `user:manage`, the system refuses it as a validation error ([api.md §14.4.1](api.md#1441-error-categories)) and changes nothing.
- **AC-394** `[crit]`: The system never sends a password hash to a client, except inside an export archive ([data-model.md §5.8](data-model.md#58-export-archive)).
- **AC-553** `[crit]`: When an owner changes a user's display name, roles or email, the system stores them.
- **AC-554** `[vis]`: The user panel offers display name, roles and email for editing.
- **AC-555** `[crit]`: When an owner deactivates a user, the system marks the account inactive.
- **AC-570** `[crit]`: When an owner deactivates a user, the system ends all that user's sessions.
- **AC-556** `[crit]`: When an owner resets a user's password, the system stores the new password without asking for the current one.
- **AC-557** `[crit]`: When an owner resets a user's password, the system ends all that user's sessions.
- **AC-558** `[crit]`: If a user tries to delete their own account, the system refuses it and changes nothing.
- **AC-559** `[crit]`: When an owner deletes a user, the system removes the account with its sessions and worker assignments.
- **AC-567** `[crit]`: When an owner deletes a user, the system keeps the records that user created or last edited and clears those references, except on other user accounts ([data-model.md §6.6](data-model.md#66-referential-integrity)).
- **AC-560** `[crit]`: If an owner deletes a user whom an issued or cancelled invoice names as creator or last editor, the system refuses it with a German message pointing to deactivation and changes nothing.
- **AC-561** `[crit]`: When an owner deletes a user whom only draft invoices name, the system deletes the user and clears those references on the drafts.
- **AC-562** `[vis]`: The system admits only users with `user:manage` to the user management view; `user:read` alone is not enough.
- **AC-563** `[vis]`: The user management view lists all users, including deactivated ones.
- **AC-571** `[vis]`: The user management view shows deactivated users as visually distinct.
- **AC-564** `[crit]`: If an owner creates a user with a username already in use, the system refuses it and creates nothing.
- **AC-565** `[crit]`: If a user create or edit violates a blank, length or role-set constraint of [data-model.md §5.3](data-model.md#53-user-entity), the system refuses it as a validation error and changes nothing.

### 15.14 Data Exchange

Export and import of the whole deployment. Archive format: [data-model.md §5.8](data-model.md#58-export-archive); job states: [§5.18](data-model.md#518-data-exchange-job); screens: [ui/daten.md §8.11](ui/daten.md#811-daten-view).

- **AC-142** `[vis]`: The Daten navigation tab is hidden for users without `data:export`.
- **AC-583** `[crit]`: When a user starts an export, the system builds an archive of the deployment in the format of [data-model.md §5.8](data-model.md#58-export-archive).
- **AC-584** `[crit]`: The system puts into an export archive exactly the attachment files its data lists.
- **AC-585** `[crit]`: If an attachment's content cannot be read while an export is built, the system ends the export as failed, naming the attachment, and offers no archive.
- **AC-586** `[vis]`: When an export is ready, the Daten view offers its archive for download.
- **AC-608** `[vis]`: When an export's archive has been deleted, the Daten view no longer offers its download and offers to start a new export.
- **AC-587** `[vis]`: When an export or import fails, the Daten view shows the failure reason.
- **AC-588** `[crit]`: When the download of an export is interrupted, the system lets it resume where it stopped.
- **AC-589** `[crit]`: When the takeout staging TTL **[C]** has passed since an export or import ended, the system deletes the archive it holds for that job.
- **AC-590** `[crit]`: When an export or import starts, the system deletes the archives it holds for earlier jobs of the same kind.
- **AC-331** `[crit]`: While an export or import is in progress, the system refuses to start another of the same kind as a conflict ([api.md §14.4.1](api.md#1441-error-categories)); an ended one does not block a new start.
- **AC-601** `[vis]`: When a user starts an export or import while one of the same kind is in progress, the Daten view shows the one in progress.
- **AC-602** `[vis]`: While an export or import is in progress, the Daten view shows its progress as it advances.
- **AC-603** `[vis]`: When a user opens the Daten view while an export or import is in progress, the view shows its progress.
- **AC-600** `[crit]`: If the server restarts while an export or import is in progress, the system ends it as failed.
- **AC-332** `[crit]`: When an export or import ends, the system records exactly one audit entry for it.
- **AC-161** `[vis]`: The Import dialog shows an input for the confirmation phrase **[C]** and keeps its start action disabled until the typed text matches the phrase.
- **AC-591** `[crit]`: If an import would replace a deployment that holds customers, projects, invoices or attachments and does not confirm the replacement, the system refuses it as a conflict ([api.md §14.4.1](api.md#1441-error-categories)) before the archive is uploaded and changes nothing.
- **AC-592** `[crit]`: If the confirmation that [AC-591](#1514-data-exchange) requires does not match the confirmation phrase **[C]**, the system refuses it as a validation error ([api.md §14.4.1](api.md#1441-error-categories)) before the archive is uploaded and changes nothing.
- **AC-605** `[vis]`: While no import is in progress, when a user picks an archive to import, the Daten view shows the confirmation for it, never the result of an earlier import.
- **AC-606** `[vis]`: While the viewport is narrower than the mobile-warning breakpoint **[C]**, the Export and Import dialogs show the large-transfer warning and still let the user start.
- **AC-599** `[crit]`: If an import's upload makes no progress for the takeout staging TTL **[C]**, the system ends the import as failed and deletes the partial upload.
- **AC-609** `[crit]`: While an import's upload is in progress, when a user picks an archive whose size equals the upload's total size and confirms it ([AC-161](#1514-data-exchange)), the system continues the upload where the server stopped.
- **AC-610** `[vis]`: While an import's upload is in progress, when a user picks a file whose size differs from the upload's total size, the Import dialog says the file does not belong to the import in progress and uploads nothing.
- **AC-611** `[vis]`: While an import's upload is in progress and the open page is not uploading it, the Daten view says the upload is interrupted and how to continue it.
- **AC-593** `[crit]`: If an uploaded archive is not valid ([data-model.md §5.8](data-model.md#58-export-archive)), the system ends the import as failed, naming the reason, and changes nothing.
- **AC-367** `[crit]`: If an import would remove an issued or cancelled invoice, change its number, or put another document under its number, the system ends the import as failed and changes nothing ([data-model.md §6.14](data-model.md#614-immutability-of-issued-invoices)). A draft absent from the archive does not count.
- **AC-594** `[crit]`: When an import succeeds, the deployment holds exactly the business data and attachments of the archive, IDs included; its earlier business data, attachments and Papierkorb are gone. Invoice numbering follows [AC-369](#1514-data-exchange).
- **AC-369** `[crit]`: When an import restores invoice numbering, the system never lowers it: per year and kind, the next number is the higher of the deployment's and the archive's, and a year and kind the archive lacks keeps the deployment's ([data-model.md §6.13](data-model.md#613-gapless-sequence-allocation)).
- **AC-365** `[crit]`: When an import restores an invoice with a rendered PDF, the system restores the PDF byte-equal as that invoice's document — off the attachment surface ([AC-364](#1530-invoices)) and under the invoice lock ([AC-710](#1530-invoices)).
- **AC-595** `[crit]`: If an import cannot restore every attachment of the archive, the system ends it as failed.
- **AC-596** `[vis]`: When an import restores a photo, the system generates its thumbnail anew.
- **AC-597** `[crit]`: When an import replaces the users, the system ends every session.
- **AC-598** `[crit]`: When an import ends the importing user's session, the system continues the import.
- **AC-604** `[vis]`: When a user opens the Daten view after an import ended, the view shows the latest import's result until the user closes it; a page load shows it again.
- **AC-607** `[vis]`: When an import succeeds, the Daten view shows the number of files it restored.

### 15.15 Navigation and Interaction

- **AC-75** `[vis]`: The navigation shows a user exactly the views their roles may access ([ui/index.md §8.7.1](ui/index.md#871-views)).
- **AC-751** `[vis]`: When a user picks a view in the navigation, the system shows it without reloading the page.
- **AC-752** `[vis]`: While the viewport is at most 768 px wide, every navigation entry outside `Verwaltung` is one tap away from any view.
- **AC-753** `[vis]`: The Meine Projekte view lists the worker's assigned projects under `Heute` (a planned date is today, or the planned span covers today), `Demnächst` (planned start after today) and `Weitere` (the rest); each group by planned start, undated last.
- **AC-754** `[crit]`: If a change the user made outside a dialog fails, the system shows the stored values, not the attempted ones.
- **AC-755** `[crit]`: If a user's change fails, the system shows a German error message.
- **AC-756** `[crit]`: While a change submitted from a dialog is in flight, the system sends no second request for it — neither from a repeated submit nor from its confirmation dialog.
- **AC-757** `[crit]`: While a change submitted from a dialog is in flight, the dialog's fields cannot be edited and the dialog cannot be closed.
- **AC-758** `[vis]`: When the user presses Escape, the system closes the topmost open dialog or side panel and discards its unsaved input.
- **AC-759** `[vis]`: When the user presses Enter in a single-line field of a create or edit dialog, the system submits the dialog.
- **AC-760** `[vis]`: If the user clicks outside a form or confirmation dialog, the system keeps it open.
- **AC-761** `[vis]`: When the user clicks outside the project panel, the system closes it.

### 15.17 Data Integrity

- **AC-94** `[crit]`: If a user transitions a project whose state is no longer the one they loaded, the system refuses it as a conflict ([api.md §14.4.1](api.md#1441-error-categories)) and changes nothing.
- **AC-375** `[crit]`: If a user saves a customer, saves or discards an invoice draft, or saves the company profile, and another change was saved to it after they loaded it, the system refuses it as a conflict and changes nothing ([data-model.md §6.4](data-model.md#64-concurrency)).
- **AC-379** `[crit]`: If a user saves a customer, invoice draft or company profile form whose record changed after the form opened, the system shows a German message saying so and the current values, and sends nothing more.
- **AC-381** `[crit]`: If two saves, discards or issues of the same customer, invoice draft or company profile run at once from the same loaded state, the system applies exactly one and refuses the other, which changes nothing.
- **AC-763** `[crit]`: If a stale change is also refused because its target is archived ([AC-499](#1512-projects), [AC-513](#1530-invoices)) or frozen ([AC-709](#1530-invoices)), the system reports that refusal, not the stale one.
- **AC-770** `[crit]`: If another user changed a project after a user loaded it, the system applies the user's later edit of its title, site address, estimated value, notes, planned dates or assigned workers rather than refusing it as stale.
- **AC-96** `[crit]`: The system never holds a project whose status is not a workflow state, a database write bypassing the application included.
- **AC-97** `[crit]`: The system never holds a project whose planned end precedes its planned start, a database write bypassing the application included.
- **AC-99** `[crit]`: If assigning the workers fails while a project is created, the system creates no project.
- **AC-127** `[crit]`: If a customer or project create carries the ID of an existing record but differs from it, the system refuses it as an idempotency conflict and changes nothing.
- **AC-762** `[vis]`: If saving the Create Project ([ui/management.md §8.8.2](ui/management.md#882-create-project)) or Create Customer ([§8.9.2](ui/management.md#892-create-customer)) form is refused as an idempotency conflict, the system closes the form and shows the current list with a German message.
- **AC-516** `[crit]`: If a request body carries a field the operation does not define, at any depth, the system refuses it as a validation error and changes nothing.

### 15.18 Email Data Intake

Screen: [ui/email-intake.md §8.12](ui/email-intake.md#812-email-data-intake). Who may extract: [api.md §14.3](api.md#143-authorization-rules).

- **AC-734** `[vis]`: While email extraction is not configured ([architecture.md §12.6](architecture.md#126-feature-manifest-and-operator-confidence)), the system shows no email intake entry point.
- **AC-106** `[vis]`: While the email text is blank or an extraction is in flight, the system disables the extract action.
- **AC-102** `[crit]`: If the email text is blank or longer than 50,000 characters, the system refuses the extraction as a validation error.
- **AC-737** `[crit]`: When the user extracts, the system sends the extraction service the pasted email text and no stored data ([ADR-0016](../adr/0016-llm-email-extraction-via-server-proxied-openrouter.md)).
- **AC-732** `[vis]`: When an extraction succeeds, the system fills the review form's fields with what it found in the email and leaves the rest empty.
- **AC-739** `[crit]`: When an extraction succeeds, the system stores nothing until the user saves the review form.
- **AC-738** `[crit]`: If email extraction is not configured, the system refuses email text within the [AC-102](#1518-email-data-intake) bounds as a server error that names no configuration.
- **AC-733** `[crit]`: If the extraction service fails or returns an unusable answer, the system refuses the extraction as a server error that names neither the service nor its answer.
- **AC-735** `[crit]`: When the user saves the review form, the system creates the customer unless an existing one is selected, then a project for that customer if a title is given.
- **AC-736** `[crit]`: If creating the project fails after the customer was created, the system keeps the customer and uses it when the user saves again.

### 15.19 Theming

The preference values: [data-model.md §5.3](data-model.md#53-user-entity). The selector: [ui/index.md §8.7.2](ui/index.md#872-user-menu).

- **AC-116** `[crit]`: When a user changes their own theme preference, the system stores it.
- **AC-118** `[crit]`: If a submitted theme preference is not one of its values, the system refuses it as a validation error ([api.md §14.4.1](api.md#1441-error-categories)) and changes nothing.
- **AC-740** `[vis]`: When a user selects a theme in the user menu, the system renders it without a reload.
- **AC-749** `[vis]`: While the applied theme preference is `light` or `dark`, the system renders that theme regardless of the operating-system color scheme.
- **AC-112** `[vis]`: While the applied theme preference is `system`, the system follows the operating-system color scheme, including its changes, without a reload.
- **AC-120** `[vis]`: When a user signs in or the app loads with a valid session, the system applies the user's stored theme preference, whatever this device applied before.
- **AC-750** `[vis]`: When the app loads, its first frame shows the theme preference this device last applied, or `system` if there is none.
- **AC-741** `[vis]`: While no user is signed in, the system applies the theme preference this device last applied, or `system` if there is none.
- **AC-742** `[vis]`: While the dark theme applies, the system renders every screen with dark surfaces.
- **AC-748** `[vis]`: The system renders text with WCAG AA contrast against its surface — 4.5:1, large text 3:1 — in both themes.
- **AC-114** `[vis]`: When the brand accent **[C]** changes, the system shows the new value on every accent-using surface — primary actions, links, focus rings, selection highlights, form input indicators — in both themes.

### 15.20 Branding

The values and the surfaces each one reaches: [architecture.md §12.2](architecture.md#122-company-configurable-settings).

- **AC-743** `[vis]`: The system shows each branding value **[C]** on every surface its catalogue entry names.
- **AC-744** `[vis]`: The system can be installed as an app, and every icon it declares for the installed app exists.
- **AC-745** `[vis]`: If the configured logo fails to load in the browser, the header shows what it shows with no logo configured.
- **AC-746** `[vis]`: When an invoice is rendered while a usable logo is configured, the system draws the logo in the issuer block, fit to the block with its aspect ratio kept and never enlarged.
- **AC-747** `[crit]`: If the configured logo is unusable or cannot be decoded, the system renders the invoice without a logo.

### 15.21 Role Scoping

Who may do what: [api.md §14.3](api.md#143-authorization-rules). A worker, here, is a user whose only role is `worker`.

- **AC-576** `[crit]`: If a caller lacks what [api.md §14.3](api.md#143-authorization-rules) lists for an operation, the system refuses it as an authorization error ([api.md §14.4.1](api.md#1441-error-categories)) and changes nothing.
- **AC-577** `[crit]`: The system lets a user holding any role but `worker` reach every project and every customer, whatever other roles they hold.
- **AC-579** `[crit]`: When a worker lists projects, the system returns only those the worker is assigned to.
- **AC-580** `[crit]`: When a worker lists customers, the system returns only those referenced by a non-archived project the worker is assigned to.
- **AC-581** `[crit]`: If a worker reads a project they are not assigned to, the system refuses it as an authorization error, not as not-found.
- **AC-582** `[crit]`: If a worker reads a customer that no non-archived project assigned to them references, the system refuses it as an authorization error, not as not-found.
- **AC-767** `[crit]`: If a worker's request names a project they are not assigned to, or anything belonging to one, the system refuses it ([ADR-0019](../adr/0019-worker-data-scoping-repository-layer-predicate.md)).
- **AC-768** `[crit]`: When a worker lists anything, the system returns nothing belonging to a project they are not assigned to ([ADR-0019](../adr/0019-worker-data-scoping-repository-layer-predicate.md)).
- **AC-578** `[crit]`: When a worker reads a customer, the system reveals nothing about the customer's projects or invoices beyond the worker's assigned projects.
- **AC-542** `[crit]`: When a worker reads an archived project, the system shows its customer's name and none of the customer's other details: phone, email, USt-IdNr., notes, and the address unless the project has no site address ([AC-490](#1512-projects)). Other roles see them all.
- **AC-121** `[crit]`: If a user lacks the permission a mutation needs, the system does not show the control that triggers it.
- **AC-149** `[vis]`: If a user opens by URL a view their roles may not access ([ui/index.md §8.7.1](ui/index.md#871-views)), the system shows the not-permitted surface in its place and keeps the URL.

### 15.22 Backup and Recovery

The database backup the [kickoff](../project/kickoff.md#done-when-final-product) requires; design in [ADR-0020](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md). A _backup_ is a database dump with its per-table manifest; a _drill_ restores the latest uploaded backup to prove it restores. Status record and mirror: [data-model.md §5.9](data-model.md#59-backup-status). Badge states: [ui/index.md §8.1.2](ui/index.md#812-authenticated-state).

- **AC-616** `[crit]`: While the system runs, it starts a backup at each scheduled backup time and a drill at each scheduled drill time **[C]** ([architecture.md §12.2](architecture.md#122-company-configurable-settings)).
- **AC-166** `[crit]`: When a backup's restored copy matches its source, the system uploads the backup and its manifest to the off-site store and records the run as succeeded at the run's time.
- **AC-165** `[crit]`: If a backup's restored copy differs from its source in any table, the system uploads nothing and records the run as failed, naming that table.
- **AC-344** `[crit]`: A backup and its manifest reflect one database state, so writes committed during the run do not fail its verification; a run that cannot read both from one state fails and uploads nothing ([ADR-0020](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#snapshot)).
- **AC-174** `[crit]`: Two backups of the same database state carry equal manifests.
- **AC-366** `[crit]`: If the database runs without page checksums, a backup run fails before producing a backup and names the missing checksums.
- **AC-167** `[crit]`: The off-site store receives no backup or manifest readable without the operator's private identity ([ADR-0020](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md)); a run that cannot encrypt fails and uploads nothing.
- **AC-345** `[crit]`: Every step of a backup or drill run is bounded in time; a step exceeding its bound fails the run, and the status record names the step and why — the container log does, when that step is the status write itself. The status-mirror write is the exception: exceeding its bound fails only that write ([AC-618](#1522-backup-and-recovery)).
- **AC-346** `[crit]`: If a tool a backup or drill run drives exits before taking all its input, the run fails with the reason recorded, and later scheduled runs still start.
- **AC-619** `[crit]`: When a drill runs with the operator's private identity loaded, the system restores the latest uploaded backup from the off-site store and records in the drill fields whether it matches its manifest.
- **AC-168** `[crit]`: While the operator's private identity is not loaded, a drill is skipped and leaves the status record unchanged; a skip is not a failure.
- **AC-370** `[crit]`: A backup run changes only the backup fields of the status record and a drill only the drill fields, plus `mirrorError` and `updatedAt`.
- **AC-617** `[crit]`: When a backup or drill run records its outcome, the system then rewrites the status mirror to match.
- **AC-618** `[crit]`: If writing the status mirror fails, the system records that failure in `mirrorError` and leaves the run's outcome and error field unchanged.
- **AC-622** `[crit]`: When writing the status mirror succeeds, the system clears `mirrorError`.
- **AC-620** `[crit]`: The status record carries no credential.
- **AC-614** `[crit]`: The system discloses the status record to no caller except an owner.
- **AC-612** `[crit]`: While an owner is signed in, the system shows on every view the backup badge in the first state of the badge table ([ui/index.md §8.1.2](ui/index.md#812-authenticated-state)) whose condition holds.
- **AC-621** `[crit]`: If the last drill failed, the backup badge shows red.
- **AC-785** `[vis]`: The backup badge's icon tells the states apart by more than colour.
- **AC-615** `[crit]`: While an owner's view is visible, the system refreshes the backup badge from the status record at least once a minute.
- **AC-613** `[vis]`: The system shows no backup badge on the sign-in screen or to a non-owner.
- **AC-173** `[infra]`: The off-site store keeps every backup for the retention window and protects it from deletion and overwrite for the lock window, and deletes it after the retention window ([ADR-0020 §Retention](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#retention)).
- **AC-175** `[infra]`: The operator's private identity never reaches the server's disk; a loaded identity is gone after a restart ([ADR-0020](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md)).
- **AC-774** `[crit]`: If a production deployment lacks any value the backup needs ([architecture.md §12.6](architecture.md#126-feature-manifest-and-operator-confidence)), the system refuses to start.
- **AC-368** `[infra]`: When the operator restores a backup, then before the system serves again, every attachment the restored backup has no row for, or holds as pending, is recovered where readable ([AC-441](#1526-attachments)), and no invoice number issued since the backup can be issued again ([data-model.md §6.13](data-model.md#613-gapless-sequence-allocation)); an unreadable attachment is recorded and does not block serving.

### 15.23 Audit Log

The record of changes to audited entities; design in [ADR-0021](../adr/0021-audit-log-and-notifications-single-write-path.md). What an entry holds: [data-model.md §5.10](data-model.md#510-audit-log-entity). Surfaces: the project activity feed ([ui/workflow-views.md §8.4.1](ui/workflow-views.md#841-activity-feed)), the Aktivität view ([ui/management.md §8.13](ui/management.md#813-audit-view)) and the activity dock ([§15.32](#1532-activity-dock)).

- **AC-623** `[crit]`: When a change to an audited entity takes effect, the system records exactly one audit entry for it; a change that does not take effect records none. Not recorded per entity: sign-ins and sessions ([ADR-0021](../adr/0021-audit-log-and-notifications-single-write-path.md)), self-preference changes ([AC-659](#1524-notifications)), uploads that never complete ([AC-407](#1526-attachments)), entities removed with a purged project (its purge entry covers them) and a data import, which records one entry per job ([AC-332](#1514-data-exchange)).
- **AC-624** `[crit]`: Each audit entry names who made the change: the signed-in user who made it, or the system with a non-empty reason for a change no user made directly — including the end of an export or import job ([AC-332](#1514-data-exchange)).
- **AC-630** `[crit]`: When a change updates fields, its audit entry records each updated field's value before and after the change, except passwords and encryption keys ([AC-240](#1526-attachments)).
- **AC-188** `[crit]`: An audit entry keeps the entity label it was recorded with; a later rename, deletion or purge of the entity leaves it unchanged.
- **AC-642** `[crit]`: No caller can change or delete an audit entry, except that deleting a user removes the entry's link to that user ([AC-567](#1513-user-management)); entries leave only through retention ([AC-632](#1523-audit-log)).
- **AC-632** `[crit]`: When a retention run executes, the system removes every audit entry older than the retention window **[C]** ([architecture.md §12.2](architecture.md#122-company-configurable-settings)) and records no audit entry for the removal.
- **AC-633** `[crit]`: When a retention run completes, the system writes one `audit-retention-cleanup` line to the operational log with the window applied and the number of entries removed.
- **AC-183** `[crit]`: If notifying about a recorded change fails, the change and its audit entry stay recorded, and the system writes an `audit-publisher-handler-error` line naming the entry to the operational log.
- **AC-625** `[crit]`: The system discloses every audit entry to an owner, and every entry except those of [AC-182](#1523-audit-log) to any other caller holding `audit:read`.
- **AC-182** `[crit]`: The system discloses an audit entry for a project purge, a user deletion or a change to a user's roles to no caller except an owner.
- **AC-631** `[vis]`: The project activity feed shows the audit entries of the project and of its worker assignments, attachments and invoices.
- **AC-626** `[vis]`: Every activity surface lists audit entries newest first.
- **AC-627** `[vis]`: When an activity surface has no entry to show, the system shows `Keine Aktivität` — except the Aktivität view while `Alles anzeigen` is off and no filter is set ([AC-662](#1524-notifications)).
- **AC-628** `[vis]`: When a user chooses `Ältere anzeigen`, the system appends the next older page **[C]** ([architecture.md §12.2](architecture.md#122-company-configurable-settings)) below the entries shown.
- **AC-629** `[vis]`: When a user sets valid filters on the Aktivität view, the system shows only the entries matching all of them.
- **AC-186** `[vis]`: The system offers `Details anzeigen` on an entry of the project activity feed or the Aktivität view exactly when the entry carries details ([data-model.md §5.10](data-model.md#510-audit-log-entity) `payload`); it opens in place, without leaving the view.
- **AC-641** `[vis]`: The Aktivität view and the activity dock show, for each entry, the project it belongs to ([data-model.md §5.10](data-model.md#510-audit-log-entity)), or `—` for an entry without one.
- **AC-681** `[vis]`: While the Aktivität view or a project activity feed is open, when an audit entry it would list is recorded, the entry appears in it within 2 seconds, without a manual refresh.

### 15.24 Notifications

Pushes to users' devices, by the notification rules; design in [ADR-0023](../adr/0023-notification-rules-db-stored-closed-event-catalog.md). Rules and event classes: [data-model.md §5.11](data-model.md#511-notification-rule). Who may manage rules: [api.md §14.3](api.md#143-authorization-rules). Screens: [ui/management.md §8.14](ui/management.md#814-notification-rules-view), the user menu ([ui/index.md §8.7.2](ui/index.md#872-user-menu)).

Rules and recipients:

- **AC-190** `[crit]`: If a rule save breaks a rule constraint ([data-model.md §5.11](data-model.md#511-notification-rule)), the system refuses it as a validation error ([api.md §14.4.1](api.md#1441-error-categories)) and changes nothing.
- **AC-643** `[crit]`: When the change a project event class names ([data-model.md §5.11](data-model.md#511-notification-rule)) takes effect, the system fires one event of that class.
- **AC-192** `[crit]`: The recipients of an event are the active users named by an enabled rule for its class — a rule whose `Ziel-Status`, if set, is the project's new status — each user once.
- **AC-644** `[crit]`: When a rule change takes effect, the system applies it to every event fired afterwards.
- **AC-203** `[crit]`: If a rule names a user who is deactivated or deleted, the system still pushes to the rule's other recipients and leaves the rule unchanged.
- **AC-393** `[crit]`: When a rule is created, changed or deleted, the system records no audit entry ([ADR-0023](../adr/0023-notification-rules-db-stored-closed-event-catalog.md)).

Pushes:

- **AC-645** `[crit]`: When an event fires, the system pushes it to every device its recipients registered, except where [AC-195](#1524-notifications) or [AC-321](#1524-notifications) rules it out.
- **AC-646** `[crit]`: Under standard circumstances — every push service answering — the system sends an event's pushes within 5 seconds of the event firing ([kickoff](../project/kickoff.md): delivered instantaneously).
- **AC-195** `[crit]`: While a user has push muted, the system pushes nothing to their devices; the devices stay registered, and the user stays a recipient ([AC-192](#1524-notifications)).
- **AC-321** `[crit]`: The system pushes no event to the user who caused it; that user stays a recipient ([AC-192](#1524-notifications)).
- **AC-647** `[crit]`: If pushing to one device fails, the system still pushes to the other devices.
- **AC-648** `[crit]`: A push's title is the label of its event class ([data-model.md §5.11](data-model.md#511-notification-rule)).
- **AC-649** `[crit]`: A push about a project event names the project as it was named when the event fired; for a status move it adds the new status, for an upload that a file was added.
- **AC-650** `[crit]`: A `backup.failed` push says what the backup badge says for its reason ([ui/index.md §8.1.2](ui/index.md#812-authenticated-state)).
- **AC-651** `[crit]`: A `disk.threshold_reached` push reads `Speicher zu N% belegt.`, N being the fill percentage, rounded.
- **AC-652** `[crit]`: When a user opens a push, the system opens the project's page for a project event, the Daten view for `disk.threshold_reached`, and the Kanban view for `backup.failed` ([ui/index.md §8.7.1](ui/index.md#871-views); a view the user may not access: [AC-149](#1521-role-scoping)).
- **AC-371** `[crit]`: The system records no audit entry for a `backup.failed` or `disk.threshold_reached` event, so it shows on no activity surface ([ADR-0021](../adr/0021-audit-log-and-notifications-single-write-path.md)).

Devices:

- **AC-201** `[vis]`: The system asks the browser for push permission only when the user activates `Push-Benachrichtigungen aktivieren`.
- **AC-674** `[crit]`: When a user activates `Push-Benachrichtigungen aktivieren` and the browser grants permission, the system registers the device for the user.
- **AC-653** `[vis]`: If registering the device fails, the system shows a message naming the failure — e.g. `Anmeldung für Push-Benachrichtigungen fehlgeschlagen.` or `Push-Benachrichtigungen sind auf diesem Server nicht konfiguriert.` — and keeps offering `Push-Benachrichtigungen aktivieren`.
- **AC-675** `[crit]`: When a user activates `Gerät abmelden`, the system stops pushing to that device; the user's other devices stay registered.
- **AC-673** `[vis]`: If removing the device's registration fails, the system shows an error message and keeps offering `Gerät abmelden`.
- **AC-654** `[crit]`: No caller can register or remove a device's registration on another user's behalf; registering a device another user holds moves it to the caller ([AC-656](#1524-notifications)).
- **AC-655** `[crit]`: When a user signs out on a device, the system stops pushing to that device.
- **AC-677** `[crit]`: When a user's session expires, their devices stay registered.
- **AC-676** `[crit]`: When a user changes their own password, the system removes the registrations of that user's other devices ([AC-549](#154-authentication)).
- **AC-678** `[crit]`: When an owner resets a user's password, the system removes the registrations of all that user's devices ([AC-557](#1513-user-management)).
- **AC-656** `[crit]`: A device receives the pushes of only the user who registered it last.
- **AC-679** `[crit]`: When a user signs in on a device that is not registered for them, the system stops pushing to the device and offers `Push-Benachrichtigungen aktivieren`.
- **AC-657** `[crit]`: When a user is deleted, the system removes their devices' registrations.
- **AC-658** `[vis]`: The `Stummschalten` toggle shows and sets the user's push mute ([AC-195](#1524-notifications)), the same on every device they sign in on.
- **AC-659** `[crit]`: When a user changes their own theme or push mute, the system records no audit entry ([ADR-0021](../adr/0021-audit-log-and-notifications-single-write-path.md)).

Screens:

- **AC-199** `[vis]`: The rule form offers `Ziel-Status` only for a status-move class, and `Zugewiesene Mitarbeiter benachrichtigen` only for a project class ([data-model.md §5.11](data-model.md#511-notification-rule)).
- **AC-660** `[vis]`: While `Alles anzeigen` is off, the Aktivität view lists only the entries whose events, under the rules and assignments as they are now, have the user among their recipients ([AC-192](#1524-notifications)).
- **AC-672** `[vis]`: While `Alles anzeigen` is on, the Aktivität view lists every entry disclosed to the user ([AC-625](#1523-audit-log)).
- **AC-661** `[vis]`: When a user opens the Aktivität view, `Alles anzeigen` is off.
- **AC-662** `[vis]`: If the Aktivität view has no entry to show while `Alles anzeigen` is off and no filter is set, the system shows `Keine Benachrichtigungen für Sie. Alles anzeigen für den vollständigen Aktivitätsverlauf.`

### 15.26 Attachments

Per-project file attachments. Fields and their constraints: [data-model.md §5.13](data-model.md#513-attachment). Who may do what: [api.md §14.3](api.md#143-authorization-rules). `[C]` values: [architecture.md §12.2](architecture.md#122-company-configurable-settings). Screens: [ui/project-detail.md §8.15](ui/project-detail.md#815-project-detail-page).

Upload:

- **AC-397** `[crit]`: When a user uploads a file to a project, the system records one attachment with its file name, type, size, label, uploader and upload time.
- **AC-398** `[crit]`: If an upload violates an attachment field constraint ([data-model.md §5.13](data-model.md#513-attachment)), the system rejects it as a validation error and records nothing.
- **AC-399** `[crit]`: If an upload's stored object differs from what the system issued or the client declared — storage key, size, content digest or object metadata — object storage rejects it.
- **AC-400** `[crit]`: The system persists each of an attachment's encryption keys only wrapped for the active binary recipient, never for a retired one ([ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)).
- **AC-401** `[crit]`: Object storage receives attachment content only encrypted, each object with its own encryption key ([ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)).
- **AC-402** `[crit]`: If, at completion, a declared object is missing from storage or differs from its declared size, the system rejects the completion as a conflict and the upload stays incomplete.
- **AC-403** `[crit]`: If a completed upload is completed again, the system rejects it as a conflict and changes nothing.
- **AC-404** `[crit]`: When a user uploads a photo, the system stores it re-encoded within the photo encoding parameters **[C]**, with its EXIF metadata (including GPS) kept.
- **AC-405** `[vis]`: If a file exceeds the per-file size cap **[C]** — a photo after re-encoding — the system blocks the upload with `"Datei zu groß"` and offers no retry.
- **AC-406** `[vis]`: If a file's type is outside the whitelist ([data-model.md §5.13](data-model.md#513-attachment)), the system blocks the upload with a German message naming the supported types.
- **AC-407** `[crit]`: If an upload never completes, the system records no audit entry for it.
- **AC-408** `[crit]`: If an upload stays incomplete longer than the orphan-reaper TTL **[C]**, the system deletes it and its stored objects.
- **AC-225** `[vis]`: If an upload fails for a transient reason — network, storage, or a conflict at completion — the system shows a German error beside the file and an `Erneut versuchen` action that restarts the upload from the beginning; it never retries on its own.
- **AC-446** `[vis]`: The document upload's label control offers exactly the label set except `foto` ([data-model.md §5.13](data-model.md#513-attachment)), with German names **[C]**, and accepts no free text.

Access and download:

- **AC-409** `[crit]`: The attachment lists show the project's complete, non-hidden attachments, newest first.
- **AC-337** `[crit]`: When a project's attachments change, every open view showing its attachment lists or its Papierkorb shows the change within 2 seconds, without a reload.
- **AC-410** `[crit]`: If a worker requests an attachment operation on a project they are not assigned to, the system rejects it as an authorization error, as for the project itself ([AC-581](#1521-role-scoping)).
- **AC-411** `[crit]`: If a worker hides an attachment they did not upload, or after the self-delete grace window **[C]**, the system rejects it as an authorization error.
- **AC-412** `[crit]`: If a user uploads or hides an attachment on an archived project, the system rejects it as not found (as [AC-499](#1512-projects)).
- **AC-413** `[crit]`: If a download requests an attachment that is incomplete or hidden, the system rejects it as not found.
- **AC-414** `[crit]`: If a bulk download includes an attachment that is incomplete, hidden or of another project, the system rejects the whole request as a validation error.
- **AC-415** `[crit]`: If a bulk download exceeds a bulk-download cap **[C]** — file count or summed size — the system rejects the whole request as a validation error.
- **AC-416** `[crit]`: When a user views or downloads an attachment, the system delivers its content as uploaded.
- **AC-417** `[vis]`: When a user downloads an attachment, the system saves it under its file name.
- **AC-418** `[crit]`: If stored content was altered, the system refuses to deliver it ([ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)).
- **AC-433** `[vis]`: When a user downloads a selection as ZIP, the system delivers one archive of the selected files' content as uploaded.
- **AC-434** `[vis]`: If a ZIP selection holds files whose names differ at most in letter case, the archive keeps each file under a name distinct ignoring letter case.
- **AC-435** `[vis]`: If a ZIP selection exceeds a bulk-download cap **[C]**, the system blocks it before download and shows a German message naming both caps.
- **AC-436** `[vis]`: If an attachment's stored content is missing, the system shows it as `"Datei fehlt"` with a placeholder, disables download, ZIP selection and lightbox, and keeps the attachment.
- **AC-244** `[vis]`: If an attachment's encryption key cannot be unwrapped, the system shows it as `"Schlüssel nicht verfügbar"` with a placeholder, disables download, ZIP selection and lightbox, and keeps the attachment.
- **AC-437** `[vis]`: If loading an attachment fails for another reason, the system shows `"Datei konnte nicht geladen werden"` and keeps download and delete available.

Papierkorb:

- **AC-419** `[crit]`: When a user hides an attachment, the system moves it to the project's Papierkorb and hides its stored objects ([ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md)).
- **AC-420** `[crit]`: If hiding the stored objects fails, the system leaves the attachment in place, records nothing and reports a server error.
- **AC-421** `[crit]`: The Papierkorb lists the project's hidden attachments, most recently hidden first.
- **AC-422** `[crit]`: When a user restores an attachment, the system makes it and its stored content available again, unchanged.
- **AC-423** `[crit]`: If restoring the stored content fails, the system leaves the attachment in the Papierkorb, records nothing and reports a server error.
- **AC-424** `[crit]`: If the hidden content is no longer recoverable from storage, the system rejects the restore as gone and changes nothing.
- **AC-425** `[crit]`: While a project is archived, the system still lists and restores its Papierkorb.
- **AC-426** `[crit]`: If an attachment stays hidden longer than the Papierkorb window `L` **[C]**, the system deletes it permanently.

Audit, project lifecycle, export:

- **AC-427** `[crit]`: Each upload completion, hide, restore and hidden-reaper purge records exactly one audit entry with its action from the vocabulary ([data-model.md §5.10](data-model.md#510-audit-log-entity)), linked to the project.
- **AC-240** `[crit]`: The audit log never contains any of an attachment's wrapped encryption keys ([ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)).
- **AC-428** `[crit]`: When a project is purged, the system deletes its attachments and hides their stored objects ([ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md)).
- **AC-429** `[crit]`: If hiding a stored object fails during a project purge, the system completes the purge anyway.
- **AC-430** `[crit]`: When a project is archived, its attachments stay unchanged.
- **AC-431** `[crit]`: An export includes every complete, non-hidden attachment (fields per [data-model.md §5.8](data-model.md#58-export-archive)) and no incomplete or hidden one.
- **AC-432** `[crit]`: The export preflight ([ui/daten.md §8.11.1](ui/daten.md#8111-export)) states that the Papierkorb is not exported, and the restore confirmation ([§8.11.2](ui/daten.md#8112-import)) states that a full-account restore (import) deletes it.

Storage safety and recovery:

- **AC-236** `[crit]`: If the bucket is not exactly the [ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md) shape — versioning on; Compliance lock with default retention `R` ≥ 1 day **[C]**; exactly one lifecycle rule, bucket-wide, whose only action deletes hidden versions after `L` days **[C]**; `R ≤ L` — the system refuses to start.
- **AC-237** `[crit]`: If the storage credential can destroy object versions, or the provider's answer doesn't prove it can't, the system refuses to start ([ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md)).
- **AC-438** `[crit]`: If the binary keyring is absent, unreadable, malformed, or its identities don't match the configured recipients — the active one plus each listed retired one, none missing, none extra — the system refuses to start and logs which check failed ([ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)).
- **AC-439** `[crit]`: Every object the system writes outside the deploy-probe namespace ([data-model.md §5.13](data-model.md#513-attachment)) decrypts with the binary keyring alone, without its database row ([ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)).
- **AC-440** `[crit]`: Every rendered invoice PDF object names its invoice number, readable without the database ([ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)).
- **AC-441** `[crit]`: When the operator runs the recovery tool with only the binary keyring, storage credentials and a cutoff time — no database — it writes the plaintext of every object version written since the cutoff outside the deploy-probe namespace, hidden versions and objects no attachment refers to included, and reads no older version.
- **AC-442** `[crit]`: When given an object key, the recovery tool processes only that key's versions, still bounded by the cutoff.
- **AC-443** `[crit]`: The recovery tool's index lists every version it processed with its object key, version id, write time and outcome, plus the invoice number when the object names one.
- **AC-444** `[crit]`: If a version does not decrypt and authenticate with the binary keyring alone, the recovery tool lists it as failed, writes no plaintext for it, continues, and exits non-zero.
- **AC-445** `[infra]`: The binary keyring is never persisted to disk on the VPS; it is loaded only into tmpfs ([ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)).
- **AC-517** `[crit]`: After a key rotation, every attachment written under a listed retired key still opens and downloads, singly and in a ZIP selection, and is included in the full-account export; every invoice PDF written under one still downloads and is included in the invoice bulk export and the full-account export ([ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)).
- **AC-374** `[infra]`: The recovery tool runs with a dedicated read-only storage credential — list and read, no write or hide.

### 15.27 Configuration and Feature Manifest

Optional features and their configuration: [architecture.md §12.6](architecture.md#126-feature-manifest-and-operator-confidence).

- **AC-230** `[crit]`: When the system starts, it writes one `info` log line with `event = 'config-feature-manifest'` listing every optional feature with the state it runs in, `enabled` or `disabled`, and for a disabled one a `reason` naming a missing value.
- **AC-231** `[infra]`: If the configuration fails validation, the deploy exits non-zero before replacing any container and names every offending key.
- **AC-773** `[crit]`: If the takeout staging directory **[C]** of a production deployment is on a memory-backed filesystem, the system refuses to start.

### 15.28 Realtime Events

Live refresh, while a view's realtime event connection is up: [AC-277](#1512-projects), [AC-681](#1523-audit-log), [AC-337](#1526-attachments), [AC-450](#1529-storage-usage), [AC-317](#1532-activity-dock), [AC-719](#1530-invoices), [AC-602](#1514-data-exchange), [AC-608](#1514-data-exchange). After a lost connection: AC-682. Design: [ADR-0025](../adr/0025-realtime-ui-invalidation-via-sse.md).

- **AC-680** `[crit]`: Realtime events carry only the kind of data that changed, never the data itself ([ADR-0025](../adr/0025-realtime-ui-invalidation-via-sse.md)).
- **AC-682** `[crit]`: While an open view's session is valid, if the view lost its realtime event connection, it shows current data within 30 seconds of the server being reachable again, without a reload.
- **AC-275** `[crit]`: When a session ends ([data-model.md §5.4](data-model.md#54-session)), the system closes that session's realtime event connections within one heartbeat interval **[C]** ([architecture.md §12.2](architecture.md#122-company-configurable-settings)).

### 15.29 Storage Usage

Totals: [data-model.md §5.14](data-model.md#514-storage-usage). What the screens show: [ui/daten.md §8.11.3](ui/daten.md#8113-speichernutzung), [ui/index.md §8.1.2](ui/index.md#812-authenticated-state). Who may read them: [api.md §14.3](api.md#143-authorization-rules).

- **AC-447** `[crit]`: Each storage total equals, at every read, its [data-model.md §5.14](data-model.md#514-storage-usage) sum over the attachments of every project, archived ones included.
- **AC-448** `[vis]`: While a user holding `data:export` is signed in, the footer shows "Daten:" followed by the visible total; otherwise it shows no storage badge.
- **AC-449** `[vis]`: When the user hovers the footer storage badge, it shows the visible and Papierkorb totals with their [ui/daten.md §8.11.3](ui/daten.md#8113-speichernutzung) labels.
- **AC-450** `[crit]`: When a storage total changes, every open session showing it shows the new value within 2 seconds, without a reload.
- **AC-451** `[vis]`: The storage totals and the Export and Import progress byte counts are shown in powers of 1024: B and KB as whole numbers, MB and GB with two decimals after a decimal comma ("1,50 MB").

### 15.30 Invoices

Fields, the rendered document and the export archive: [data-model.md §5.15](data-model.md#515-invoice-entity). Numbering: [data-model.md §5.16](data-model.md#516-invoice-sequence-entity). Who may do what: [api.md §14.3](api.md#143-authorization-rules). Screens: [ui/invoices.md §8.16](ui/invoices.md#816-invoices-view), [ui/project-detail.md §8.15.11](ui/project-detail.md#81511-invoice). Design: [ADR-0026](../adr/0026-invoices-immutability-and-zugferd.md).

Drafts:

- **AC-683** `[crit]`: When a user creates an invoice draft for a project, the system stores it without a number or issue date, with the tax mode the user chose or, failing that, the company profile's default tax mode.
- **AC-523** `[crit]`: When a user creates an invoice draft, each recipient field the user did not set — name, address, USt-IdNr. — holds the project customer's current value.
- **AC-545** `[crit]`: If a user creates an invoice draft while a customer edit is uncommitted, each recipient field the user did not set holds the customer's committed value: the edited one if the edit commits, the prior one if it rolls back.
- **AC-684** `[crit]`: When a user saves an invoice draft, the system stores its recipient, lines, tax mode and performance date as entered.
- **AC-685** `[crit]`: The system derives each line total and the totals of an invoice from its lines and tax mode, as [data-model.md §5.15](data-model.md#515-invoice-entity) defines.
- **AC-686** `[crit]`: If a draft save violates an invoice field constraint ([data-model.md §5.15](data-model.md#515-invoice-entity)), the system refuses it as a validation error ([api.md §14.4.1](api.md#1441-error-categories)) and changes nothing.
- **AC-726** `[vis]`: While a draft form under `Regulär` holds a 0 % line, the form marks that line's rate with a German message and does not save the draft.
- **AC-731** `[vis]`: If a user saves a draft form without a line that has a description and a price other than 0, the form says so in German and does not save the draft.
- **AC-687** `[crit]`: When a user discards an invoice draft, the system deletes it.

Customer corrections:

- **AC-543** `[crit]`: When a customer edit changes `name`, `address` or `ustId`, each draft on the customer's projects, archived ones included, then holds the new value of each such field where it held the customer's previous value, and keeps every other value ([data-model.md §5.15](data-model.md#515-invoice-entity)). Issuing such a draft freezes the values it holds. Issued and cancelled invoices are unchanged.
- **AC-688** `[crit]`: If correcting a customer's drafts ([AC-543](#1530-invoices)) fails, the system refuses the customer edit and changes neither the customer nor its drafts.
- **AC-546** `[crit]`: The correction of [AC-543](#1530-invoices) serializes with saving, discarding and issuing the same draft ([data-model.md §6.4](data-model.md#64-concurrency)): a value saved before it stays; a draft discarded or issued before it is untouched; saving, discarding or issuing the draft at its pre-correction version is refused as a conflict.

Issuance:

- **AC-689** `[crit]`: When a user issues a draft, the system gives it the next number of its issue year's invoice sequence ([data-model.md §5.16](data-model.md#516-invoice-sequence-entity)) and its issue date.
- **AC-690** `[crit]`: The system dates an invoice or Storno with the calendar date in Germany (Europe/Berlin) at its issuance; its number carries that date's year.
- **AC-691** `[crit]`: When a user issues a draft, the system freezes it as it holds it, with the company profile's values at that moment as issuer ([data-model.md §5.15](data-model.md#515-invoice-entity)).
- **AC-692** `[crit]`: When a user issues a draft, the system moves its project from `Rechnung fällig` to `Abgerechnet` as a forward transition.
- **AC-693** `[crit]`: When the system issues an invoice or a Storno, it stores its document, rendered as [data-model.md §5.15](data-model.md#515-invoice-entity) describes.
- **AC-694** `[crit]`: Within each year, the system numbers invoices, and separately Stornos, consecutively from 1, without a duplicate — concurrent issuances included — and without a gap except after a restore or an import ([data-model.md §6.13](data-model.md#613-gapless-sequence-allocation)).
- **AC-695** `[crit]`: If an issuance or a cancellation fails at any step, the system changes nothing: no number is used, and the invoice and its project keep their states.
- **AC-696** `[crit]`: If a user issues a draft whose project is not in `Rechnung fällig`, the system refuses it as a conflict and changes nothing.
- **AC-697** `[crit]`: If a user issues a draft that lacks a field [data-model.md §5.15](data-model.md#515-invoice-entity) requires for issuance, or whose lines break a §5.15 line constraint, the system refuses it as a validation error and changes nothing.
- **AC-698** `[crit]`: If a user issues a draft while the company profile lacks a required field ([data-model.md §5.17](data-model.md#517-company-profile-entity)), the system refuses it as a validation error naming the missing fields and changes nothing.
- **AC-699** `[crit]`: If a user issues a draft that changed after they last loaded it, the system refuses it as a conflict and changes nothing ([data-model.md §6.4](data-model.md#64-concurrency)).
- **AC-728** `[vis]`: The `Ausstellen` and `Verwerfen` confirmations of a draft preview its recipient, lines, tax mode, performance date and totals.
- **AC-729** `[crit]`: If a user confirms issuing or discarding a draft that changed after the confirmation opened, the system refuses it as a conflict and changes nothing; a live refresh does not change which version the confirmation acts on.
- **AC-700** `[crit]`: If a document's XML fails the EN 16931 schema, the system fails its issuance or cancellation.
- **AC-701** `[crit]`: For the supported cases ([ADR-0026 § Compliance boundary](../adr/0026-invoices-immutability-and-zugferd.md#compliance-boundary)), a document's XML passes the EN 16931 business rules.

Cancellation:

- **AC-702** `[crit]`: When a user cancels an issued invoice, the system marks it cancelled and issues a Storno for it, numbered from its issue year's Storno sequence ([data-model.md §5.16](data-model.md#516-invoice-sequence-entity)).
- **AC-703** `[crit]`: The system issues a Storno with its original's issuer, recipient, tax mode and performance date, its lines with negated unit prices and line totals, the exact negation of its totals, and the reason the user gave.
- **AC-704** `[crit]`: When a user cancels an invoice, the system leaves its project's state unchanged.
- **AC-705** `[crit]`: If a user cancels a draft or a cancelled invoice, the system refuses it as a conflict and changes nothing.
- **AC-706** `[crit]`: If a user cancels a Storno, the system refuses it as a conflict and changes nothing.
- **AC-707** `[vis]`: If a user confirms a Storno without a reason, the system asks for one and cancels nothing.

Issued invoices:

- **AC-708** `[crit]`: The system never changes an issued or cancelled invoice, except marking an issued one cancelled — a database write bypassing the application included ([ADR-0026](../adr/0026-invoices-immutability-and-zugferd.md)).
- **AC-709** `[crit]`: If a user edits, discards or issues an issued or cancelled invoice, the system refuses it as a validation error and changes nothing.
- **AC-710** `[crit]`: The system stores every invoice document — at issuance, at cancellation, or restored by an import — under its own Compliance-mode Object Lock until its write time plus the invoice lock period **[C]**; a period of 0 writes no lock.
- **AC-364** `[crit]`: The system keeps invoice documents off the attachment surface: no attachment list, Papierkorb, download, ZIP or attachment change reaches one.
- **AC-711** `[crit]`: When a user downloads an issued or cancelled invoice or a Storno, the system delivers its document as stored, under the file name of [data-model.md §5.15](data-model.md#515-invoice-entity).

Lists and export:

- **AC-712** `[vis]`: The system orders the invoice lists by issue date, newest first, with drafts last, newest first.
- **AC-713** `[vis]`: The system shows each Storno directly under its original in the invoice lists.
- **AC-714** `[vis]`: When a user types in the invoice list search, the system shows only invoices whose number or recipient name contains the text, ignoring letter case.
- **AC-715** `[vis]`: When a user picks a year or a status in the invoice list, the system shows only the invoices issued in that year, or in that status.
- **AC-716** `[vis]`: The invoice list's year filter offers every year an invoice was issued in, and the current year, whatever filter is active.
- **AC-717** `[crit]`: When a user exports invoices, the system delivers one archive with the documents of the selected invoices — or, with none selected, of every issued or cancelled invoice the list filters match — and a manifest listing them ([data-model.md §5.15](data-model.md#515-invoice-entity)).
- **AC-718** `[crit]`: If an export's selection or filter matches more invoices than the export cap ([data-model.md §5.15](data-model.md#515-invoice-entity)), the system refuses it as a validation error and delivers nothing.
- **AC-730** `[crit]`: If an export cannot include every document it covers, the system delivers no archive and reports the failure.
- **AC-719** `[crit]`: When an invoice is created, changed or removed, every open invoice list, invoice viewer and project invoice block that shows or would list it shows the change within 2 seconds, without a reload.
- **AC-720** `[vis]`: While a user has a draft form or a Storno confirmation open, a live refresh keeps it open with its input.

Archived projects:

- **AC-513** `[crit]`: If a user edits, deletes, issues or cancels an invoice of an archived project, the system refuses it as not found ([api.md §14.4.1](api.md#1441-error-categories)) and changes nothing.
- **AC-727** `[crit]`: If a user creates an invoice draft for an archived project, the system refuses it as not found ([api.md §14.4.1](api.md#1441-error-categories)) and changes nothing.
- **AC-514** `[vis]`: While an invoice's project is archived, the invoice list and the invoice viewer ([ui/invoices.md §8.16](ui/invoices.md#816-invoices-view)) offer no change to that invoice.

### 15.31 Company Profile

Fields: [data-model.md §5.17](data-model.md#517-company-profile-entity). Who may edit: [api.md §14.3](api.md#143-authorization-rules). Screen: [ui/invoices.md §8.16.4](ui/invoices.md#8164-company-profile).

- **AC-721** `[crit]`: The system holds exactly one company profile — a database write bypassing the application included.
- **AC-722** `[crit]`: When the owner saves the company profile, the system stores the entered values.
- **AC-723** `[crit]`: If a company profile save violates a field constraint ([data-model.md §5.17](data-model.md#517-company-profile-entity)) — an empty required field included — the system refuses it as a validation error naming the offending field, and changes nothing.
- **AC-724** `[vis]`: If a user saves the company profile form with required fields empty, the form marks each with a German message and sends nothing.
- **AC-725** `[vis]`: If issuing fails for an incomplete company profile, the project's invoice block names the missing fields in German and links to the company profile form.

### 15.32 Activity Dock

The live audit feed in the app shell ([ui/index.md §8.1.2](ui/index.md#812-authenticated-state)).

- **AC-638** `[vis]`: The system shows the activity dock only to callers holding `audit:read`.
- **AC-637** `[vis]`: The activity dock lists the entries the Aktivität view lists while `Alles anzeigen` is on ([AC-672](#1524-notifications)).
- **AC-317** `[vis]`: While the activity dock is expanded, an audit entry recorded in another session appears in it within 2 seconds, without a manual refresh.
- **AC-634** `[vis]`: When a page loads, the system shows the activity dock collapsed.
- **AC-635** `[vis]`: When a user switches views, the activity dock stays expanded or collapsed as it was.
- **AC-636** `[vis]`: While the viewport is at most 768 px wide, the system shows no activity dock.
- **AC-341** `[vis]`: While the Aktivität view is shown, the system shows no activity dock and `Alt+A` does nothing; leaving the view restores the dock as it was.
- **AC-639** `[vis]`: The activity dock shows each entry on one line; a description that does not fit is cut off with an ellipsis.
- **AC-640** `[vis]`: While the activity dock is shown, when a user presses `Alt+A` (`Option+A` on macOS) while focus is not in an editable field, the system expands or collapses the activity dock, and the keystroke has no other effect.

### 15.33 Threshold Monitor

The periodic check that fires the two system events ([data-model.md §5.11](data-model.md#511-notification-rule)). A condition is the backup badge amber or red, with its reason, or storage over the warn band. Its `[C]` values: [architecture.md §12.2](architecture.md#122-company-configurable-settings) (threshold-monitor policy, storage capacity declaration).

- **AC-663** `[crit]`: When a monitor sweep **[C]** finds the backup badge ([AC-612](#1522-backup-and-recovery)) amber or red, the system fires `backup.failed` with the badge's reason, as [AC-665](#1533-threshold-monitor) allows.
- **AC-664** `[crit]`: If a sweep cannot read the backup status, the system fires no `backup.failed` and writes a `threshold_monitor_backup_status_unreachable` line to the operational log.
- **AC-665** `[crit]`: While a condition holds, the system fires its event again at most once per re-notify window **[C]**; a restart may add one more.
- **AC-666** `[crit]`: When a sweep finds the backup badge's reason changed, the system fires `backup.failed`, whatever the re-notify window.
- **AC-667** `[crit]`: When a sweep finds the stored total ([data-model.md §5.14](data-model.md#514-storage-usage)) at or above the warn band **[C]** of the declared capacity **[C]**, the system fires `disk.threshold_reached` with the fill percentage, as [AC-665](#1533-threshold-monitor) allows.
- **AC-668** `[crit]`: If the stored total falls below the warn band but not below the clear line **[C]**, the system treats the storage condition as still holding.
- **AC-669** `[crit]`: While no storage capacity is declared, the system fires no `disk.threshold_reached` and says so once in the operational log at startup.
- **AC-670** `[crit]`: The system refuses no upload for storage reaching the warn band ([kickoff](../project/kickoff.md): cleanup is up to the users).
- **AC-671** `[crit]`: If checking one condition fails, the system still checks the other in the same sweep.

### 15.34 Security Baseline

Cross-cutting security properties. Elsewhere: authentication ([AC-574](#154-authentication)), authorization ([AC-576](#1521-role-scoping)), undefined fields ([AC-516](#1517-data-integrity)), rate limits ([AC-772](#154-authentication)), HTTPS ([AC-775](#156-deployment), [AC-776](#156-deployment)), sessions and sign-in ([AC-552](#154-authentication), [AC-781](#154-authentication), [AC-784](#154-authentication)), password changes ([AC-786](#154-authentication)), caller-owned records ([AC-654](#1524-notifications)).

- **AC-779** `[crit]`: The system stores a password only as a salted, deliberately slow hash ([ADR-0006](../adr/0006-password-policy-nist-blocklist.md)).
- **AC-780** `[crit]`: The system writes no submitted password to the operational log.
- **AC-782** `[crit]`: The system serves no response or file that carries a secret of an external service — an API key, a storage credential or a private key ([ADR-0016](../adr/0016-llm-email-extraction-via-server-proxied-openrouter.md)).
- **AC-783** `[crit]`: If a request fails, the system responds without a stack trace, SQL text, database identifier or error detail, or server file path.
- **AC-787** `[crit]`: If a request value contains SQL, the system treats it as plain text and executes none of it.

---

## 17. Risks and Mitigations

| Risk                                               | Impact                             | Mitigation                                                                                                                                                    |
| -------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9 Kanban columns too tight on screen               | Usability                          | Horizontal scroll; responsive collapse tiers ([AC-470](#151-workflow-board)).                                                                                 |
| Over-styling action columns                        | Defeats Kanban principle           | Trust board structure; resist decorative urgency.                                                                                                             |
| API latency makes transitions feel sluggish        | Interaction feels unresponsive     | Optimistic UI updates.                                                                                                                                        |
| Session management edge cases                      | User loses work or sees stale data | Sessions are checked on every API call. Expiry redirects to login cleanly. All mutations are immediate (no local drafts to lose).                             |
| Soft-deleted projects consume storage indefinitely | Database growth                    | Archived projects are purged when their customer is deleted ([ADR-0017](../adr/0017-soft-delete-as-board-archive.md)). Customer deletion is the cleanup path. |
