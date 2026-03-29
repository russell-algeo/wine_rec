# Wine Rec

Wine Rec is an upload-first wine recommendation MVP with:

- a `main/` project for the API, web client, tests, and deployment bundle,
- a `worker/` project for chunk-worker deployment,
- an `ios/` project for the iPhone app,
- a `shared/` directory for local-only backend state, fixtures, and helper scripts.

The system accepts screenshots, photos, and PDFs, extracts wine candidates, enriches them through pluggable providers, normalizes taste vectors, and ranks wines against user preferences.

## Workspace

```text
main/    Main web + API project and deploy bundle
worker/  Worker project and deploy bundle
ios/     SwiftUI source scaffold for the iPhone app
shared/  Local-only data, uploads, fixtures, and helper scripts
```

## Quick Start

1. Copy `.env.example` to `.env` and add API keys only if you want real OCR.
2. Install dependencies in the deploy roots:
   `cd main && npm install`
   `cd ../worker && npm install`
3. Install the Playwright browser bundle once from `main/`:
   `cd main && npx playwright install chromium`
4. Start the local services from their project roots:
   `cd main && npm run dev:api:watch`
   `cd main && npm run dev:web`
   `cd worker && npm run worker:watch`
5. Open the web client at `http://localhost:5173`.

The root `.env` file is shared by both `main/` and `worker/`.
The default `.env.example` uses mock OCR so the pipeline can run without external services.
If `tesseract` is installed locally, set `OCR_PROVIDER=tesseract` in `.env` to run real OCR on image uploads.

## Running Locally

- The API now defaults to `HOST=127.0.0.1`, which is safer for local development.
- If you want the iPhone app to talk to the API from a physical device on your LAN, set `HOST=0.0.0.0`.
- The Codex sandbox blocks local port binding, so the API should be run from your own terminal rather than inside the sandbox when you want a live server.

## iPhone App Setup

1. Install full `Xcode.app` from the Mac App Store or Apple Developer downloads.
2. Switch the active developer directory:
   `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`
3. Launch Xcode once and accept the license if prompted.
4. Open [ios/project.yml](/Users/russellalgeo/Desktop/Side%20Job/wine_rec/ios/project.yml).
5. Install `xcodegen` if needed: `brew install xcodegen`
6. Generate the project: `cd ios && xcodegen generate`
7. Open `WineRec.xcodeproj` in Xcode and run the `WineRec` scheme.

If you do not want to install `xcodegen`, you can also create a new iOS app in Xcode named `WineRec` and then add the files under [ios/WineRec](/Users/russellalgeo/Desktop/Side%20Job/wine_rec/ios/WineRec).

## Provider Strategy

- The active enrichment stack is `vivino-direct` followed by `rule-based`.
- `vivino-direct` uses an embedded Playwright browser session to scrape Vivino search results and then enrich the best match with Vivino taste data.
- `rule-based` stays in place as the always-available local fallback when browser scraping is disabled, blocked, or too low-confidence.

## Archived Integration Notes

The deprecated integrations below were removed from the live runtime on March 10, 2026 to keep the provider stack focused on the Playwright path. These notes are here so the options are easy to revisit later without keeping dormant code around.

- `apify-vivino`: This was a managed Vivino scrape path via an Apify actor or custom endpoint. Revisit it if the browser approach becomes too fragile, if rate-limiting needs to move off-box, or if you want a paid sidecar/source that returns normalized Vivino payloads without running Playwright locally.
- `wine-searcher`: This was a custom endpoint hook for Wine-Searcher style lookups. Revisit it if you get access to a stable wrapper that can add bottle metadata, merchant/price context, or broader catalog coverage than Vivino.
- `spoonacular-style`: This was a description-based style fallback keyed off varietal or wine name. Revisit it only if you need a coarse textual style signal when exact bottle matching is impossible; it is too low-fidelity to be a primary recommendation source.

## Notes

- The `vivino-direct` provider uses an embedded Playwright Chromium browser to scrape Vivino search results. As a future improvement, this could be extracted into a dedicated sidecar process (a small HTTP service wrapping Playwright) for independent scaling and restarts without affecting the main API.
- Full iOS builds require Xcode, which is not available in this workspace at the moment.
- `task_plan.md`, `findings.md`, and `progress.md` are included to follow the planning workflow during implementation.
