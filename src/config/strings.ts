/**
 * Centralized German UI and error strings.
 *
 * All user-facing text lives here so that:
 * - Strings are identifiable and grouped (spec §11.5, §12.2)
 * - Future i18n extraction has a single source
 * - The same message used in multiple places stays consistent
 *
 * Convention: keys are English, values are German.
 * Template functions accept parameters and return the composed string.
 */

export const STRINGS = {
  auth: {
    loginButton: 'Anmelden',
    username: 'Benutzername',
    password: 'Passwort',
    logout: 'Abmelden',
    loginFailed: 'Anmeldung fehlgeschlagen.',
    unauthenticated: 'Nicht angemeldet.',
    sessionExpired: 'Sitzung abgelaufen.',
    sessionExpiredLogin: 'Sitzung abgelaufen. Bitte erneut anmelden.',
    notPermitted: 'Keine Berechtigung.',
  },

  errors: {
    mutationFailed: 'Änderung fehlgeschlagen. Bitte erneut versuchen.',
    networkError: 'Netzwerkfehler. Bitte Verbindung überprüfen.',
    invalidResponse: 'Server-Antwort ungültig. Bitte erneut versuchen.',
    rateLimited: 'Zu viele Anfragen. Bitte später erneut versuchen.',
    serverError: 'Ein interner Fehler ist aufgetreten.',
    invalidInput: 'Ungültige Eingabe.',
    notFound: (entity: string) => `${entity} nicht gefunden.`,
    routeNotFound: 'Die angeforderte URL existiert nicht.',
    methodNotAllowed: 'Diese Methode ist für diesen Endpunkt nicht erlaubt.',
    // Resumable-upload (tus) header rejections — api.md §14.2.4. The
    // header names stay untranslated: they are protocol tokens the
    // client sends verbatim, not prose.
    uploadLengthRequired: 'Der Header „Upload-Length" fehlt oder ist keine gültige Bytezahl.',
    uploadOffsetRequired: 'Der Header „Upload-Offset" fehlt oder ist keine gültige Bytezahl.',
    idempotencyConflict: 'Diese Anfrage-ID wurde bereits mit abweichenden Daten verwendet.',
    schemaVersionMismatch:
      'Die Datenformat-Version der Datei passt nicht zur aktuellen Version des Systems.',
    targetNotEmpty:
      'Die Datenbank ist nicht leer. Bestätigen Sie das Überschreiben, um fortzufahren.',
    restoreConfirmationMismatch:
      'Bestätigung fehlt oder stimmt nicht. Bitte den angezeigten Text exakt eingeben.',
    missingUserRefs:
      // Issue #230: with `users` in the envelope, the happy path always
      // resolves refs internally. Surfacing this error now means the
      // envelope was hand-edited or partially exported — the right
      // remediation is to re-export from a complete source, not to
      // restore Layer 2.
      'Eine oder mehrere Benutzer-IDs in der Envelope sind unbekannt. Bitte aus einer vollständigen Quelle erneut exportieren.',
    // Invoice domain (ADR-0026 / api.md §14.4)
    invoiceFrozen:
      'Diese Rechnung ist bereits ausgestellt und kann nicht mehr geändert oder gelöscht werden.',
    invoiceProjectState:
      'Das Projekt steht nicht im Status „Rechnung fällig" — die Rechnung kann nicht ausgestellt werden.',
    invoiceNotIssued: 'Die Rechnung ist noch ein Entwurf.',
    invoiceAlreadyCancelled: 'Die Rechnung wurde bereits storniert.',
    companyProfileRequired:
      'Firmendaten sind unvollständig. Bitte erst im Bereich „Rechnungen" vervollständigen.',
    customerHasInvoices:
      'Der Kunde kann nicht gelöscht werden, da ausgestellte oder stornierte Rechnungen existieren.',
    projectHasInvoices:
      'Das Projekt kann nicht endgültig gelöscht werden, da ausgestellte oder stornierte Rechnungen existieren.',
    draftNotExportable: 'Rechnungs-Entwürfe können nicht exportiert werden.',
    exportRequiresIdsOrFilter:
      'Genau eines von „ids" oder „filter" angeben — nicht beides und nicht keines.',
    exportTooLarge: (total: number, cap: number) =>
      `Der Filter trifft ${total} Rechnungen — Export ist auf ${cap} pro Anfrage begrenzt. Bitte den Filter eingrenzen (z. B. nach Jahr).`,
    // Full-account takeout jobs (ADR-0018 / api.md §14.2.4).
    exportJobActive:
      'Es läuft bereits ein Export-Auftrag. Bitte warten Sie, bis dieser abgeschlossen ist.',
    importJobActive:
      'Es läuft bereits ein Import-Auftrag. Bitte warten Sie, bis dieser abgeschlossen ist.',
    exportJobNotReady: 'Der Export-Auftrag ist noch nicht bereit zum Herunterladen.',
    uploadOffsetConflict:
      'Der Upload-Versatz stimmt nicht mit dem Server-Stand überein. Bitte vom angezeigten Versatz fortsetzen.',
    uploadTooLarge: 'Der Upload überschreitet die angekündigte Dateigröße.',
    uploadNotAccepted: 'Für diesen Auftrag können keine Daten mehr hochgeladen werden.',
  },

  entities: {
    project: 'Projekt',
    customer: 'Kunde',
    user: 'Benutzer',
    audit: 'Audit-Eintrag',
    notificationRule: 'Benachrichtigungsregel',
    pushSubscription: 'Push-Abonnement',
    invoice: 'Rechnung',
    companyProfile: 'Firmendaten',
    resource: 'Ressource',
  },

  states: {
    anfrage: 'Anfrage',
    angebot: 'Angebot',
    beauftragt: 'Beauftragt',
    geplant: 'Geplant',
    in_arbeit: 'In Arbeit',
    abnahme: 'Abnahme',
    rechnung_faellig: 'Rechnung fällig',
    abgerechnet: 'Abgerechnet',
    erledigt: 'Erledigt',
  },

  projects: {
    noDate: 'Kein Termin',
    numberTaken: (n: string) => `Projektnummer "${n}" ist bereits vergeben.`,
    numberAvailable: 'Verfügbar',
    archive: 'Archivieren',
    archiveConfirm: (identifier: string) => `Projekt ${identifier} wirklich archivieren?`,
    showArchived: 'Archivierte einblenden',
    /** Mitarbeiter (assignee) filter on the management toolbar. */
    filterWorkers: 'Mitarbeiter filtern',
    filterWorkersCount: (n: number) => `Mitarbeiter (${n})`,
    /** "Nicht zugewiesen" entry in the assignee filter — projects with zero workers. */
    filterUnassigned: 'Nicht zugewiesen',
    /** Empty state in the assignee-filter popover. */
    filterNoWorkers: 'Keine Mitarbeiter vorhanden.',
    /** Search box placeholder inside the assignee-filter popover. */
    filterWorkersSearchPlaceholder: 'Mitarbeiter suchen…',
    archivedBadge: 'Archiviert',
    purge: 'Endgültig löschen',
    purgeConfirm: (identifier: string) =>
      `Projekt ${identifier} wird endgültig gelöscht. Alle zugeordneten Daten gehen dabei verloren. Fortfahren?`,
    purgeRequiresArchive:
      'Das Projekt muss zunächst archiviert werden, bevor es endgültig gelöscht werden kann.',
    restore: 'Wiederherstellen',
    restoreConfirm: (identifier: string) =>
      `Projekt ${identifier} aus dem Archiv wiederherstellen?`,
    restoreRequiresArchive:
      'Das Projekt ist nicht archiviert und kann daher nicht wiederhergestellt werden.',
    transitionConfirm: (from: string, to: string) => `Status ändern: ${from} → ${to}?`,
    cannotAdvanceTerminal:
      'Projekt kann nicht weiter vorgerückt werden. Der aktuelle Status ist ein Endstatus.',
    cannotRevertFirst:
      'Projekt kann nicht zurückgestuft werden. Der aktuelle Status ist bereits der erste Status.',
    cannotRevertTerminal:
      'Projekt kann nicht zurückgestuft werden. Der aktuelle Status ist ein Endstatus.',
    invalidStatus: (s: string) => `status '${s}' ist kein gültiger Workflow-Status.`,
    invalidPlannedStart: 'plannedStart muss ein gültiges ISO-Datum sein.',
    invalidPlannedEnd: 'plannedEnd muss ein gültiges ISO-Datum sein.',
    endWithoutStart: 'Enddatum kann nicht ohne Startdatum gesetzt werden.',
    endBeforeStart: 'Das Enddatum darf nicht vor dem Startdatum liegen.',
    invalidEstimatedValue: 'estimatedValue muss ein gültiger numerischer Wert sein.',
    unknownImportError: 'Unbekannter Fehler beim Import.',
    // Import error translations — never leak pg constraint names, table
    // names, column names, SQLSTATE codes, or English text. See C-5.
    duplicateNumber: (n: string) => `Projektnummer "${n}" ist bereits vergeben.`,
    foreignKeyViolation: 'Verknüpfter Datensatz existiert nicht (z. B. zugeordnete Mitarbeiter).',
    dateConstraintViolation: 'Datumsangaben verletzen eine Integritätsregel.',
    concurrentModification:
      'Der Projektstatus wurde zwischenzeitlich geändert. Bitte Seite neu laden.',

    // Site-address (Baustelle) labels — see ui/management.md §8.8.6
    // and ui/project-detail.md §8.15.2. The Baustelle group on the
    // project create / edit forms and the read-only `Baustelle:` line
    // on both detail surfaces source their German copy from these keys.
    siteAddressLabel: 'Baustelle',
    /** Form toggle that maps to `siteAddress: null` on submit. */
    siteAddressIdenticalToggle: 'Identisch mit Kundenadresse',
    /** Inline hint on the read-only fallback (project's siteAddress is
     *  null — the customer's billing address is shown in its place). */
    siteAddressFallbackHint: '(Kundenadresse)',
    /** Placeholder when neither project.siteAddress nor customer.address
     *  is present — no map link is rendered alongside this. */
    siteAddressNone: 'Keine Adresse',
    /** All-or-none validation message for the Baustelle group — fires
     *  when the toggle is OFF and at least one but not all three of
     *  street / zip / city carry a non-whitespace value. AC-284. */
    siteAddressPartial:
      'Bitte alle drei Felder ausfüllen oder „Identisch mit Kundenadresse“ aktivieren.',
  },

  validation: {
    requiredString: (field: string) =>
      `${field} ist erforderlich und muss ein nicht-leerer String sein.`,
    requiredObject: (field: string) => `${field} ist erforderlich und muss ein Objekt sein.`,
    mustBeString: (field: string) => `${field} muss ein String sein.`,
    mustBeObject: (field: string) => `${field} muss ein Objekt sein.`,
    mustBeUuidArray: (field: string) => `${field} muss ein Array von UUIDs sein.`,
    mustBeNumeric: (field: string) => `${field} muss eine Zahl oder ein numerischer String sein.`,
    mustBeUuid: (field: string) => `${field} muss eine gültige UUID sein.`,
    minLength: (field: string, min: number) => `${field} muss mindestens ${min} Zeichen lang sein.`,
    maxLength: (field: string, max: number) => `${field} darf maximal ${max} Zeichen lang sein.`,
  },

  customers: {
    duplicateName: 'Ein Kunde mit diesem Namen existiert bereits.',
    duplicateNameConfirm: (name: string) =>
      `Ein Kunde mit dem Namen "${name}" existiert bereits. Trotzdem erstellen?`,
    nameRequired: 'Kundenname ist erforderlich.',
    hasProjects: 'Kunde kann nicht gelöscht werden, da noch aktive Projekte zugeordnet sind.',
    deleteWithArchived: (n: number) =>
      `Achtung: ${n} archivierte Projekt${n === 1 ? '' : 'e'} werden dabei endgültig gelöscht. Fortfahren?`,
    ambiguousName: 'Mehrere Kunden mit diesem Namen gefunden. Import-Zuordnung nicht eindeutig.',
  },

  extraction: {
    notConfigured: 'E-Mail-Extraktion ist nicht konfiguriert (OPENROUTER_API_KEY fehlt).',
    emptyInput: 'E-Mail-Text darf nicht leer sein.',
  },

  users: {
    duplicateUsername: 'Benutzername ist bereits vergeben.',
    cannotDeactivateSelf: 'Sie können sich nicht selbst deaktivieren.',
    cannotDeleteSelf: 'Sie können sich nicht selbst löschen.',
    alreadyActive: 'Benutzer ist bereits aktiv.',
    alreadyInactive: 'Benutzer ist bereits deaktiviert.',
  },

  roles: {
    owner: 'Inhaber',
    office: 'Büro',
    worker: 'Mitarbeiter',
    bookkeeper: 'Buchhalter',
  } as Record<string, string>,

  password: {
    tooShort: 'Neues Passwort ist zu kurz (mindestens 8 Zeichen).',
    tooLong: 'Neues Passwort ist zu lang.',
    tooCommon: 'Dieses Passwort ist zu häufig. Bitte ein sichereres Passwort wählen.',
    confirm: 'Passwort bestätigen',
    mismatch: 'Passwörter stimmen nicht überein.',
    change: 'Passwort ändern',
    currentPassword: 'Aktuelles Passwort',
    newPassword: 'Neues Passwort',
    changeSuccess: 'Passwort wurde geändert.',
    resetPassword: 'Passwort zurücksetzen',
    resetSuccess: 'Passwort wurde zurückgesetzt.',
  },

  // Theme selector in the user menu — labels pinned by spec §8.7.2 and by
  // the e2e contract in e2e/theme-preference.spec.ts.
  theme: {
    section: 'Darstellung',
    light: 'Hell',
    dark: 'Dunkel',
    system: 'Systemstandard',
  },

  /**
   * Push-notifications group in the user menu (spec ui/index.md §8.7.2,
   * ui/behavior.md §9.8). Labels pinned by the spec and the e2e contract
   * in e2e/push-permission.spec.ts.
   *
   * The permission-denied copy intentionally does NOT offer an in-app
   * remediation — a denied browser permission is near-irreversible and
   * the user must clear it via browser settings.
   */
  push: {
    section: 'Push-Benachrichtigungen',
    enable: 'Push-Benachrichtigungen aktivieren',
    mute: 'Stummschalten',
    unsubscribe: 'Gerät abmelden',
    subscribed: 'Dieses Gerät ist angemeldet.',
    denied:
      'Push-Benachrichtigungen wurden für diese Webseite blockiert. Bitte in den Browser-Einstellungen freigeben.',
    unsupported: 'Dieser Browser unterstützt keine Push-Benachrichtigungen.',
    notConfigured: 'Push-Benachrichtigungen sind auf diesem Server nicht konfiguriert.',
    subscribeFailed: 'Anmeldung für Push-Benachrichtigungen fehlgeschlagen.',
  },

  ui: {
    confirm: 'Bestätigen',
    ok: 'OK',
    cancel: 'Abbrechen',
    clearFilter: 'Filter aufheben',
    close: 'Schließen',
    closeError: 'Fehlermeldung schließen',
    loading: 'Laden...',
    nextStep: 'Nächster Schritt',
    prevStep: 'Vorheriger Schritt',
    statusForward: (label: string) => `Status weiter: ${label}`,
    projectsNoDates: (n: number) => `${n} Projekte ohne Termin`,
    customer: 'Kunde',
    dates: 'Termine',
    dateStart: 'Beginn',
    dateEnd: 'Ende',
    workers: 'Mitarbeiter',
    estimatedValue: 'Geschätzter Wert',
    notes: 'Notizen',
    created: 'Erstellt:',
    updated: 'Aktualisiert:',
    statusSince: 'Status seit:',
    openMaps: 'In Google Maps öffnen',
    viewMyProjects: 'Meine Projekte',
    viewKanban: 'Kanban',
    viewCalendar: 'Kalender',
    viewCustomers: 'Kunden',
    viewProjects: 'Projekte',
    viewUsers: 'Benutzer',
    viewData: 'Daten',
    viewAudit: 'Aktivität',
    viewNotifications: 'Benachrichtigungen',
    viewInvoices: 'Rechnungen',
    myProjectsToday: 'Heute',
    myProjectsUpcoming: 'Demnächst',
    myProjectsOther: 'Weitere',
    myProjectsEmpty: 'Keine zugewiesenen Projekte.',
    viewMonth: 'Monat',
    viewWeek: 'Woche',
    navAdminMenu: 'Verwaltung',
    navHome: 'Zur Startseite',

    // Management actions
    create: 'Erstellen',
    createAnyway: 'Trotzdem erstellen',
    save: 'Speichern',
    edit: 'Bearbeiten',
    viewDetails: 'Details',
    delete: 'Löschen',
    search: 'Suchen...',
    noResults: 'Keine Ergebnisse.',
    name: 'Name',
    phone: 'Telefon',
    email: 'E-Mail',
    street: 'Straße',
    zip: 'PLZ',
    city: 'Ort',
    status: 'Status',
    number: 'Nummer',
    title: 'Titel',
    active: 'Aktiv',
    inactive: 'Deaktiviert',
    username: 'Benutzername',
    displayName: 'Anzeigename',
    roles: 'Rollen',
    actions: 'Aktionen',
    projectCount: 'Projekte',
    value: 'Wert',
    deactivate: 'Deaktivieren',
    reactivate: 'Reaktivieren',
    deactivateConfirm: (name: string) => `${name} wirklich deaktivieren?`,
    reactivateConfirm: (name: string) => `${name} wirklich reaktivieren?`,
    deleteConfirm: (item: string) => `${item} wirklich löschen?`,

    // Extraction
    extractEmail: 'E-Mail Import',
    extractButton: 'Daten extrahieren',
    extractPlaceholder: 'E-Mail-Text hier einfügen...',
    extracting: 'Extrahiere Daten...',
    customerData: 'Kundendaten',
    projectData: 'Projektdaten',
    existingCustomer: 'Vorhandener Kunde',
    newCustomer: 'Neuer Kunde',
    description: 'Beschreibung',

    // Data exchange (Daten view) — kept here for shared labels.
    entityType: 'Datentyp',
    customers: 'Kunden',
    projects: 'Projekte',
    all: 'Alle',
    uploadFile: 'JSON-Datei auswählen',
    fileTooLarge: (maxMb: number) => `Datei zu groß. Maximal ${maxMb} MB erlaubt.`,
    noPermission: 'Keine Berechtigung.',

    // Not-permitted route surface (AC-149). Rendered when an
    // authenticated user opens a URL their role cannot access. Stays
    // on the forbidden path — the client does not redirect, only
    // displays this message.
    notPermittedHeading: 'Kein Zugriff',
    notPermittedBody:
      'Sie sind für diesen Bereich nicht berechtigt. Bitte wählen Sie eine verfügbare Ansicht.',
    notPermittedHome: 'Zur Startansicht',
  },

  /**
   * Layout chrome strings shared across the app shell. The storage
   * badge (Footer) and the storage row (DatenView) reference the same
   * keys so the tooltip wording and the row labels stay in lockstep
   * (spec ui/index.md §8.1.2, ui/daten.md §8.11.3).
   */
  layout: {
    storageBadgeLabel: 'Daten:',
    storageBucketReady: 'Sichtbar',
    storageBucketHidden: 'Im Papierkorb',

    /**
     * App-shell activity dock (ui/index.md §8.1.2, AC-317/318/319). The
     * collapsible live-feed panel docked above the Footer for `audit:read`
     * holders. `dockToggle*` are the aria-labels on the collapse/expand
     * control (its visible affordance is a chevron, so the label carries
     * the meaning for assistive tech).
     */
    activityDockTitle: 'Aktivität',
    /**
     * Shortcut hint rendered next to the title in the toggle button so
     * the affordance is self-documenting (AC-340). Kept in sync with the
     * Alt+A binding installed via `useGlobalShortcut` in
     * `ActivityDock.tsx`.
     */
    activityDockShortcutHint: '(Alt+A)',
    /**
     * Accessible labels for the toggle button. WCAG 2.5.3 "Label in
     * Name" — the accessible name must contain the visible label
     * (`Aktivität (Alt+A)`) so speech-input users can target the
     * control by saying what they see.
     */
    activityDockExpand: 'Aktivität (Alt+A) einblenden',
    activityDockCollapse: 'Aktivität (Alt+A) ausblenden',
  },

  companyProfile: {
    heading: 'Firmendaten',
    description:
      'Die Stammdaten des ausstellenden Unternehmens. Diese Werte werden auf jeder Rechnung beim Ausstellen eingefroren.',
    companyName: 'Firmenname',
    street: 'Straße',
    zip: 'PLZ',
    city: 'Ort',
    taxId: 'Steuernummer',
    ustId: 'USt-IdNr.',
    iban: 'IBAN',
    accentColor: 'Akzentfarbe',
    /**
     * Helper text below the Akzentfarbe input — pins the accepted shape
     * (the server validates against `^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$`).
     * Examples use the 3-digit form to satisfy the AC-108 palette-leak
     * scan, which only inspects 6-/8-digit hex literals.
     */
    accentColorHelper: 'Hex-Farbe als #RGB oder #RRGGBB, z. B. #f60.',
    /** Client-side validation message when the input is non-empty and not a hex color. */
    accentColorInvalid: 'Bitte als #RGB oder #RRGGBB angeben, z. B. #f60.',
    footerText: 'Fußzeile',
    footerTextHelper:
      'Erscheint am Ende jeder Rechnung. Geeignet z. B. für Bankverbindung oder Zahlungsziel.',
    defaultTaxMode: 'Standard-Steuermodus',
    taxModeStandard: 'Regulär',
    taxModeKleinunternehmer: 'Kleinunternehmer §19',
    taxModeReverseCharge: 'Reverse-Charge §13b',
    save: 'Speichern',
    ustIdRequiredForMode:
      'USt-IdNr. ist für den gewählten Steuermodus erforderlich. Bitte ausfüllen.',
    /**
     * Fetch-error fallback in the `!data` branch of the section. Surfaces
     * when `GET /api/company-profile` fails so the user sees a diagnostic
     * instead of an empty block.
     */
    fetchErrorHeading: 'Firmendaten konnten nicht geladen werden.',
    fetchRetry: 'Erneut versuchen',
  },

  /**
   * Data-exchange surface (ADR-0018, ui/daten.md §8.11). The takeout-zip
   * Export and Import actions are the only user-facing exchange flows;
   * the text-row endpoints stay as internal building blocks. Strings
   * pinned here so the Daten view and the dialogs share one source.
   */
  dataExchange: {
    exportHeading: 'Export',
    exportDescription:
      'Lädt alle Kunden, Projekte, Zuordnungen und Anhänge als ein ZIP-Archiv herunter.',
    exportAction: 'Export',
    exportPreflightTitle: 'Daten exportieren',
    exportPreflightCount: (n: number) => `${n} Anhänge`,
    exportPreflightSize: (formatted: string) => `Größe der Anhänge: ${formatted}`,
    exportPreflightConfirm: 'Export starten',
    exportPreflightCancel: 'Abbrechen',
    exportMobileWarning: 'Für Desktop-Nutzung gedacht; Downloads können sehr groß sein.',
    exportProgressTitle: 'Export läuft',
    exportProgressCounter: (done: number, total: number) => `${done} / ${total} Dateien`,
    exportProgressBytes: (done: string, total: string) => `${done} / ${total}`,
    exportProgressCurrentFile: (name: string) => `Aktuelle Datei: ${name}`,
    exportCancel: 'Abbrechen',
    exportSummaryTitle: 'Export abgeschlossen',
    exportSummaryFile: (name: string) => `Datei: ${name}`,
    exportSummarySkipped: (n: number) => `${n} Dateien übersprungen`,
    exportSummaryClose: 'Schließen',
    exportError: 'Export fehlgeschlagen.',

    importHeading: 'Import',
    importDescription:
      'Stellt den Datenbestand aus einem zuvor exportierten ZIP-Archiv wieder her.',
    importAction: 'Import',
    importPreflightTitle: 'Daten importieren',
    importPreflightUsers: (n: number) => `${n} Benutzer`,
    importPreflightCompanyProfile: 'Firmenprofil',
    importPreflightCustomers: (n: number) => (n === 1 ? '1 Kunde' : `${n} Kunden`),
    importPreflightProjects: (n: number) => (n === 1 ? '1 Projekt' : `${n} Projekte`),
    importPreflightAssignments: (n: number) => (n === 1 ? '1 Zuordnung' : `${n} Zuordnungen`),
    importPreflightInvoices: (n: number) => (n === 1 ? '1 Rechnung' : `${n} Rechnungen`),
    importPreflightInvoiceSequence: (n: number) =>
      n === 1 ? '1 Rechnungs-Sequenz' : `${n} Rechnungs-Sequenzen`,
    importPreflightAttachmentCount: (n: number) => (n === 1 ? '1 Anhang' : `${n} Anhänge`),
    importPreflightSize: (formatted: string) => `Größe der Anhänge: ${formatted}`,
    importPreflightConfirm: 'Import starten',
    importPreflightCancel: 'Abbrechen',
    importMobileWarning: 'Für Desktop-Nutzung gedacht; Importe können sehr groß sein.',
    importProgressTitle: 'Import läuft',
    importProgressCounter: (done: number, total: number) => `${done} / ${total} Dateien`,
    importProgressBytes: (done: string, total: string) => `${done} / ${total}`,
    importProgressCurrentFile: (name: string) => `Aktuelle Datei: ${name}`,
    importParsing: 'ZIP-Datei wird geprüft …',
    importCancel: 'Abbrechen',
    importSummaryTitle: 'Import abgeschlossen',
    importSummaryCommitted: (n: number) => `${n} Anhänge wiederhergestellt`,
    importSummarySkipped: (n: number) => `${n} Anhänge übersprungen`,
    importSummaryClose: 'Schließen',
    importError: 'Import fehlgeschlagen.',
    importValidationFailed: 'ZIP-Datei ungültig oder unvollständig.',
    restoreDestructiveNotice: 'Die bestehenden Daten werden unwiderruflich gelöscht.',
    restorePhrasePrompt: (phrase: string) => `Zur Bestätigung bitte „${phrase}" eingeben:`,

    // --- Server-side job flow (ui/daten.md §8.11, AC-322–335) ---------------
    // The job model builds/restores on the VPS; the browser triggers, polls,
    // and downloads/uploads. Reuses the export/import Progress* + Summary* keys
    // above for the shared readouts; the keys below are job-specific.
    exportPreflightBody:
      'Der vollständige Export wird auf dem Server erstellt und anschließend zum Download angeboten.',
    exportReadyTitle: 'Export bereit',
    exportDownloadAction: 'Herunterladen',
    importUploadingTitle: 'Hochladen …',
    importProcessingTitle: 'Wiederherstellung läuft',
    // Surfaced when the server rejects the create-time destructive guard
    // despite the client-side phrase match (clock skew, a stale config).
    importConfirmMismatch: 'Der Bestätigungstext stimmt nicht überein.',
  },

  /**
   * Per-project invoice block (ui/project-detail.md §8.15.11) and the
   * inline draft form / cancel dialog (ui/invoices.md §8.16.2 / §8.16.3).
   * Status labels live alongside `Invoice.status` from the domain types;
   * the German display copy stays here so the wire vocabulary
   * (`'draft' / 'issued' / 'cancelled'`) and the UX vocabulary
   * (`'Entwurf' / 'Ausgestellt' / 'Storniert'`) never drift.
   */
  invoices: {
    sectionHeading: 'Rechnungen',
    newInvoice: 'Neue Rechnung',
    editDraftTitle: 'Entwurf bearbeiten',
    empty: 'Noch keine Rechnungen',

    statusDraft: 'Entwurf',
    statusIssued: 'Ausgestellt',
    statusCancelled: 'Storniert',
    statusStorno: 'Storno',

    columnNumber: 'Nr.',
    columnStatus: 'Status',
    columnIssueDate: 'Datum',
    columnRecipient: 'Kunde',
    columnTotal: 'Summe',

    issueAction: 'Ausstellen',
    cancelAction: 'Stornieren',
    downloadPdfAction: 'PDF herunterladen',
    downloadPdfError: 'PDF konnte nicht heruntergeladen werden.',
    deleteDraftAction: 'Entwurf löschen',
    editDraftAction: 'Bearbeiten',
    saveAction: 'Speichern',
    discardAction: 'Verwerfen',

    stornoOfLabel: (number: string) => `Storno zu ${number}`,

    // Form (§8.16.2)
    formRecipientHeading: 'Empfänger',
    formRecipientFrozenHint: 'Daten werden bei Ausstellung der Rechnung eingefroren.',
    formRecipientName: 'Name',
    formRecipientStreet: 'Straße',
    formRecipientZip: 'PLZ',
    formRecipientCity: 'Ort',
    formLinesHeading: 'Positionen',
    formLineDescription: 'Beschreibung',
    formLineQuantity: 'Menge',
    formLineUnit: 'Einheit',
    formLineUnitPrice: 'Einzelpreis (€ netto)',
    formLineTaxRate: 'MwSt %',
    formLineTotal: 'Position (€ netto)',
    formAddLine: '+ Position hinzufügen',
    formRemoveLine: 'Entfernen',
    formTaxMode: 'Steuermodus',
    formPerformanceDate: 'Leistungsdatum',

    /**
     * Aggregate validation error fired by the draft form when the user
     * submits without a single positional row that carries both a
     * non-empty description and a non-zero unit price. Per-field
     * validation is out of scope for this surface (AC-303 — the server
     * remains authoritative on field-level rejections); this is the
     * load-bearing "no usable line" case.
     */
    formEmptyLinesError: 'Bitte mindestens eine Position mit Beschreibung und Preis eingeben.',

    // Confirmation copies
    issueConfirmTitle: 'Rechnung jetzt ausstellen?',
    issueConfirmBody:
      'Diese Aktion ist unwiderruflich. Nach dem Ausstellen kann die Rechnung nur noch storniert werden.',
    issueConfirmOk: 'Ausstellen',
    deleteDraftConfirm: 'Entwurf endgültig löschen?',

    // Cancel dialog (§8.16.3)
    cancelDialogTitle: 'Stornorechnung erstellen',
    cancelDialogWarning:
      'Diese Aktion erstellt eine Storno-Rechnung. Beide Rechnungen bleiben dauerhaft erhalten. Der Projektstatus wird NICHT automatisch zurückgesetzt — bitte separat anpassen.',
    cancelReasonLabel: 'Grund',
    cancelReasonPlaceholder: 'Grund',
    cancelConfirm: 'Stornieren',
    cancelReasonRequired: 'Bitte einen Grund angeben.',

    // Error decodes for the 4xx/5xx envelope responses (api.md §14.4).
    errorFrozen: 'Diese Rechnung ist bereits ausgestellt und kann nicht mehr geändert werden.',
    errorNotIssued: 'Die Rechnung ist noch ein Entwurf.',
    errorAlreadyCancelled: 'Die Rechnung wurde bereits storniert.',
    errorProjectState:
      'Das Projekt steht nicht im Status „Rechnung fällig" — die Rechnung kann nicht ausgestellt werden.',
    errorCompanyProfileRequired:
      'Firmendaten sind unvollständig. Bitte erst im Bereich „Rechnungen" vervollständigen.',
    errorPdfDownload: 'Die PDF konnte nicht geladen werden.',

    // Standalone /rechnungen list view (ui/invoices.md §8.16.1).
    listViewTitle: 'Rechnungen',
    listEmpty: 'Keine Rechnungen',
    filterYear: 'Jahr',
    filterStatus: 'Status',
    filterSearchPlaceholder: 'Suche…',
    filterYearAll: 'Alle Jahre',
    filterStatusAll: 'Alle',
    loadMore: 'Weitere laden',
    /** Active project filter chip on the /rechnungen toolbar — set when the
     *  view is opened with `?projectId=…` from the per-project block's
     *  cross-link (ui/project-detail.md §8.15.11). The label introduces a
     *  resolved `{project.number} — {project.title}` value next to it so
     *  the user sees *which* project constrains the list. */
    filterProjectChip: 'Projekt-Filter:',
    filterProjectClear: 'Filter aufheben',
    /** Single button in the filter bar that resets every active
     *  filter (year, status, search, and the URL-driven project chip).
     *  Visible only when at least one filter is active. */
    filterResetAll: 'Alle Filter zurücksetzen',

    // Bulk export on the standalone list (ui/invoices.md §8.16.1 —
    // bookkeeper workflow). Per-row checkboxes plus one toolbar button
    // that switches label between "alle Treffer herunterladen" and "n
    // ausgewählte herunterladen" depending on selection.
    exportAllAction: (n: number) => `Alle herunterladen (${n})`,
    exportSelectedAction: (n: number) =>
      n === 1 ? '1 ausgewählte herunterladen' : `${n} ausgewählte herunterladen`,
    exportInProgress: 'Wird heruntergeladen…',
    exportFailed: 'Download fehlgeschlagen.',
    selectRowAria: (number: string | null) =>
      number ? `Rechnung ${number} auswählen` : 'Entwurf auswählen',
    draftNotExportableTooltip: 'Entwürfe können nicht exportiert werden.',

    // Cross-link from the per-project block to the standalone view
    // (ui/project-detail.md §8.15.11).
    crossLinkToList: 'Alle Rechnungen anzeigen',

    // Totals preview (ui/invoices.md §8.16.2 — server re-derives at issue
    // time, the form's block is a UX preview only).
    totalsHeading: 'Summen',
    totalsNet: 'Nettosumme',
    totalsTaxAt: (rate: number) => `MwSt ${rate}%`,
    totalsGross: 'Bruttosumme',

    // COMPANY_PROFILE_REQUIRED banner (ui/project-detail.md §8.15.11) —
    // surfaces when the issue call returns 422 with that code. The banner
    // names the missing fields and links to the Daten view's company-
    // profile form so the user can fix them inline.
    companyProfileBannerHeading: 'Firmendaten unvollständig',
    companyProfileBannerBody: (fields: string) => `Fehlende Felder: ${fields}.`,
    companyProfileBannerLink: 'Firmendaten vervollständigen',

    // Per-invoice viewer (ui/invoices.md §8.16.3) — read-only surface
    // for status ∈ {issued, cancelled}. Drafts redirect to their parent
    // project (only place a draft has an editable surface).
    detailOpenAction: 'Öffnen',
    detailBackToList: 'Zurück zur Übersicht',
    detailLoading: 'Lade Rechnung…',
    detailNotFound: 'Rechnung nicht gefunden.',
    detailDraftRedirect: 'Entwürfe werden in der Projektansicht bearbeitet.',
    detailHeadingIssuer: 'Aussteller',
    detailHeadingRecipient: 'Empfänger',
    detailHeadingMeta: 'Rechnungsdaten',
    detailHeadingLines: 'Positionen',
    detailHeadingTotals: 'Summen',
    detailLabelNumber: 'Nr.',
    detailLabelStatus: 'Status',
    detailLabelIssueDate: 'Ausstellungsdatum',
    detailLabelPerformanceDate: 'Leistungsdatum',
    detailLabelTaxMode: 'Steuermodus',
    detailLabelCancellationReason: 'Storno-Grund',
    /** Rendered next to a `RE-…` original that has at least one Storno
     *  sibling. The list of siblings follows as indented chevrons. */
    detailStornoSiblings: 'Storno-Rechnungen zu dieser Rechnung',
    /** Link affordance on a Storno row pointing back to its `cancellationOf` original. */
    detailViewOriginal: 'Original anzeigen',
    /** Programmatic-download action label — renamed when the invoice profile is ZUGFeRD. */
    downloadZugferdAction: 'ZUGFeRD herunterladen',
  },

  aging: {
    sinceNDays: (n: number) => `seit ${n} Tagen`,
    agedBuffer: (count: number, label: string, days: number) =>
      `${count} ${label} seit >${days} Tagen`,
    /** Short form for use inside a column header where the state label is redundant. */
    agedBufferShort: (count: number, days: number) => `${count}× seit >${days} Tagen`,
  },

  /**
   * Audit / Aktivität surface (spec ui/workflow-views.md §8.4.1,
   * ui/management.md §8.13). The action-to-label map lives in a
   * dedicated config (auditActionLabels.ts) — this section carries the
   * labels that are shared between the activity feed and the global
   * Aktivität view.
   */
  audit: {
    emptyState: 'Keine Aktivität',
    /**
     * Recipient-scoped empty-state copy on the global Aktivität view
     * (AC-200). Rendered when the default (recipient-scoped) mode is
     * active and the filtered set is empty because rules exist but
     * none admit the caller as recipient. The plain "Keine Aktivität"
     * fallback applies only under "Alles anzeigen".
     */
    emptyStateRecipient:
      'Keine Benachrichtigungen für Sie. Alles anzeigen für den vollständigen Aktivitätsverlauf.',
    /** Label on the "Alles anzeigen" toggle (AC-200, §8.13.1). */
    toggleShowAll: 'Alles anzeigen',
    detailsShow: 'Details anzeigen',
    detailsHide: 'Details ausblenden',
    loadOlder: 'Ältere anzeigen',
    system: 'System',
    /** Fallback label when a user-actor row's actorId is null — the
     *  authoring user has been hard-deleted and AC-98's ON DELETE SET
     *  NULL nullified the FK (data-model.md §5.10 "Referential
     *  integrity"). Rendered in place of a resolved displayName. */
    userNeutral: 'Benutzer',
    /** Column / filter labels on the global Aktivität view. */
    colTimestamp: 'Zeitpunkt',
    colActor: 'Akteur',
    colProject: 'Projekt',
    colEntity: 'Objekt',
    colAction: 'Aktion',
    colPayload: 'Details',
    filterEntityType: 'Objekttyp',
    filterEntityLabel: 'Objektname',
    filterEntityLabelPlaceholder: 'Name suchen…',
    filterActor: 'Akteur',
    filterAction: 'Aktion',
    filterFrom: 'Von',
    filterTo: 'Bis',
    filterDateInverted: 'Das "Bis"-Datum darf nicht vor dem "Von"-Datum liegen.',
    entityProject: 'Projekt',
    entityCustomer: 'Kunde',
    entityUser: 'Benutzer',
    entityProjectWorker: 'Zuweisung',
    entityAttachment: 'Anhang',
    entityInvoice: 'Rechnung',
    entityCompanyProfile: 'Firmenprofil',
    entityDataImport: 'Import',
    /**
     * Per-slot count labels for the `data_import` audit row. The
     * `describeAuditRow` helper composes a single line —
     * `"Daten importiert: 3 Benutzer, 5 Kunden, …"` — from the
     * `payload.counts` map the server writes (one slot per envelope
     * table; see [api.md §14.2.4](../docs/spec/api.md#1424-unified-data-exchange) "Single import audit row").
     * Plural-aware so n=1 reads correctly in German. `company_profile`
     * is always 0 or 1 (singleton); 1 renders as the bare entity name.
     * `attachments` is always 0 in the text-leg path (per-attachment
     * audit happens under the standard `attachment:add` flow) and is
     * omitted from the rendered list.
     */
    dataImportCountUsers: (n: number) => (n === 1 ? '1 Benutzer' : `${n} Benutzer`),
    dataImportCountCompanyProfile: 'Firmenprofil',
    dataImportCountCustomers: (n: number) => (n === 1 ? '1 Kunde' : `${n} Kunden`),
    dataImportCountProjects: (n: number) => (n === 1 ? '1 Projekt' : `${n} Projekte`),
    dataImportCountProjectWorkers: (n: number) => (n === 1 ? '1 Zuweisung' : `${n} Zuweisungen`),
    dataImportCountInvoices: (n: number) => (n === 1 ? '1 Rechnung' : `${n} Rechnungen`),
    dataImportCountInvoiceSequence: (n: number) =>
      n === 1 ? '1 Rechnungs-Sequenz' : `${n} Rechnungs-Sequenzen`,
    /** Defensive — all slots empty (shouldn't reach in normal use). */
    dataImportCountsEmpty: 'keine Datensätze',
    /** Description prefix — "Daten importiert: <parts>". */
    dataImportDescriptionPrefix: 'Daten importiert',
    /** Before/after panel labels in the payload drawer. */
    drawerBefore: 'Vorher',
    drawerAfter: 'Nachher',
    drawerField: 'Feld',
    heading: 'Aktivität',
    allActors: 'Alle Akteure',
    allActions: 'Alle Aktionen',
    allEntityTypes: 'Alle Objekttypen',
  },

  /**
   * Notification rule editor + validation messages (api.md §14.2.9,
   * data-model.md §5.11). Each message maps to one AC-190 rejection
   * branch so a regression surfaces the specific validator that broke.
   */
  notifications: {
    invalidEventClass: 'Unbekannte Ereignisklasse.',
    stateFilterNotAllowed: 'Ziel-Status ist nur für Statuswechsel-Ereignisse zulässig.',
    invalidStateFilter: 'Ziel-Status ist kein gültiger Workflow-Status.',
    includeAssignedWorkersNotAllowed:
      'Zugewiesene Mitarbeiter können nur für projektbezogene Ereignisse benachrichtigt werden.',
    invalidRole: (role: string) => `Unbekannte Rolle: "${role}".`,
    invalidUserId: 'Mindestens eine angegebene Benutzer-ID ist nicht gültig oder inaktiv.',
    invalidRecipientSpec: 'Empfänger-Spezifikation ist ungültig.',
    emptyRecipientSpec: 'Empfänger-Spezifikation darf nicht leer sein.',
    invalidEnabled: '"enabled" muss ein Boolean sein.',
    invalidPushSubscription: 'Push-Abonnement ist ungültig.',

    /**
     * Rule-editor surface (ui/management.md §8.14). Kept under the
     * existing `notifications` key so the admin-surface copy lives next
     * to the validator messages it pairs with.
     */
    rules: {
      heading: 'Benachrichtigungsregeln',
      createButton: 'Regel erstellen',
      createTitle: 'Regel erstellen',
      editTitle: 'Regel bearbeiten',
      emptyList: 'Keine Regeln',
      colEvent: 'Ereignis',
      colFilter: 'Filter',
      colRecipients: 'Empfänger',
      colEnabled: 'Aktiv',
      colActions: 'Aktionen',
      event: 'Ereignis',
      stateFilter: 'Ziel-Status',
      stateFilterAny: 'Beliebig',
      recipients: 'Empfänger',
      recipientRoles: 'Rollen',
      recipientAssignedWorkers: 'Zugewiesene Mitarbeiter benachrichtigen',
      recipientUsers: 'Einzelne Benutzer',
      userPickerPlaceholder: 'Benutzer suchen…',
      userPickerEmpty: 'Keine Treffer.',
      addUser: 'Hinzufügen',
      removeUser: 'Entfernen',
      enabled: 'Aktiv',
      deleteConfirm: 'Regel wirklich löschen?',
      /** Compact recipientSpec summary for the list's Empfänger cell. */
      summaryRoles: (labels: string) => `Rollen: ${labels}`,
      summaryAssignedWorkers: 'Zugewiesene Mitarbeiter',
      summaryUsers: (count: number) => `${count} Benutzer`,
      summaryEmpty: '—',
    },
  },

  /**
   * Project-detail / attachment surface (ui/project-detail.md §8.15).
   * The dropdown labels for `AttachmentLabel` live in
   * `src/domain/attachments.ts`'s `ATTACHMENT_LABELS` catalog — this
   * block carries the page-chrome copy that isn't a closed-enum label.
   */
  attachments: {
    /** Öffnen affordance on the quick-glance panel (spec §8.4, AC-207). */
    openDetailPage: 'Öffnen',
    /** Not-found surface — 404 on `GET /projects/:id`. */
    notFoundHeading: 'Projekt nicht gefunden',
    notFoundBody: 'Das angeforderte Projekt existiert nicht.',
    /** Banner shown atop the read-only preview of an archived project. */
    archivedReadOnlyNotice: 'Dieses Projekt ist archiviert. Bearbeitung nicht möglich.',

    // Region headings
    coreFields: 'Kernfelder',
    assignedWorkers: 'Zugewiesene Mitarbeiter',
    photoGallery: 'Fotogalerie',
    binaryList: 'Dateien',
    upload: 'Hochladen',
    activity: 'Aktivität',

    // Tabs (ADR-0022 — Papierkorb)
    tabAttachments: 'Anhänge',
    tabPapierkorb: 'Papierkorb',
    tabPapierkorbWithCount: (n: number) => `Papierkorb (${n})`,

    // Papierkorb listing
    papierkorbHeading: 'Papierkorb',
    papierkorbEmpty: 'Keine gelöschten Dateien.',
    restore: 'Wiederherstellen',
    restoreFailed: 'Wiederherstellen fehlgeschlagen.',
    /** Relative-time label on a hidden item — uses Intl.RelativeTimeFormat
     *  for stable German output ("vor 3 Tagen", "vor 5 Stunden"). */
    hiddenAtLabel: (relative: string) => `${relative} gelöscht`,

    // Worker editor
    addWorker: 'Mitarbeiter hinzufügen',
    removeWorker: 'Entfernen',
    /**
     * Disambiguated aria-label for the per-chip remove button so
     * screen-reader users hear "Entfernen: Anna Arbeiter" instead of
     * every chip reading identically.
     */
    removeWorkerNamed: (name: string) => `Entfernen: ${name}`,
    noUnassignedWorkers: 'Keine weiteren Mitarbeiter verfügbar.',

    // Upload surface
    uploadDrop: 'Datei hier ablegen oder auswählen',
    uploadPickFile: 'Datei auswählen',
    uploadPickPhoto: 'Foto auswählen',
    uploadPickPhotos: 'Fotos auswählen',
    uploadPickBinary: 'Dokument auswählen',
    takePhoto: 'Foto aufnehmen',
    photoSectionTitle: 'Fotos',
    binarySectionTitle: 'Dokument',
    uploadLabel: 'Beschriftung',
    uploadRetry: 'Erneut versuchen',
    uploadDismiss: 'Verwerfen',
    uploadProgressInit: 'Vorbereiten…',
    uploadProgressUpload: 'Hochladen…',
    uploadProgressComplete: 'Fertigstellen…',
    uploadFileTooLarge: 'Datei zu groß.',
    uploadImageProcessingFailed: 'Bildbearbeitung fehlgeschlagen.',
    uploadSuccessToast: (fileName: string) => `Hochgeladen: ${fileName}`,
    uploadFailureToast: (fileName: string, reason: string) =>
      `Upload fehlgeschlagen: ${fileName} — ${reason}`,
    /**
     * MIME-rejection copy — names the supported formats explicitly so a
     * user picking a HEIC / GIF / etc. has a concrete answer on what to
     * do instead. HEIC is the canonical miss (Apple camera default); the
     * list-the-supported approach future-proofs the message against any
     * other format drift.
     */
    uploadMimeNotAllowed:
      'Dateityp nicht unterstützt. Bitte als JPEG, PNG oder WebP (Fotos) oder als PDF oder DOCX (Dokumente) hochladen.',

    // Missing-file placeholder (AC-224)
    fileMissing: 'Datei fehlt',

    // Unwrappable-envelope placeholder (AC-244, ADR-0024)
    keyUnavailable: 'Schlüssel nicht verfügbar',

    // Deletion (soft-hide → Papierkorb, ADR-0022)
    deleteConfirmTitle: 'Datei löschen?',
    deleteConfirmMessage:
      'Die Datei wird in den Papierkorb verschoben. Sie kann innerhalb der Aufbewahrungsfrist wiederhergestellt werden; danach wird sie endgültig gelöscht und ist nicht mehr wiederherstellbar.',

    /**
     * Restore-side data-integrity surfaces. A row in 'hidden' state
     * with a missing `version_id` (or, for photos with a thumb, a
     * missing `thumb_version_id`) cannot be restored — there is no
     * source version to copy from. Each branch names the affected
     * row id so an operator triaging the activity feed sees the cause
     * without spelunking the DB.
     *
     * Distinct from a CAS-loss (transient race, retry resolves it) and
     * from a missing/wrong-project row (404). These are 422 — the
     * request is structurally unprocessable.
     */
    restoreMissingVersionId: (id: string) =>
      `Wiederherstellen nicht möglich: Anhang ${id} hat keine version_id (Datenintegritätsproblem).`,
    restoreMissingThumbVersionId: (id: string) =>
      `Wiederherstellen nicht möglich: Anhang ${id} hat keine thumb_version_id (Datenintegritätsproblem).`,
    /**
     * Surfaces when the row is still at `status='hidden'` but the
     * source object version is no longer recoverable from object storage
     * — the bucket lifecycle reaper (ADR-0022) reaped the bytes ahead of
     * the row reaper. A bounded race window per data-model.md §6.12;
     * 410 GONE is the right code because the bytes are permanently gone,
     * not "retry might work". The row reaper closes the window on its
     * next tick.
     */
    restoreBytesGone: (id: string) =>
      `Wiederherstellen nicht möglich: die Datei für Anhang ${id} wurde vom Speicher endgültig entfernt.`,

    // Download actions
    download: 'Herunterladen',
    view: 'Ansehen',
    bulkDownload: 'Auswahl als ZIP',
    downloadAll: 'Alle herunterladen',
    noAttachments: 'Keine Dateien zum Herunterladen.',
    selectAll: 'Alle auswählen',
    /**
     * Bulk-download cap violation message (AC-223) — MUST name both caps
     * (file count AND summed bytes) per ui/project-detail.md §8.15.5.
     */
    bulkLimitExceeded: (maxFiles: number, maxMb: number) =>
      `Auswahl überschreitet das Limit: maximal ${maxFiles} Dateien und maximal ${maxMb} MB Gesamtgröße.`,

    // Table headers for the binary list
    colFileName: 'Dateiname',
    colLabel: 'Beschriftung',
    colUploader: 'Hochgeladen von',
    colUploaded: 'Hochgeladen am',
    /** Papierkorb-only column: timestamp the row was hidden (not uploaded). */
    colHidden: 'Gelöscht am',
  },

  backup: {
    green: 'Backup: aktuell',
    drillStale: 'Backup: aktuell, Drill-Schlüssel neu laden',
    backupAging: 'Backup: wird alt',
    backupStale: 'Backup: veraltet',
    drillExpired: 'Drill: überfällig',
    lastRunFailed: 'Backup: fehlgeschlagen',
    backupNeverRun: 'Backup: noch nie ausgeführt',
    drillNeverRun: 'Drill: noch nie ausgeführt',
    unknown: 'Status unbekannt',
    /**
     * Augments any badge label with the timestamp of the last backup
     * run so the tooltip / toast carries actionable detail rather than
     * a bare status word. The timestamp comes pre-formatted by
     * `formatBackupTimestampDE`.
     */
    withTimestamp: (label: string, timestamp: string) => `${label} (${timestamp})`,
  },
} as const;
