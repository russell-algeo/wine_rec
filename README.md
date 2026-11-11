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

### Isolated local quality tests (no hosted services)

From `main/`, install locked dependencies with `npm ci`, then run:

```sh
npm run dev:isolated
# In a second terminal, also from main/:
npm run dev:isolated:web
```

Open `http://127.0.0.1:5173`. This explicitly selected mode uses bundled Tesseract.js,
the normal parser and ranking code, and an ephemeral in-memory analysis store. It does
not load `.env`, call Vivino, upload to Blob, or use Redis/QStash. Results clear when the
API restarts. The web UI labels this mode; estimated recommendations are not proof of
Vivino matching quality. Images in `shared/test/fixtures/` are suitable test inputs.
PDFs are not supported by Tesseract; use an image instead.

URL tests must use saved HTML served on loopback, for example `python3 -m http.server
8080 --bind 127.0.0.1 --directory /path/to/reviewed-menu-fixtures`, then enter
`http://127.0.0.1:8080/menu.html`. External URLs, external redirects and browser-render
fallback are disabled. This mode does not exercise production queueing or storage.

### Hosted-service development

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
The default `.env.example` selects Tesseract.js and Vivino; the normal API uses hosted
Redis, QStash and Blob. Use the isolated commands above when those services are not
configured or should not be contacted. The historical SQLite worker is not the backend
for the current normal API.
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
- `rule-based` remains a local fallback when browser scraping is disabled, has no match, or is too low-confidence. A detected provider access denial or challenge is terminal: do not retry the provider or fall back around that boundary.

### Access-stop limits and offline validation

- Detected HTTP 401/403, AWS challenge/captcha headers, challenge scripts and interstitial titles stop that provider instance synchronously. Detection uses known markers, not an exhaustive list of every possible challenge.
- The worker persists a terminal job state before queue cleanup. Atomic Redis guards prevent stale updates, claims, completions and requeues from reviving a terminal job. Individual worker/candidate display records are best-effort and may lag that authoritative state.
- Three bounded attempts retry only the idempotent terminal Redis write. If all fail, this delivery is acknowledged and logs **Job stop unconfirmed**. The job may remain processing and other invocations may reclaim leases: operator recovery is required, and automatic recovery must not restart provider work. A reliable durable store remains a release requirement for the all-worker-stop guarantee.
- Already-issued network requests cannot be retracted; other processes stop after observing the durable job state. No live provider verification is implied by offline tests.
- The Lua race tests use actual source scripts in in-memory fakeredis/Lua, with no Redis server or network. They are optional unless the isolated Python test runtime is present. Install test-only `fakeredis==2.32.1 redis==8.1.0 lupa==2.8 sortedcontainers==2.4.0` into a directory, then set `WINE_REC_FAKEREDIS_PATH` to that directory for `cd main && npm test`. Confirm the terminal Lua test is not skipped.

## Archived Integration Notes

The deprecated integrations below were removed from the live runtime on March 10, 2026 to keep the provider stack focused on the Playwright path. These notes are here so the options are easy to revisit later without keeping dormant code around.

- `apify-vivino`: This was a managed Vivino scrape path via an Apify actor or custom endpoint. Revisit it if the browser approach becomes too fragile, if rate-limiting needs to move off-box, or if you want a paid sidecar/source that returns normalized Vivino payloads without running Playwright locally.
- `wine-searcher`: This was a custom endpoint hook for Wine-Searcher style lookups. Revisit it if you get access to a stable wrapper that can add bottle metadata, merchant/price context, or broader catalog coverage than Vivino.
- `spoonacular-style`: This was a description-based style fallback keyed off varietal or wine name. Revisit it only if you need a coarse textual style signal when exact bottle matching is impossible; it is too low-fidelity to be a primary recommendation source.

## Git workflow

Authorized direct, non-forced pushes to `master` do not require a PR or approving GitHub review. The default-branch ruleset continues to block force pushes and branch deletion. Review changes and run the relevant checks before publishing; PRs remain optional. This workflow does not grant deployment approval or change the separate release safeguards in [DEPLOYMENT.md](DEPLOYMENT.md#deployment-safety).

## Notes

- See [DEPLOYMENT.md](DEPLOYMENT.md) for the Vercel deployment topology, environment contract, local-linking procedure, and deployment validation checklist.
- The `vivino-direct` provider uses an embedded Playwright Chromium browser to scrape Vivino search results. As a future improvement, this could be extracted into a dedicated sidecar process (a small HTTP service wrapping Playwright) for independent scaling and restarts without affecting the main API.
- Full iOS builds require Xcode, which is not available in this workspace at the moment.
- `task_plan.md`, `findings.md`, and `progress.md` are included to follow the planning workflow during implementation.

### Shared-Upstash Preview namespacing

The optional `WINE_REC_NAMESPACE=preview:<lowercase-label>` separates Preview
job keys from existing Production `job:*` keys. `WINE_REC_PREVIEW_ROLE` must be
`app` or `worker`; both deployments must use the same fixed namespace. A Vercel
Preview fails closed without this configuration. Production leaves it unset,
retaining legacy keys and queued payloads without migration or fallback reads.

Every Preview Redis key (including Lua-derived keys), queue payload and
flow-control key is scoped. Preview analysis IDs have a visible `pv_` prefix.
Mismatched coordinator, worker and failure-callback namespaces are rejected
before accessing job state. Preview routing requires immutable Vercel URL syntax:
self callbacks use `VERCEL_URL`; the app must explicitly target the paired worker
with `CHUNK_WORKER_BASE_URL`, and the worker targets its own `VERCEL_URL`.
Syntax alone cannot prove the target is a Preview. Verify the actual deployment
project, environment and reviewed SHA in Vercel before configuring or testing it.

This shares the existing full-access Redis credential, memory, throughput,
command/bandwidth allowance and QStash account. A namespace is **not** an ACL or
security boundary. Never claim zero Production availability impact. Run only a
bounded non-private fixture batch, preferably one analysis at a time, after
checking quota headroom. No SCAN/FLUSH/global queue or Blob cleanup is permitted;
record exact fixture job/message/blob identities and wait for quiescence. Existing
24-hour Redis TTLs bound job-state retention, not Blob retention. Keep namespace,
paired URLs, code and matching credentials stable until queued work drains;
changing the namespace or credential is not a safe in-flight rollback.

`main/scripts/test-redis-namespace.py` proves the actual five Lua transitions
and exact cleanup preserve synthetic Production values/TTLs with identical IDs
on a disposable loopback Valkey engine. It requires `VALKEY_SERVER_BIN` and the
pinned Python Redis dependency listed by `test-redis-terminal.py`. It never
connects to a hosted database or uses real credentials. Ordinary Vitest tests
also check the actual job-store key builders, queue scope and startup gates.
