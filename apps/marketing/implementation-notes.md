# Homepage fidelity — Issue #39

## Reference baseline

Reference: <https://cursor.com/>, captured on 2026-09-11 after the Chinese light homepage finished rendering. The archived `design-reference/cursor.json` records the capture time, language, viewport, section order, and computed geometry at 1440, 768, 390, and 320 CSS px. `cursor-1440.png` and `cursor-390.png` are the full-page reference captures, for review only; the build does not publish this directory.

The fully rendered baseline includes changelog and editorial highlights. Earlier observations taken before those sections appeared are not the source of truth for this implementation.

| Desktop landmark | Reference | Implementation target |
| --- | --- | --- |
| Viewport | 1440 × 900 CSS px | Same |
| Header height | 52px | 52px |
| Content width | 1300px | 1300px |
| H1 top / font / line-height | 164px / 26px / 32.5px | Same; Storyflow text has a different length |
| Hero stage top / height | 318.17px / 720px | Same |
| Feature card padding | 17.5px | 17.5px |
| Feature copy / media | About 1:2 | About 1:2 |
| Feature media height | 680px | 680px |

These are calibration observations, not a new design token API. At narrow widths, readable demo content reflows rather than scaling down an entire desktop screenshot.

## Section mapping and outstanding materials

**This is an implementation of the available product sections, not a completed 1:1 homepage. Issue #39 must remain open.** No source for customer endorsements, testimonials, team photography, or editorial articles was supplied during this implementation. An explicit request for those sources was made; absence of a reply is not approval to invent, replace, or drop their requirements.

| Reference section / purpose | Storyflow mapping | State / difference |
| --- | --- | --- |
| Header / navigation and acquisition | Existing Storyflow logo, product anchors, tutorial, download | Implemented. No fictional pricing, sign-in or sales destinations. |
| Hero / show the Agent working and the result | Readable writing goal, chapter excerpt, review; overlapping writing and review windows | Implemented as a deterministic, labelled web demonstration, not a running Agent or desktop screenshot. |
| Customer Logo garden / external trust | Requires real customer marks and attributable sources | **Blocked on material.** No file categories, empty cards, fake marks or public placeholder text. No claim that this slot is complete. |
| Feature 1 / task becomes work | Goal, chapter, and review states | Implemented. Storyflow content replaces coding tasks. |
| Feature 2 / delegated work and control | Review a concrete proposed change, accept, reject, reset | Implemented Storyflow control story; does not claim Cursor cloud/parallel capabilities. |
| Feature 3 / connected context | Follow a continuation task’s file references to creative requirements, character and chapter content | Implemented. Example files belong to an existing sample Project, not a new-project template. |
| Feature 4 / reusable work | Readable Skill method and task-example states | Implemented as a local switchable method demonstration, with a link to the real supporting capture. Storyflow Skills replaces the AI-teammate/Slack story; no Slack capability is claimed. |
| Testimonials / external evidence | Requires real attributable customer quotations | **Blocked on material.** FAQ is retained as footer help and is not counted as testimonial delivery. |
| Three capability cards / broaden the demonstrated capabilities | Skills, source results, local version history, each with corresponding real media | Implemented for existing Storyflow capabilities, without inventing enterprise or model guarantees. |
| Changelog / evidence of ongoing development | Four published releases and links | Implemented from checked release notes and GitHub release tags. |
| Team / who builds the product | Requires a factual team introduction and suitable original image | **Blocked on material.** Version history is not used as a substitute. |
| Editorial highlights / deepen the product story | Requires published Storyflow articles | **Blocked on material.** Tutorial cards are not a substitute. |
| Closing CTA / start using the product | Download on desktop, tutorial on mobile | Implemented. No account or sales flow added. |
| Footer / useful destinations | Existing product/tutorial links and factual FAQ | Implemented using available destinations; no fake legal or company pages. |

Missing sections are not padded with blank space to make a full-page screenshot seem aligned. Consequently absolute positions of later sections and total page height differ. This is an explicit material gap, not passed fidelity acceptance. Completing those requirements needs the listed material or a maintenance decision changing the spec.

## Product material provenance

- The first-chapter excerpt in the web demonstration is transcribed from the existing Storyflow editor capture. The request, creative brief, character notes and proposed edit are labelled illustrative content; they are not claimed to be the recorded output of a live model call.
- The simulated goal/draft/review controls are local to the marketing page. Accept/reject/reset changes only the displayed example. The window caption says “示例项目” and the footer explains that no real files change.
- The drawing follows Storyflow's conversation/document arrangement; it is a responsive web demonstration rather than a pixel-identical replica of the desktop UI. A link opens the real supporting capture.
- Project-file switching and clickable task references illustrate folder ownership and how the brief, character and prior chapter inform continuation. These are labelled sample references, not a recorded model citation trace. The demonstration does not install Skills or create a predefined Project folder structure. This follows accepted ADR 0007.
- The Skill panel uses the existing `storyflow-skills-detail.webp`; the query card uses `storyflow-data-results.webp`; version history uses `storyflow-version-history.png`. Each image can be opened at full size. CSS cropping changes framing only; original assets remain unchanged.
- The original promotional video is retained as an existing asset but no longer acts as the first-screen value demonstration. There is no autoplay dependency; reduced-motion users receive the same readable states.
- Release summaries derive from the existing 0.21.0–0.21.3 release notes; public tags and dates were verified with GitHub on 2026-09-11. They are a curated publication snapshot, not a second live release-discovery service.

## Implementation and rollout boundaries

Reuse the existing React/Bun marketing build, tutorial, same-site navigation, installer metadata and root-relative assets. There is no new dependency, backend, model call or persisted state. The original incorrect proof substitutes and tutorial-as-changelog cards are removed from the main narrative; FAQ content stays available in the footer.

The worktree already included the in-site tutorial and the previous landing redesign. They share the same entry point and stylesheet; the marketing commit includes that necessary local baseline so the checked-out commit can build independently. Unrelated Electron, locale and root README changes remain outside the commit.

Only the marketing output changes. No data migration is required. Deployment is not performed by this task; normal deployment follows the existing marketing workflow after an authorized push. Review the material blockers before treating any deployment as closure of #39.

## Verification record — 2026-09-11

- Marketing typecheck and production build passed. The Bun marketing suite passed 8 tests / 77 assertions. The repository `bun run test` completed successfully: 5,778 passed, 11 skipped, 0 failed across the main run and isolated runs.
- `qa.mjs` passed against the production preview at 1440, 768, 390 and 320 px: no horizontal overflow, all captures loaded, task/reference/Skill/review state changes, the three installer destinations, Enter/Tab/Escape and focus recovery, narrow-screen installation links, tutorial deep-link refresh/history, reduced motion and image failure fallback.
- `design-reference/storyflow-1440.png`, `storyflow-390.png` and `qa-results.json` preserve the final browser evidence. The numerical record describes geometry and load state, not a fidelity score.
- Additional keyboard inspection exercised hero goal/draft/review, accept/reject and the footer FAQ disclosure. Desktop capability-card framing and the narrow-screen project panel were visually inspected.
- Standards and Spec reviewers rechecked and cleared the mobile download, context-reference and QA-coverage findings. External material gaps remain as listed above.
