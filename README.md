# Unroll

Inspect agent trajectories in your browser.

## Run

Requires Node.js 22.12+.

```sh
npm ci
npm run dev
```

## Features

- Open local files or direct URLs, up to 25 MB per file. URLs must allow CORS.
- Read ATIF trajectories, OpenAI/Anthropic chats, Claude Code logs, and Codex rollouts.
- Search with highlights, navigate with arrow keys, and group runs in the sidebar.
- Inspect events, tool results, source records, and run metrics in a resizable pane.
- Chat about a run using your OpenAI, Anthropic, or Gemini API key.
- Download original files or normalized exports.

Token, cache, cost, timing, and reward metrics appear when recorded. Timestamp gaps are not tool durations.

## Data

Runs, chats, and preferences are saved in your browser. Chat sends the selected context directly to your provider; API charges apply.

Saved API keys are unencrypted in localStorage. Use the trash button beside a key to clear it.

Never commit private trajectories or API keys.

## Build and test

```sh
npm test
npm run build
```

Deploy `dist/` as a static site.
