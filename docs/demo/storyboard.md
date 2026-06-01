# Demo Video — Storyboard & Shot List

> Status: **shipped.** Eight segment specs (`e2e/demo-0X-*.spec.ts`) record under the
> `demo` / `demo-mobile` Playwright projects; `scripts/demo/encode.mjs --master` (run via
> `npm run demo`) stitches them into one 1920×1080 master (~1:30) in a single ffmpeg pass,
> and `--hero` cuts the README loop. Upload the master to Vimeo and link it from the README
> hero (`assets/demo-hero.webp`).

## Purpose

One seamless ~1½-minute film for the README hero, linked to Vimeo. It presents the app
broadly without dragging. The visible engineering (live audit, RBAC, the invoice pipeline)
is shown; the _invisible_ engineering (encryption, immutable backups, drills) — which has no
UI — is surfaced as a deliberate reveal rather than left unsaid.

## Audience & thesis

The film carries two theses for two audiences, woven so neither talks down to the other:

- **Melody — for the real user (a Handwerker, clueless about the tech):**
  _"This was built around **you**. It adapts to how you already work — not the other
  way around."_ Leads everywhere.
- **Bassline — for the engineer / portfolio viewer:**
  _"Built to be distrusted — the app will fail and the user will try to break it — which
  is exactly why the data survives."_ Rides underneath as proof; concentrated in the
  Daten reveal, the technical grace notes, and the coda.

They converge in the closing card: _made for you_ **and** _guards your data_. The two
theses mirror the README's two pillars — "Who is this for" and "Data integrity, Security".

## Spine — "one job, three hands, one living board"

Follow a single company's day through the people it touches. Personas are the hands the work
passes through (named by a self-dismissing chip at each cut); the activity dock is the
omniscient through-line; the data segment steps out of the app to show what guards it.

```
   inquiry email
        │
        ▼
   OFFICE · desktop — LLM-extract → project created     data intake + the user-first touch
        │
        ▼
   DATEN · the heart — blur the board, reveal the      ★ data integrity, made visible
        │  invisible guarantees (encryption, WORM,         (encryption · WORM · tested backups)
        │  tested backups)
        ▼
   OWNER · desktop — kanban + activity dock            ★ killer feature: the company, alive
        │  live, cross-user, no refresh
        ▼
   FIELD WORKER · mobile — only their jobs · upload     RBAC by absence + data from the field
        │
        ▼
   OFFICE · invoice (ZUGFeRD) → PDF                     the pipeline pays off
        │
        ▼
   CODA — green backup badge · one-click export        ★ built-to-be-distrusted payoff
```

## Format & constraints

- **Length:** ~1:30 (eight segments). Pace varies — quick transitions, dwell on money shots.
- **Aspect:** 16:9 (1920×1080). Silent, burned-in captions (no voiceover), **German**.
- **Persona chips:** each persona segment opens with a small, self-dismissing top-left chip
  (name · role · device) so a stitched film keeps the viewer oriented across cuts.
- **Mobile:** the field segment records at a phone viewport (Pixel 7) and is composited at
  encode onto a blurred, darkened construction backdrop with a border — uniform 1920×1080,
  reading as a phone on-site. No phone is physically recorded; "taking a photo" is a file
  upload of a pre-staged site photo (`e2e/fixtures/demo/site-1.jpg`).
- **Output:** one seamless master (`npm run demo` → `demo-clips/demo-master.mp4`, ready for
  upload). A ~8 s muted **webp loop** (`assets/demo-hero.webp`, cut from the
  Daten reveal) is the clickable README hero → Vimeo.

## Shot list

Actual segment timings in the shipped ~1:30 master. ★ = money shot.

| #   | ~time       | Beat        | User · viewport                  | On-screen actions                                                                    | Spec                   |
| --- | ----------- | ----------- | -------------------------------- | ------------------------------------------------------------------------------------ | ---------------------- |
| 00  | 0:00–0:05   | Cold open   | title card                       | _»Ich habe zu arbeiten.«_ → _Darum passt sich die Software an Sie an._               | `demo-00-open`         |
| 01  | 0:05–0:24   | Intake      | office · desktop                 | email-extract modal: paste inquiry → LLM extract → review prefilled form → save      | `demo-01-intake`       |
| 02  | 0:24–0:37 ★ | Daten       | owner · desktop                  | establish the live board → blur it → reveal the four backend guarantees as cards     | `demo-02-daten`        |
| 03  | 0:37–0:46 ★ | Living dock | owner · desktop (+ worker actor) | expand the dock; a field worker's site photo lands live, no refresh, no manual relay | `demo-03-dock`         |
| 04  | 0:46–0:59   | Field       | worker · mobile                  | "Meine Projekte" (only their jobs) → open a job → upload a site photo                | `demo-04-field.mobile` |
| 05  | 0:59–1:11   | Invoice     | office · desktop                 | open an issued invoice → download the ZUGFeRD PDF                                    | `demo-05-invoice`      |
| 06  | 1:11–1:24 ★ | Coda        | owner · desktop                  | green backup badge (click → status toast) + one-click full export                    | `demo-06-coda`         |
| 99  | 1:24–1:30   | Thesis      | title card                       | _Für Sie gebaut_ + the "built to be distrusted" bassline                             | `demo-99-thesis`       |

## Caption registers

Human caption = the primary bottom banner. Technical note = a smaller second line, only on
the grace-note beats. The Daten reveal (02) replaces both with its own frosted-glass card
stack (each card pairs a melody line with a technical bassline). German throughout.

| Beat       | Human (melody)                                              | Technical (bassline)                                                                                 |
| ---------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 01 Intake  | „Einfügen genügt – den Rest erledigt die App."              | —                                                                                                    |
| 02 Daten   | (reveal card stack — see below)                             | (reveal card stack — see below)                                                                      |
| 03 Dock    | „Alle Aktivitäten – die ganze Firma auf einen Blick."       | „Live-Audit über SSE – jede Änderung, jeder Nutzer"                                                  |
| 04 Field   | „Unterwegs: nur die eigenen Einsätze."                      | „rollenbasiert – serverseitig erzwungen, nicht nur ausgeblendet"                                     |
| 05 Invoice | „Ein Klick: fertiges PDF – ZUGFeRD-konform fürs Finanzamt." | „ZUGFeRD / EN16931 – XML im PDF/A-3 eingebettet"                                                     |
| 06 Coda    | „Und alles gehört Ihnen."                                   | „verschlüsselte Off-Site-Backups · providerseitig gesperrt · auch bei App-Ausfall wiederherstellbar" |

The 00 and 99 title cards carry the melody open and the converged thesis (melody + bassline).

### Daten reveal (02) — the card stack

Title _Daten – das Herzstück des Betriebs_ over the blurred board, subtitle _Die App geht vom
Schlimmsten aus – und sorgt vor._, then four cards rise in turn (melody / bassline):

1. _Nichts verlässt die App im Klartext._ / `Anhänge Ende-zu-Ende verschlüsselt · AES-256-GCM · Schlüssel nie auf der Platte`
2. _Was bleiben muss, löscht niemand – auch die App nicht._ / `WORM-Objektspeicher · Object-Lock providerseitig · App-Key ohne Löschrecht`
3. _Ransomware, Absturz, Bedienfehler – einkalkuliert._ / `mehrstufig & verschlüsselt · providerseitig gesperrt · mit App-Zugang nicht löschbar`
4. _Sicherung automatisch – und automatisch erprobt._ / `DB-Dump mehrmals täglich · Restore-Drill gegen Echtdaten, nicht gegen Hoffnung`

Closing punch line: _Wir rechnen mit dem Ausfall. Darum hält Ihr Betrieb._ After it, a
slideshow-style progress bar drains away the segment's remaining seconds, so the cut reads as
"the slide is timed" rather than waiting on the viewer.

## Out of scope (curation beats completeness)

Calendar, user admin, bookkeeper view, push notifications, the attachment recycle-bin
(`Papierkorb`), live invoice issuance, the invoice-frozen refusal, backup drills, and the
referential-integrity delete-refusal. All real; none earned its seconds against the spine.
(The delete-refusal was an earlier beat-02 draft — a true feature, but trivial against the
backend guarantees the reveal now carries, so it was cut.)

## Beat-specific calls

How the harness records, encodes, orders, and cuts the hero is in
[docs/testing/demo-recordings.md](../testing/demo-recordings.md). Below are only the
decisions that belong to _this film_.

- **Persona casting (`demo.scene`)** — office = Maria Schmidt, owner = Thomas Berger, worker =
  Jan Nowak (the seeded `arbeiter1`). The Daten and title-card segments carry no chip.
- **Daten reveal (`demo.revealFacts`, beat 02)** — the owner lands on the live board; the
  reveal then floats the four backend guarantees as fact cards over the blurred data they
  protect. The subject has no UI — it lives in the server, the object store, and the backup
  drills — so each card pairs a plain-language melody line with a technical bassline.
- **Live cross-user shot (beat 03)** — the owner's page is recorded while a second
  `browser.newContext()` (a field WORKER) uploads a site photo, and the `Datei hinzugefügt`
  row appears in the owner's dock — the field→office moment that today goes through Dropbox +
  a WhatsApp. The upload targets the worker's _second_ assigned project (`.nth(1)`) so it does
  not collide with the field segment's (04) own upload (`.first()`); `MyProjectsView` sorts by
  `plannedStart`, which an upload never changes, so the two positions stay stable and distinct.
- **Title cards (00, 99)** — styled HTML over a darkened backdrop, recorded like a segment.
- **Green backup badge (coda)** — the badge must read green for the data-integrity coda, so the
  demo seeds a healthy `meta_backup_status` (see demo-recordings.md). Clicking it fires a
  status toast.
- **Aged-buffer badge (live-board beats)** — left ON, not hidden: "make inaction visible" is
  the product's headline, so the Abgerechnet column carries its `⚠ N× seit >30 Tagen` warning.
  The seed parks two invoiced-but-unpaid projects a little past the 30-day threshold
  (`seed/invoices.ts` `finalStatusChangedAtDaysFromNow`) for realistic ages.
- **Continuity is narrative, not DB threading** — segments record against the shared seed,
  stitched by consistent naming + captions; no live project is threaded across specs.

## README entry point

The README hero links `assets/demo-hero.webp` (cut by `npm run demo:hero`) to the Vimeo film —
one video, one entry point, mobile included. README is read-only for AI, so the link is applied
by hand.

## Verification status

All eight segments record clean and the single-pass master concatenates to 1920×1080 / ~1:30,
frame-verified end to end — persona chips, the Daten fact-card reveal over the blurred board,
the live cross-session dock row, the phone-on-backdrop composite, the ZUGFeRD invoice, and the
German dual-register captions. Remaining manual step: upload `demo-clips/demo-master.mp4` to
Vimeo.
