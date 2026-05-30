# Demo Video — Storyboard & Shot List

> Status: **shipped.** Eight segment specs (`e2e/demo-0X-*.spec.ts`) record under the
> `demo` / `demo-mobile` Playwright projects; `scripts/demo/encode.mjs --master` (run via
> `npm run demo`) concatenates them into one 1920×1080 master (~1:25). Upload to Vimeo and
> link it from the README hero (`assets/demo-hero.webp`).

## Purpose

One seamless ~1½-minute film for the README hero, linked to Vimeo. It presents the app
broadly without dragging, and makes the invisible engineering (data integrity, RBAC, live
audit) _visible_ rather than narrated.

## Audience & thesis

The film carries two theses for two audiences, woven so neither talks down to the other:

- **Melody — for the real user (a Handwerker, clueless about the tech):**
  _"This was built around **you**. It adapts to how you already work — not the other
  way around."_ Leads everywhere.
- **Bassline — for the engineer / portfolio viewer:**
  _"Built to be distrusted — the app will fail and the user will try to break it — which
  is exactly why the data survives."_ Rides underneath as proof; concentrated in the
  technical grace notes and the coda.

They converge in the closing card: _made for you_ **and** _guards your data_. The two
theses mirror the README's two pillars — "Who is this for" and "Data integrity, Security".

## Spine — "one job, three hands, one living board"

Follow a single project through the company. Personas are the hands it passes through; the
activity dock is the omniscient through-line; each invisible fact surfaces the moment it
becomes relevant.

```
   inquiry email
        │
        ▼
   OFFICE · desktop — LLM-extract → project created     data intake + the user-first touch
        │
        ▼
   OWNER · try to delete live data → REFUSED           ★ data integrity, shown by refusal
        │  every step logs into…
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

- **Length:** ~1:25 (eight segments). Pace varies — quick transitions, dwell on money shots.
- **Aspect:** 16:9 (1920×1080). Silent, burned-in captions (no voiceover), **German**.
- **Mobile:** the field segment records at a phone viewport (Pixel 7) and is composited at
  encode onto a blurred, darkened construction backdrop with a border — uniform 1920×1080,
  reading as a phone on-site. No phone is physically recorded; "taking a photo" is a file
  upload of a pre-staged site photo (`e2e/fixtures/demo/site-1.jpg`).
- **Output:** one seamless master (`npm run demo` → `test-results/demo-master.mp4`). A ~6.5 s
  muted **webp loop** (`assets/demo-hero.webp`, cut from the live-dock beat) is the clickable
  README hero → Vimeo.

## Shot list

Actual segment timings in the shipped 1:25 master. ★ = money shot.

| #   | ~time       | Beat        | User · viewport                  | On-screen actions                                                               | Spec                   |
| --- | ----------- | ----------- | -------------------------------- | ------------------------------------------------------------------------------- | ---------------------- |
| 00  | 0:00–0:05   | Cold open   | title card                       | _»Ich habe zu arbeiten.«_ → _Also passt sich die Software an Sie an._           | `demo-00-open`         |
| 01  | 0:05–0:23   | Intake      | office · desktop                 | email-extract modal: paste inquiry → LLM extract → review prefilled form → save | `demo-01-intake`       |
| 02  | 0:23–0:35 ★ | Integrity   | owner · desktop                  | delete a customer with a live project (Familie Müller) → confirm → **refused**  | `demo-02-integrity`    |
| 03  | 0:35–0:43 ★ | Living dock | owner · desktop (+ office actor) | expand the dock on the board; a colleague's new project lands live, no refresh  | `demo-03-dock`         |
| 04  | 0:43–0:56   | Field       | worker · mobile                  | "Meine Projekte" (only their jobs) → open a job → upload a site photo           | `demo-04-field.mobile` |
| 05  | 0:56–1:07   | Invoice     | office · desktop                 | open an issued invoice → download the ZUGFeRD PDF                               | `demo-05-invoice`      |
| 06  | 1:07–1:19 ★ | Coda        | owner · desktop                  | green backup badge (click → status toast) + one-click full export               | `demo-06-coda`         |
| 99  | 1:19–1:25   | Thesis      | title card                       | _Für Sie gebaut_ + the "built to be distrusted" bassline                        | `demo-99-thesis`       |

## Caption registers

Human caption = the primary bottom banner (every beat). Technical note = a smaller second
line, only on the grace-note beats. German throughout.

| Beat         | Human (melody)                                           | Technical (bassline)                                                             |
| ------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 01 Intake    | „Einfügen genügt – den Rest erledigt die App."           | —                                                                                |
| 02 Integrity | „Die App schützt die Daten – auch vor Ihnen."            | „referenzielle Integrität – serverseitig, in einer Transaktion geprüft"          |
| 03 Dock      | „Der Aktivitäts-Dock – die ganze Firma auf einen Blick." | „Live-Audit über SSE – jede Änderung, jeder Nutzer"                              |
| 04 Field     | „Unterwegs: nur die eigenen Einsätze."                   | „rollenbasiert – serverseitig erzwungen, nicht nur ausgeblendet"                 |
| 05 Invoice   | „Ein Klick: als PDF – oder ZUGFeRD fürs Finanzamt."      | „ZUGFeRD / EN16931 – XML im PDF/A-3 eingebettet"                                 |
| 06 Coda      | „Und alles gehört Ihnen."                                | „WORM-Objektspeicher mit Object-Lock – selbst bei App-Ausfall wiederherstellbar" |

The 00 and 99 title cards carry the melody open and the converged thesis (melody + bassline).

## Out of scope (curation beats completeness)

Calendar, user admin, bookkeeper view, push notifications, the attachment recycle-bin
(`Papierkorb`), live invoice issuance, the invoice-frozen refusal, backup drills. All real;
none earned its seconds against the spine. (Papierkorb, live issuance, and the frozen-invoice
refusal were in the early plan and deliberately cut.)

## Production / harness notes

- **Single 1920×1080 master** — `scripts/demo/encode.mjs --master` normalizes every clip to
  the canvas (desktop padded with the app's dark navy; phone clips composited onto the
  blurred backdrop), re-asserts `setsar=1` (else the concat filter rejects a near-1:1 SAR
  mismatch), and concatenates in filename order. `npm run demo` records serially
  (`--workers=1`, since several beats mutate the shared e2e DB) then masters.
- **Ordering** — segment specs carry zero-padded numeric prefixes (`demo-00` … `demo-99`); the
  master sorts clip paths lexically, so filename order = narrative order. Mobile beats use a
  `.mobile.spec.ts` infix + a `testMatch` split so they record under `demo-mobile` only.
- **Live cross-user shot (beat 03)** — the owner's page is recorded; a second
  `browser.newContext()` (office) creates a project via the API, and the row appears in the
  dock via the `audit_changed` SSE push. Mirrors `e2e/activity-dock.spec.ts` AC-317; the dock
  shows the full RBAC-scoped feed, so any mutation surfaces for the owner observer.
- **Integrity refusal (beat 02)** — owner deletes a seeded customer with a live project; the
  409 surfaces as the inline banner (`CustomerManagement.tsx`). Only `owner` holds
  `customer:delete`, so the delete button renders for that role (office cannot delete).
- **Title cards (00, 99)** — styled HTML rendered via `page.setContent` over a darkened
  backdrop, recorded like a segment (desktop). No `drawtext`, no app screen.
- **Green backup badge (coda)** — a demo-gated upsert in `e2e/auth.setup.ts` (only when
  `PLAYWRIGHT_RUN_DEMO` is set) writes a healthy `meta_backup_status`, so the badge reads
  green; normal e2e keeps the real default. Clicking the badge fires a status toast.
- **Continuity is narrative, not DB threading** — segments record against the shared seed,
  stitched by consistent naming + captions; no live project is threaded across specs. The
  existing "Familie Müller" recurs where natural — no dedicated hero project was needed.
- **Primitives** — captions / cursor / eased glide + the smaller technical-note line in
  `e2e/demo-helpers.ts`; per-role sessions in `e2e/storage-states.ts`.

## README integration (manual — README is read-only for AI)

The hero loop `assets/demo-hero.webp` is built. The README owner replaces the mosaic hero
(`assets/projekt-manager.png`) and the standalone "Mobile PWA demo video" link with the
clickable loop → Vimeo:

```html
<a href="https://vimeo.com/YOUR_NEW_ID">
  <img src="assets/demo-hero.webp" alt="Projekt-Manager — Demo" width="80%" />
</a>
```

One video, one entry point; the master includes mobile.

## Verification status

Shipped: 8 segments record clean (**13 passed**), the master concatenates to 1920×1080 /
~1:25, and every beat is frame-verified — green backup badge, the live cross-session dock
row, the phone-on-backdrop composite, the ZUGFeRD invoice, and the German dual-register
captions. Remaining manual steps: upload `demo-clips/demo-master.mp4` to Vimeo and apply the
README snippet above.
