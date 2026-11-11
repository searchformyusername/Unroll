# Unroll

- This is a front-end-only project. Keep private trajectory data in the browser; never introduce an upload service, analytics, remote fonts, or automatic external image loading.
- Never copy, stage, commit, or push confidential trajectories. Read private test samples in place. Use only synthetic fixtures in source and tests. Do not put private paths or transcript excerpts in documentation.
- Preserve source qualifiers: timestamp intervals are not tool durations; reward, costs, tokens, latency, and success must never be inferred from narrative text.
- Run `npm test` and `npm run build` for meaningful behavior changes. Verify drag, file input, keyboard, and storage behavior in a browser.
- When interacting with Cloudflare, use the cf CLI unless the project has a Wrangler configuration file.
