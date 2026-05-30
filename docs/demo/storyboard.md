# Demo Video — Storyboard & Shot List

> Status: **draft, converging.** Drives the recording harness (`e2e/demo-*.spec.ts`,
> `scripts/demo/encode.mjs`). Red-pen freely; the script is settled on paper before code.

## Purpose

One seamless ~2-minute film for the README hero, linked to Vimeo. It must present
the app broadly without dragging, and make the invisible engineering (data integrity,
RBAC, live audit) _visible_ rather than narrated.

## Audience & thesis

The film carries two theses for two audiences, woven so neither talks down to the other:

- **Melody — for the real user (a Handwerker, clueless about the tech):**
  _"This was built around **you**. It adapts to how you already work — not the other
  way around."_ Leads everywhere.
- **Bassline — for the engineer / portfolio viewer:**
  _"Built to be distrusted — the app will fail and the user will try to break it — which
  is exactly why the data survives."_ Rides underneath as proof; concentrated in three
  technical grace notes and the coda.

They converge in the final line: _made for you_ **and** _guards your data_. The two
theses mirror the README's two pillars — "Who is this for" and "Data integrity, Security."

## Spine — "one job, three hands, one living board"

Follow a single project through the company. Personas are the hands it passes through;
the activity dock is the omniscient through-line; each invisible fact surfaces the moment
it becomes relevant.

```
  inquiry email
        │
        ▼
 ┌─ OFFICE · desktop ───────────────────────────┐
 │ LLM-extract → project created                 │  data intake + the user-first touch
 │ try to destroy data → app REFUSES · recycle-bin│  ★ data integrity, shown by refusal
 └──────────────┬─────────────────────────────────┘
                │  every step logs into…
                ▼
        OWNER · desktop — kanban + activity dock      ★ killer feature: the company, alive
                │  live, cross-user, no refresh
                ▼
 ┌─ FIELD WORKER · mobile ────────────────────────┐
 │ "Meine Projekte" — only their jobs              │  RBAC, shown by absence
 │ open job · upload site photos                   │  data from the field (no camera needed)
 └──────────────┬─────────────────────────────────┘
                ▼
   completion → invoice issued → PDF                   the pipeline pays off
                │
                ▼
   CODA — backup badge · one-click export · thesis     ★ built-to-be-distrusted payoff
```

## Format & constraints

- **Length:** ~2:00–2:15. Vary pace — montage transitions, slow down on money shots.
- **Aspect:** 16:9. Silent, with burned-in captions (no voiceover).
- **Mobile:** emulated viewport composited onto a **phone mockup over the 16:9 canvas** at
  encode time — uniform resolution + looks deliberate. No phone is ever physically recorded.
  "Taking a photo" is replaced by a file upload of a pre-staged image.
- **Output:** one seamless master (segments concatenated). A ~6–10s muted **webp loop** is
  cut from the master as the clickable README hero → Vimeo.

## Shot list

Target times are approximate. ★ = money shot.

| #   | ~time       | Beat        | User · viewport                          | On-screen actions                                                                                                           | Spec                |
| --- | ----------- | ----------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 0   | 0:00–0:12   | Cold open   | title card                               | chaos framing → "I have work to do." → "so it was built around you"                                                         | generated card      |
| 1   | 0:12–0:34   | Intake      | office · desktop                         | open email-extract modal, paste inquiry, extract, review prefilled form, save → customer + project                          | `demo-01-intake`    |
| 2   | 0:34–0:58 ★ | Integrity   | office · desktop                         | try to delete a customer with invoices → refused; try to delete an issued invoice → frozen; open `Papierkorb` (recycle-bin) | `demo-02-integrity` |
| 3   | 0:58–1:14 ★ | Living dock | owner · desktop (+ worker actor context) | dock expanded on kanban; a background action lands live in the dock, no refresh                                             | `demo-03-dock`      |
| 4   | 1:14–1:36   | Field       | worker · mobile                          | land on "Meine Projekte" (only their jobs), open a job, upload site photos                                                  | `demo-04-field`     |
| 5   | 1:36–1:52   | Invoice     | office · desktop                         | project at `rechnung_faellig` → issue invoice → download PDF                                                                | `demo-05-invoice`   |
| 6   | 1:52–2:14 ★ | Coda        | owner · desktop → title card             | green backup badge, one-click full export (takeout zip), thesis title card, close on the living board                       | `demo-06-coda`      |

## Caption registers

Human caption = the primary bottom banner, present on every beat. Technical note = a
restrained second line, **only on the three grace-note beats** (2, 3, 6). The clueless
user's eye glides over the technical line; the engineer catches it.

| Beat        | Human (melody)                                                                          | Technical (bassline)                                                                                |
| ----------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1 Intake    | "Paste the email — it fills in the rest. Typing the same address twice isn't your job." | —                                                                                                   |
| 2 Integrity | "Try to delete something important — it won't. Your data is protected, even from you."  | "issued invoices immutable · the app holds no delete key"                                           |
| 3 Dock      | "Leave it open. Watch the whole company move, live."                                    | "live audit feed · every mutation · in real time"                                                   |
| 4 Field     | "On site, you see only your jobs. That's all you need right now."                       | "role-scoped, server-enforced"                                                                      |
| 5 Invoice   | "Done. The invoice is one click away."                                                  | —                                                                                                   |
| 6 Coda      | "Made for you. It adapts to how you work — not the other way around."                   | "encrypted · VPN-only · backed up to write-once storage · recoverable even if the app itself fails" |

## Out of scope (curation beats completeness)

Calendar, user admin, bookkeeper view, push notifications, ZUGFeRD specifics, backup
drills. All real; none earns its seconds against the spine. Adding one means cutting one.

## Production / harness notes

- **Single master from mixed viewports** — the current encode concatenates only
  same-resolution clips. Add a master path that composites mobile clips onto a phone-frame
  over the 16:9 canvas (`filter_complex`), so every segment is uniform and concat is clean.
- **Live cross-user shot (beat 3)** — record the owner's page; drive the actor in a second
  `browser.newContext()` (worker/office). The dock reacts to a genuine cross-session event;
  nothing faked.
- **Narrative continuity is a conceit, not DB threading.** Segments are separate recordings
  against seeded data, stitched by consistent naming + captions — they don't thread one live
  DB row across specs. Likely needs a curated **hero customer/project** in the seed
  (`src/server/seed/business.ts`) so the same name recurs across beats.
- **Title cards (beats 0, 6)** — a blank styled page + caption overlay, or `drawtext` at
  encode. No app screen.
- **Reuse the existing primitives** — captions/cursor/glide in `e2e/demo-helpers.ts`,
  per-role sessions in `e2e/storage-states.ts` + `e2e/auth.setup.ts`, demo projects in
  `playwright.config.ts`. Drop the broken mobile-kanban teaser entirely.

## README integration

- Replace the mosaic hero (`assets/projekt-manager.png`) with the **clickable webp loop**
  (a play affordance, links to Vimeo). The visual _is_ the entry point — no bare URL beneath.
- Retire the standalone "Mobile PWA demo video" link; the master includes mobile. One video,
  one entry point.

## To verify before building (load-bearing, agent-reported)

These feature facts drive the script and are not yet independently confirmed:

1. Activity dock is genuinely live + cross-user (the SSE propagation claim).
2. The integrity refusals render an on-screen message that lingers long enough to film, and
   the recycle-bin (`Papierkorb`) tab is real.
3. Worker on mobile lands on "Meine Projekte" with no dock / no transition arrows.
4. `browser.newContext()` multi-session recording behaves as expected (the one spike).
5. `OPENROUTER_API_KEY` is wired so the extract runs live.
