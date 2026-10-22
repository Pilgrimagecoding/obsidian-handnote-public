# Contributing

Thanks for helping. HandNote is a handwriting plugin, so most bugs depend on the device: please
say which device, Obsidian version and HandNote version you use.

## Reporting a bug

Use the **Bug report** issue form. Helpful, and free of personal content:

- HandNote ⋯ menu → **Copy input diagnostics** / **Copy performance report** (numbers only).
- Settings → HandNote → Local recognition → **Run self-test** → Copy (device capabilities, timings).
- A small `.handnote` file made just to reproduce the problem.

Never attach real notes, screenshots of personal pages, or API keys.

## Development

```bash
npm install
npm run typecheck
npm test                 # unit tests (Node)
npm run test:browser     # Chromium tests (needs playwright-core and a Chromium build)
npm run build && npm run package && npm run check:release
```

- Official lint rules: `npm i --no-save eslint@9 eslint-plugin-obsidianmd typescript-eslint && npx eslint .`
  (CI runs this on every push: `.github/workflows/audit.yml`).
- Local recognition tests need the model files: `node scripts/fetch-local-assets.mjs` (downloads to
  `local-assets/`, which is ignored by Git).
- Releases (maintainer): push a tag equal to `manifest.json` `version` (x.y.z, no "v"); CI
  (`.github/workflows/release.yml`) builds, verifies and publishes `main.js`, `manifest.json`,
  `styles.css` and `SHA256SUMS.txt`.

## Ground rules

- Keep old `.handnote` files readable; a format change needs a version bump and a read-only path for
  older plugin versions.
- No telemetry, no network request without a user action and a README / `PRIVACY.md` entry.
- New third-party code, data, fonts or models: licence first, then an entry in
  `THIRD_PARTY_NOTICES.md`.
- No code, models or assets from MyScript, Goodnotes, Xmind or other proprietary products.
