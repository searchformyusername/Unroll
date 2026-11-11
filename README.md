# Unroll

A browser-only workspace for inspecting agent trajectories. Open local files or fetch a direct URL, keep several runs in the sidebar, and read individual events alongside a compact timeline.

## Run locally

Use Node.js 22.12 or newer.

```sh
npm ci
npm run dev
```

Vite prints the local URL. For a production build:

```sh
npm run build
npm run preview
```

The `dist/` output is a static site. No application backend, database service, account, or API key is required.

## Reading trajectories

- Import multiple JSON, JSONL, NDJSON, or recognized `.traj` files; identical imports refresh the existing parsed copy using a browser-computed content hash, preserving its name and group; the limit is 25 MB per file. JSON nested beyond 200 object/array levels is rejected with an actionable error.
- Supported structures: ATIF steps, OpenAI/Anthropic-style chat messages, Claude Code JSONL, and Codex rollout JSONL. Format detection uses the contents, not the filename. Arbitrary `.traj` schemas are not automatically supported.
- Select an event to read its content, tool arguments, and all matching results in the right pane. Content, Metrics, Source, and Run Metrics stay selected while navigating. Choosing a step interval highlights the step on the left and keeps the Run Metrics view and its scroll position in place.
- **Source** exposes the original event, its complete ATIF step, and the original records of paired tool results. Run Metrics includes the original run metadata. Empty ATIF steps retain their timestamps, and unsupported content parts raise a diagnostic with the source preserved. Previously saved runs gain this additional metadata when the original file is re-imported.
- Search is literal and case insensitive. Matches are highlighted in messages, reasoning, code, arguments, and results, including content beyond the initial preview.
- Use **↑ / ↓** after selecting an event to move through the filtered list. Navigation preserves the height of a lower row selected with the mouse; upper selections can advance naturally toward the middle, keeping surrounding events visible. **⌘/Ctrl K** focuses search; **⌘/Ctrl O** opens file import.
- The expansion toggle opens or closes inline content across the list. Long lists load automatically in batches as you approach the last 20 rendered events; outputs remain bounded.
- The initial split gives the timeline 60% of the workspace. Drag the divider to resize the reader. Drag it to the right edge to hide it; the edge arrow restores it for the currently selected event. The separator also supports left/right arrow keys, Home to reset, and End to hide.
- Drag one sidebar trajectory onto another to create a group. The default name is selected for immediate renaming. Drop more files into a group, or drag a member onto the “Trajectories” heading to ungroup it. Each file’s menu also provides grouping controls for keyboard use and a Rename action to distinguish files with the same original name.
- Five swatches at the bottom of the sidebar select Lavender, Sand, Paper, Sage, or Sky backgrounds. The Sun/Moon button switches Day/Night in one click. Choices are saved locally; event-type icon colors stay consistent.
- Collapse the sidebar and reveal it from the left rail. Pin it to keep it open. Mobile uses a drawer and a separate event reading screen.

## Metrics and evidence

Timestamp intervals show the time until the next recorded source step, response, or request. They may include idle time and parallel work. They are **not** individual tool execution durations. Recorded durations and time to first token appear only when the source supplies an explicitly scoped measurement.

Input token totals count prompts across requests, including cached tokens; they are not a conversation context size. A dash means the source did not record the metric, or request-level data is incomplete. Source-reported cost and reasoning-token totals are preserved. Reward/score values are shown only for explicitly named structured fields, with their source path; narrative claims are never treated as evaluation results. Explicit errors, repeated calls, and unusual timestamp gaps can be inspected through observations that link back to source events. Unroll does not judge correctness or invent a success score. Embedded sub-agent trajectories are retained in ATIF source metadata but are not expanded into separate timelines; referenced continuation files are not fetched automatically. Image and file parts are placeholders rather than media previews.

## Data handling

File contents are parsed in a Web Worker. Saved runs live in IndexedDB on this browser and origin; group names, membership, and appearance preferences live in localStorage. The sidebar reads only a lightweight index and loads the selected session. Removing a trajectory deletes its saved browser copy. Browser storage may be cleared by the browser and is not an encrypted vault or a backup.

A URL import sends a GET directly from the browser to the URL entered by the user, without cookies or referrers. The source must allow CORS. There is no proxy. Remote images embedded in transcript Markdown are not loaded; HTML and script content cannot execute. The production build includes a Content Security Policy. There are no analytics or remote font dependencies.

**Never place confidential trajectories in this repository.** Read private examples from their original locations. All committed test fixtures must be synthetic. Ignored folders (`private/`, `trajectories/`, `samples/`) are a second precaution, not permission to copy private data into the checkout.

## Checks

```sh
npm test
npm run build
```

Tests cover parsing and tool pairing, usage accounting, source-scoped timing, search and Unicode highlighting, safe rendering, import failure and size limits, storage migration, and group membership. Browser verification is additionally needed for file pickers, persistence, drag gestures, resizing, and keyboard interactions.
