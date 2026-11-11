# Verification

Verified locally with Node.js 22.23.2 and Chromium on 2026-11-11.

- Clean `npm ci` in an isolated directory: successful; npm audit reported zero vulnerabilities.
- Production build: successful.
- Automated suite: 126 tests passed across seven files.
- Production browser: the static build loaded with its Content Security Policy enabled, imported a CORS-enabled URL, and reported no console errors.
- Browser file imports: all three user-provided private ATIF examples were read from their original locations. No private fixture, path, transcript excerpt, or screenshot is included in this repository.
- Structured metrics: a synthetic control verified explicit reward `0`, reported TTFT, token/cache/reasoning values, and recorded costs through the production UI. Missing values remained unavailable.
- Timeline: search highlighted matching message and output content; event selection, up/down keys, source inspection, expansion toggle, and per-step timing were exercised.
- Sidebar: dragging created a group, focused and selected its default name, accepted another trajectory, and preserved membership after refresh. Synthetic test runs were removed through the app. Run renaming and duplicate-content import were exercised.
- Split pane: dragging changed its width; dragging to the right edge hid it; selecting another event while hidden and restoring the reader showed the current event.
- Persistence: refresh restored saved runs. The sidebar loads summaries separately from full session content.
- Compact layout: at the same 1280×800 browser viewport, the header reduced from 105px to 72px, collapsed rows from 73px to 54px, and fully visible events increased from four to eight. A search match remained visible inside its single-line excerpt.
- Responsive layout: desktop and 390px mobile layouts were inspected. Mobile uses an event list/reader navigation flow.

Tests include malformed and truncated input, unknown formats, duplicate tool-call IDs, incomplete usage records, missing result IDs, Unicode highlighting, large output clipping, escaped HTML and blocked remote images, URL failures and size caps, storage migration, and group membership integrity.

Timing intervals can contain idle time. Tests do not establish agent correctness, a reward score where none was recorded, browser storage durability, or support for every vendor-specific trajectory schema.
