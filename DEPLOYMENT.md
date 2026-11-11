# Vercel Deployment Runbook

This document describes the checked-in Wine Rec deployment contract. It is intentionally limited to durable architecture, configuration names, and verification steps. Current deployment state belongs to Vercel and the live repository, not this document.

## Architecture

Wine Rec has three source areas, but only two Vercel deployments:

| Source area | Role | Deployment target |
| --- | --- | --- |
| `main/` | Web client, public API, coordinator functions, and the primary deployment bundle | Vercel project `wine-rec` |
| `worker/` | Dedicated chunk-processing functions | Vercel project `wine-rec-chunk-worker` |
| `ios/` | SwiftUI client | No Vercel deployment; its default API target is `https://wine-rec.vercel.app` |

The `shared/` directory is local-only source material: fixtures, uploads, SQLite development state, and diagnostic scripts. It is not a Vercel deployment root.

### Runtime flow

1. A client submits an image, PDF, or URL to the `main/` API.
2. The main application creates/tracks the analysis state in Upstash Redis and publishes signed work to QStash.
3. The coordinator job targets `main/api/coordinator`, which is allowed up to 300 seconds.
4. Candidate jobs target the dedicated `worker/api/chunk-worker` endpoint. QStash flow control, retries, and time-budget requeuing bound this work.
5. Both Vercel projects verify QStash signatures before accepting job payloads. Worker failures return through signed `api/worker-failure` callbacks.
6. OCR, browser-backed Vivino enrichment, ranking, and recommendation results are persisted and exposed through the main application API.

`main/api/chunk-worker` exists and can process a worker payload, but the production topology is the dedicated worker project. Do not silently fall back to the main deployment by omitting `CHUNK_WORKER_BASE_URL`; doing so changes the intended isolation and capacity profile.

## Verified Vercel topology

All projects are owned by the `russell-algeos-projects` Vercel team.

| Vercel project | Source root | Runtime | Production alias |
| --- | --- | --- | --- |
| `wine-rec` | `main` | Node `24.x` | `https://wine-rec.vercel.app` |
| `wine-rec-chunk-worker` | `worker` | Node `24.x` | `https://wine-rec-chunk-worker.vercel.app` |

The main project uses `main/vercel.json`:

- `npm install`
- `npm run vercel-build`
- static output at `dist`
- `api/coordinator.ts` has `maxDuration: 300`
- other API routes have `maxDuration: 60`
- Tesseract runtime assets are explicitly included with the coordinator bundle

The worker project uses `worker/vercel.json`:

- `npm install`
- `npm run vercel-build`
- function output rooted at `.`
- worker and failure callback API routes have `maxDuration: 60`

## Environment contract

Never retrieve, print, commit, or copy environment values into this repository. Inspect variable names/scopes with the Vercel CLI, and make edits only with explicit approval.

### Main application: `wine-rec`

Required runtime categories:

- **Queue and state:** `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `QSTASH_URL`, `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`
- **Cross-deployment routing:** `CHUNK_WORKER_BASE_URL`, `CHUNK_WORKER_VERCEL_AUTOMATION_BYPASS_SECRET`
- **Upload persistence:** `BLOB_READ_WRITE_TOKEN`
- **OCR/browser:** `OCR_PROVIDER`, `OCR_SPACE_API_KEY`, `CHROMIUM_PACK_URL`
- **Provider behavior:** `WINE_PROFILE_PROVIDER_ORDER`, `ENABLE_VIVINO_DIRECT`, `VIVINO_DIRECT_DELAY_MS`, `VIVINO_DIRECT_MAX_RETRIES`, `VIVINO_DIRECT_BACKOFF_MS`, `VIVINO_DIRECT_FETCH_TASTES`
- **Serverless concurrency controls:** `ANALYSIS_CANDIDATE_CONCURRENCY`, `SERVERLESS_WORKER_MAX_PARALLEL`, `SERVERLESS_WORKER_INITIAL_JITTER_MAX_SECONDS`

Vercel supplies `VERCEL_URL` for the running deployment. The code uses it as the coordinator base URL and falls back to it only when the dedicated worker base URL is absent. The explicit worker URL and bypass secret must therefore describe the matching worker target for the environment being exercised.

### Dedicated worker: `wine-rec-chunk-worker`

Required runtime categories:

- **Queue and state:** `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `QSTASH_URL`, `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`
- **Upload persistence:** `BLOB_READ_WRITE_TOKEN`
- **OCR/browser:** `OCR_PROVIDER`, `OCR_SPACE_API_KEY`, `CHROMIUM_PACK_URL`
- **Provider behavior:** `WINE_PROFILE_PROVIDER_ORDER`, `ENABLE_VIVINO_DIRECT`, `VIVINO_DIRECT_DELAY_MS`, `VIVINO_DIRECT_MAX_RETRIES`, `VIVINO_DIRECT_BACKOFF_MS`, `VIVINO_DIRECT_FETCH_TASTES`
- **Invocation budget:** `SERVERLESS_WORKER_TIME_BUDGET_MS`

The current Vercel configuration has several capacity settings scoped to production only. Preserve those scopes when changing an environment; do not assume preview receives the production budget or concurrency settings.

## Local CLI setup

The top-level repository is not a Vercel project root. Link each deploy root independently and only to the existing project with the same name:

```bash
# Main web/API deployment
cd main
vercel link

# Dedicated chunk worker deployment
cd ../worker
vercel link
```

Confirm the linked project name and root before accepting either prompt. Linking creates ignored `.vercel/project.json` metadata only; it does not deploy, modify remote settings, or pull environment values.

Do not run `vercel` from the repository root: the root contains both deployable applications and can be mistaken for a new third project.

## Build and validation

Run the component-local checks before deploying:

```bash
cd main
npm install
npm run typecheck
npm test
npm run vercel-build

cd ../worker
npm install
npm run typecheck
npm run vercel-build
```

For a deployment-sensitive change, validate the full asynchronous path in a non-production environment:

1. Confirm the main preview and the intended worker preview URLs.
2. Confirm `CHUNK_WORKER_BASE_URL` targets that worker environment, not production or an unrelated preview.
3. Use a representative non-private fixture to submit an analysis.
4. Verify the analysis reaches the coordinator, enqueues chunk work, receives worker completion, and returns a result.
5. Inspect deployment logs for both project deployments if the job stalls or fails.
6. Validate provider behavior separately from pipeline completion: a rule-based fallback is resilience evidence, not a successful Vivino/provider-quality validation.

The checked-in helper `shared/scripts/benchmark-preview-analysis.sh` can drive a preview analysis only when given an explicit base URL and safe fixture inputs. It does not replace the cross-deployment routing check above.

## Deployment safety

- Preview deployments, Vercel environment changes, production deployments, alias changes, and external-provider tests require Russell’s approval immediately before the action.
- Do not use `--prod`, `--yes`, `--force`, or inline environment values to bypass that approval.
- Do not pull remote environments into `.env` files unless the destination, handling, and secret exposure risk were explicitly approved.
- Preserve the public production alias used by iOS: `https://wine-rec.vercel.app`.

## Live-state audit notes

Last audited from the Vercel CLI on 2026-08-10:

- Both Vercel projects exist and report `Ready` production deployments.
- The production `wine-rec` deployment exposes the expected API bundle, including coordinator and worker-compatible routes, in `iad1`.
- The production worker exposes only chunk-worker and worker-failure functions in `iad1`.
- Local clones are not Vercel-linked by default. Link deliberately as described above; never copy another clone's `.vercel` metadata or credentials.

## Private uploads: activation and compatibility

New uploads can use private Vercel Blob storage. This is opt-in and is not activated by deploying the code alone.

- `BLOB_UPLOAD_ACCESS=private` makes the main coordinator upload with private access and queue only `uploads/<job-id>`. The worker payload validates that path against its job ID and rejects mixed source references.
- Unset or explicit `public` preserves the existing public bearer-link behavior. Any other value fails closed; there is no fallback from a private upload or authenticated read to public access.
- Set `BLOB_READ_WRITE_TOKEN` to a credential for the matching **private store** on the intended main deployment. Changing the access option does not convert the existing public store.
- Existing signed public-URL and base64 messages remain readable. A queued private reference uses an authenticated private read regardless of the current setting for new uploads.
- The chunk worker consumes candidate state from Redis rather than raw upload bytes. Keep the source mirrored, but do not grant the worker a new private-store credential unless a verified execution path requires it.
- Do not disclose blob URLs, retrieve historical images, migrate objects, replace the shared production/preview public credential, or remove the legacy public store as part of activation.

### Least-access Preview trial

Before acting, obtain approval for the exact candidate SHA, paired Preview projects, new private Preview store, branch-scoped environment changes, bounded non-private fixtures, and deletion of only those new test objects. Confirm Hobby/free-plan availability and limits at creation time; do not accept a paid upgrade.

1. Keep production unchanged. Use a separate private Preview store and an isolated, healthy Preview Redis database shared only by this Preview pair.
2. Scope the private Blob token and `BLOB_UPLOAD_ACCESS=private` to the intended main Preview branch. Do not auto-connect a store to all environments. Preserve the existing public credential and all production scopes.
3. Preserve the worker project's global Ignored Build Step. If an exact candidate Preview is canceled by that policy, use its **Redeploy** dialog and uncheck **Use project's Ignore Build Step** for that one redeploy. Verify target Preview and exact source SHA before submission. Do not redeploy the old production worker or assume a `projectSettings` API override is temporary.
4. Confirm worker Preview readiness before configuring the main Preview's `CHUNK_WORKER_BASE_URL`, matching deployment-protection handling, signed QStash callbacks, and shared Preview Redis. Keep `ENABLE_VIVINO_DIRECT=false`, `WINE_PROFILE_PROVIDER_ORDER=rule-based`, and `OCR_PROVIDER=tesseract-js` for the trial.
5. Submit only the separately approved non-private fixtures. Verify private PUT/GET, no public raw-image read, coordinator-to-worker completion, cancellation, result display, and legacy in-flight compatibility. A rule-based result validates the pipeline, not Vivino quality.
6. Verify storage destination and queue references, record exact newly created test objects, and clean up only those objects after terminal state and retry quiescence if that cleanup was approved. No wildcard deletion or historical-data cleanup.

### Rollback and retention

Private queued jobs depend on the credential and immutable main deployment that created them. Keep that private-capable deployment, credential, store, and signing configuration available until all its jobs are terminal and retries are quiescent. Do not rotate the credential to a different store while those jobs are active.

A rollback to pre-private code attempts public uploads. It will fail while its credential still points to a private store. Changing only BLOB_UPLOAD_ACCESS to public is likewise not a validated rollback. Returning to public uploads requires a compatible public-store credential and explicit approval for that privacy change; preserve the separate immutable private-capable deployment and its credential for in-flight private jobs. Prefer a known private-capable rollback build or an actual tested maintenance mechanism. An invalid OCR provider value is not a maintenance switch.

Private access does **not** implement retention. Successful uploaded images currently have no time-based deletion policy. Deployment retention settings do not delete Blob objects. Best-effort cleanup after a publish error runs only after terminal job-state persistence succeeds. An accepted publish followed by a queue-ID bookkeeping failure retains its source and returns the accepted analysis ID; an uncertain publish plus unavailable terminal persistence also retains the source. Those retained objects may need later operator reconciliation, not automatic deletion. This is not a general retention guarantee. Historical deletion and a future retention schedule require a separately agreed policy.
