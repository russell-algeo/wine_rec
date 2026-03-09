# Wine Rec

Wine Rec is an upload-first wine recommendation MVP with:

- a local TypeScript API and worker,
- a local React web client for debugging and desktop use,
- an iPhone-first SwiftUI client scaffold.

The system accepts screenshots, photos, and PDFs, extracts wine candidates, enriches them through pluggable providers, normalizes taste vectors, and ranks wines against user preferences.

## Workspace

```text
apps/
  api/   Fastify API, worker, SQLite persistence, provider adapters
  web/   Vite + React local client
  ios/   SwiftUI source scaffold for the iPhone app
packages/
  contracts/ Shared API/domain schemas
  core/      Matching, inference, and recommendation logic
```

## Quick Start

1. Copy `.env.example` to `.env` and add API keys if you want real OCR and enrichment.
2. Install dependencies with `npm install`.
3. Run `npm run dev`.
4. Open the web client at `http://localhost:5173`.

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
4. Open [apps/ios/project.yml](/Users/russellalgeo/Desktop/Side%20Job/wine_rec/apps/ios/project.yml).
5. Install `xcodegen` if needed: `brew install xcodegen`
6. Generate the project: `cd apps/ios && xcodegen generate`
7. Open `WineRec.xcodeproj` in Xcode and run the `WineRec` scheme.

If you do not want to install `xcodegen`, you can also create a new iOS app in Xcode named `WineRec` and then add the files under [apps/ios/WineRec](/Users/russellalgeo/Desktop/Side%20Job/wine_rec/apps/ios/WineRec).

## Notes

- The unofficial Vivino-backed provider is behind a feature flag.
- Full iOS builds require Xcode, which is not available in this workspace at the moment.
- `task_plan.md`, `findings.md`, and `progress.md` are included to follow the planning workflow during implementation.
