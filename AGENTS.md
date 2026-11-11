# Unroll

- This is a front-end-only project. Keep trajectory imports in the browser; never introduce an upload service, analytics, remote fonts, or automatic external image loading. The user explicitly authorized opt-in Chat Agent calls directly to Anthropic, OpenAI, and Gemini. Send context only after an explicit chat submission, explain the destination and scope, and the user explicitly authorized storing provider keys in localStorage on Save key. Label that storage is unencrypted, provide immediate clear controls, and never include configured keys in IndexedDB, exports, logs, or commits.
- Never copy, stage, commit, or push confidential trajectories. Read private test samples in place. Use only synthetic fixtures in source and tests. Do not put private paths or transcript excerpts in documentation.
- Preserve source qualifiers: timestamp intervals are not tool durations; reward, costs, tokens, latency, and success must never be inferred from narrative text.
- Run `npm test` and `npm run build` for meaningful behavior changes. Verify drag, file input, keyboard, and storage behavior in a browser.
- When interacting with Cloudflare, use the cf CLI unless the project has a Wrangler configuration file.
