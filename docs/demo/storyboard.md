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
- **Output:** one seamless master (`npm run demo` → `test-results/demo-master.mp4`, staged to
  `demo-clips/` for upload). A ~8 s muted **webp loop** (`assets/demo-hero.webp`, cut from the
  Daten reveal) is the clickable README hero → Vimeo.

## Shot list

Actual segment timings in the shipped ~1:30 master. ★ = money shot.

| #   | ~time       | Beat        | User · viewport                  | On-screen actions                                                                       | Spec                   |
| --- | ----------- | ----------- | -------------------------------- | --------------------------------------------------------------------------------------- | ---------------------- |
| 00  | 0:00–0:05   | Cold open   | title card                       | _»Ich habe zu arbeiten.«_ → _Darum passt sich die Software an Sie an._                  | `demo-00-open`         |
| 01  | 0:05–0:24   | Intake      | office · desktop                 | email-extract modal: paste inquiry → LLM extract → review prefilled form → save         | `demo-01-intake`       |
| 02  | 0:24–0:37 ★ | Daten       | owner · desktop                  | establish the live board → blur it → reveal the four backend guarantees as cards        | `demo-02-daten`        |
| 03  | 0:37–0:46 ★ | Living dock | owner · desktop (+ worker actor) | expand the dock; a field worker's site photo lands live, no refresh (no Dropbox detour) | `demo-03-dock`         |
| 04  | 0:46–0:59   | Field       | worker · mobile                  | "Meine Projekte" (only their jobs) → open a job → upload a site photo                   | `demo-04-field.mobile` |
| 05  | 0:59–1:11   | Invoice     | office · desktop                 | open an issued invoice → download the ZUGFeRD PDF                                       | `demo-05-invoice`      |
| 06  | 1:11–1:24 ★ | Coda        | owner · desktop                  | green backup badge (click → status toast) + one-click full export                       | `demo-06-coda`         |
| 99  | 1:24–1:30   | Thesis      | title card                       | _Für Sie gebaut_ + the "built to be distrusted" bassline                                | `demo-99-thesis`       |

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

## Production / harness notes

- **Single-pass master** — `scripts/demo/encode.mjs --master` builds the whole 1920×1080
  master in one ffmpeg `filter_complex`: each source clip is normalized onto the canvas
  (desktop scaled+padded with the app's dark navy; the phone clip composited onto the blurred
  backdrop with a white bezel), then concatenated and encoded **once** (libx264, CRF 17,
  preset slow). The old three-encode pipeline (webm→mp4→norm→concat) smeared text and bred
  mosquito noise; one decode → one filter → one encode keeps the type crisp. `npm run demo`
  records serially (`--workers=1`, since several beats mutate the shared e2e DB), masters, and
  cuts the hero.
- **Ordering** — segment specs carry zero-padded numeric prefixes (`demo-00` … `demo-99`); the
  master sorts source paths lexically, so filename order = narrative order (the mobile clip's
  `demo-04` prefix slots it between 03 and 05). Mobile beats use a `.mobile.spec.ts` infix + a
  `testMatch` split so they record under `demo-mobile` only.
- **Persona chips (`demo.scene`)** — each persona segment calls `demo.scene({ name, role,
device })` after its first load; the overlay pops a prominent top-left chip (blue accent,
  device glyph) that holds ~3.8 s, then fades. Office = Maria Schmidt, owner = Thomas Berger, worker = Jan Nowak (the seeded
  `arbeiter1`). The Daten and title-card segments carry no chip.
- **Daten reveal (`demo.revealFacts`, beat 02)** — the owner lands on the live board; the
  overlay then drops a frosted-glass layer (`backdrop-filter: blur`) over the real app and
  floats the four guarantees as fact cards. The thing being shown has no UI — it lives in the
  server, the object store, and the backup drills — so the reveal narrates it over the blurred
  data it protects, balancing plain-language melody with a technical bassline per card.
- **Live cross-user shot (beat 03)** — the owner's page is recorded; a second
  `browser.newContext()` (a field WORKER) uploads a site photo through the real, browser-side
  encrypted attachment pipeline, and the `Datei hinzugefügt` row appears in the owner's dock
  via the `audit_changed` SSE push — the field→office moment that today goes through Dropbox +
  a WhatsApp to the office. Targets the worker's second assigned project (`.nth(1)`) so it does
  not collide with the field segment's (04) own upload (`.first()`); MyProjectsView sorts by
  plannedStart, which an upload never changes, so the positions stay stable + distinct. Mirrors
  `e2e/activity-dock.spec.ts` AC-317; the dock shows the full RBAC-scoped feed, so any mutation
  surfaces for the owner observer.
- **Title cards (00, 99)** — styled HTML rendered via `page.setContent` over a darkened
  backdrop, recorded like a segment (desktop). No `drawtext`, no app screen.
- **Green backup badge (coda)** — a demo-gated upsert in `e2e/auth.setup.ts` (only when
  `PLAYWRIGHT_RUN_DEMO` is set) writes a healthy `meta_backup_status`, so the badge reads
  green; normal e2e keeps the real default. Clicking the badge fires a status toast.
- **Continuity is narrative, not DB threading** — segments record against the shared seed,
  stitched by consistent naming + captions; no live project is threaded across specs.
- **Primitives** — captions / cursor / eased glide / persona chip / fact-reveal in
  `e2e/demo-helpers.ts`; per-role sessions in `e2e/storage-states.ts`.

## README integration (manual — README is read-only for AI)

The hero loop `assets/demo-hero.webp` is built from the Daten reveal (large, readable, on
brand) by `npm run demo:hero`. The README links it to Vimeo:

```html
<a href="https://vimeo.com/YOUR_ID">
  <img src="assets/demo-hero.webp" alt="Projekt-Manager — Demo" width="80%" />
</a>
```

One video, one entry point; the master includes mobile. The hero is a quality-first animated
webp (~0.8 MB, well under GitHub's inline-animation limit); `--hero-static` emits a single
crisp frame as a fallback if a still is ever preferred.

## Verification status

Shipped: 8 segments record clean (**13 passed**), the single-pass master concatenates to
1920×1080 / ~1:30, and every beat is frame-verified — the persona chips, the Daten fact-card
reveal over the blurred board, the live cross-session dock row, the phone-on-backdrop
composite, the ZUGFeRD invoice, and the German dual-register captions. Text is crisp (no
generational artifacts) and the hero loop is readable. Remaining manual steps: upload
`demo-clips/demo-master.mp4` to Vimeo and apply the README snippet above.
