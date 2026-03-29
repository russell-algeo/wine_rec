# Tesseract.js Migration Plan

Replace the remote OCR.space provider with Tesseract.js (WASM) running locally inside the Vercel
serverless function. OCR.space stays in the codebase as a fallback, toggled by `OCR_PROVIDER`.

---

## Why This Works (and What to Watch)

Vercel's Node File Trace bundler does **not** auto-include `.wasm` files found inside
`node_modules/`, because static analysis cannot prove they're needed at runtime. The fix is the
`includeFiles` option in `vercel.json`, which forces extra files into the function bundle. Language
data (`eng.traineddata`, ~10 MB) must also be bundled the same way rather than fetched from
jsDelivr at cold-start time — cold-start CDN fetches can eat 5–10 s and trigger Vercel's timeout.

On Vercel at runtime `process.cwd()` resolves to `/var/task`. **Never use `__dirname`** — esbuild
rewrites it to the build machine's path, which is wrong in production.

---

## Step 1 — Download `eng.traineddata`

Download the tessdata_fast English model (LSTM-only, ~10 MB) into `main/tessdata/`. Run this once
locally:

```bash
mkdir -p main/tessdata
curl -L https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata \
  -o main/tessdata/eng.traineddata
```

Commit `main/tessdata/eng.traineddata` to the repo. It is a binary asset that Vercel must bundle
with the function. Do **not** add it to `.gitignore`.

---

## Step 2 — Install `tesseract.js`

Install into the `wine-rec-main` project root:

```bash
cd main && npm install tesseract.js
```

No separate `tesseract.js-core` install is needed — it is a peer dependency that `tesseract.js`
installs automatically.

---

## Step 3 — Add `TesseractJsOcrProvider` to `main/src/providers/ocr.ts`

Add the following to `ocr.ts`, alongside the existing providers. Key design decisions:

- **Module-level singleton worker**: Tesseract WASM initialization takes 1–3 s on a cold start.
  A module-level variable persists across warm invocations in the same container, so we pay that
  cost at most once per container lifetime.
- **Explicit paths via `process.cwd()`**: Force all file loads (WASM, worker script, language data)
  to use local filesystem paths. No CDN fetches ever.
- **`gzip: false`**: The bundled `eng.traineddata` is uncompressed. Setting this prevents
  Tesseract.js from appending `.gz` to the filename when looking it up.
- **`cacheMethod: "none"`**: The file is already local; skip the caching logic entirely.
- **`workerBlobURL: false`**: Blob URL worker creation is unreliable in Node.js serverless contexts.
- **TSV output**: `worker.recognize(image, {}, { tsv: true })` returns `data.tsv` in exactly the
  same 11-column format as the native Tesseract binary. The existing `buildLayoutAwareTextFromTsv`
  parser works without modification.

```typescript
// Module-level singleton — persists across warm invocations
let _tesseractWorker: import("tesseract.js").Worker | null = null;

async function getTesseractJsWorker(): Promise<import("tesseract.js").Worker> {
  if (_tesseractWorker) return _tesseractWorker;

  const { createWorker } = await import("tesseract.js");
  const base = process.cwd(); // '/var/task' on Vercel

  _tesseractWorker = await createWorker("eng", 1, {
    corePath: path.join(base, "node_modules/tesseract.js-core"),
    workerPath: path.join(
      base,
      "node_modules/tesseract.js/src/worker-script/node/index.js",
    ),
    langPath: path.join(base, "tessdata"),
    gzip: false,
    cacheMethod: "none",
    workerBlobURL: false,
  });

  return _tesseractWorker;
}

class TesseractJsOcrProvider implements OcrProvider {
  name = "tesseract-js";
  isEnabled = true;
  detail = "Uses Tesseract.js (WASM) for image uploads. No external API dependency.";

  async extractText(input: {
    buffer?: Buffer;
    storagePath: string;
    filename: string;
    mimeType: string;
  }): Promise<string> {
    if (input.filename.toLowerCase().endsWith(".txt")) {
      return readTextInput(input);
    }

    if (input.mimeType === "application/pdf") {
      throw new Error("Tesseract.js OCR currently supports image uploads, not PDFs");
    }

    const bytes = await readInputBuffer(input);
    const worker = await getTesseractJsWorker();
    const { data } = await worker.recognize(bytes, {}, { tsv: true });
    return buildLayoutAwareTextFromTsv(data.tsv ?? "").trim();
  }
}
```

Register it in `createOcrProvider()`:

```typescript
export function createOcrProvider(): OcrProvider {
  if (appConfig.ocrProvider === "tesseract-js") {
    return new TesseractJsOcrProvider();
  }
  if (appConfig.ocrProvider === "tesseract") {
    return new TesseractOcrProvider();
  }
  if (appConfig.ocrProvider === "ocr-space") {
    return new OcrSpaceProvider();
  }
  return new MockOcrProvider();
}
```

---

## Step 4 — Update `vercel.json`

Add `includeFiles` to bundle the WASM files and language data. Bump memory to 2048 MB — Tesseract's
WASM heap starts at ~150–200 MB and the full process RSS is ~300–500 MB; 1024 MB is technically
enough but 2048 gives safe headroom for large images.

```json
{
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "installCommand": "npm install",
  "framework": null,
  "functions": {
    "api/**/*.ts": {
      "maxDuration": 60,
      "memory": 2048,
      "includeFiles": "{node_modules/tesseract.js,node_modules/tesseract.js-core,tessdata}/**"
    }
  }
}
```

The brace expansion glob includes:
- `node_modules/tesseract.js/**` — worker script at `src/worker-script/node/index.js`
- `node_modules/tesseract.js-core/**` — all four WASM variants (Tesseract selects the right one at
  runtime based on SIMD support)
- `tessdata/**` — the `eng.traineddata` language model

---

## Step 5 — Update `appConfig` in `main/src/config.ts`

The `ocrProvider` key already exists as a plain string. No structural change is required — just
document the new valid value:

```typescript
// ocrProvider accepts: "mock" | "ocr-space" | "tesseract" | "tesseract-js"
ocrProvider: process.env.OCR_PROVIDER ?? "mock",
```

---

## Step 6 — Update Environment Config

**`.env.vercel`** — switch the active provider:
```
OCR_PROVIDER=tesseract-js
```
Leave `OCR_SPACE_API_KEY` in place — switching back is a one-line env var change.

**`.env.example`** — update the comment to document valid values:
```
# OCR_PROVIDER options: mock | ocr-space | tesseract | tesseract-js
OCR_PROVIDER=mock
```

---

## Step 7 — Local Testing Before Deploy

The `tesseract-js` provider works locally too (Tesseract.js runs in Node.js without any system
binary). Set `OCR_PROVIDER=tesseract-js` in `.env` to test locally end-to-end:

```bash
OCR_PROVIDER=tesseract-js npm run dev:api
```

The first request will be slow (worker initialization). Subsequent requests on the same process
will reuse the singleton worker and be faster.

---

## Known Limitations

| Constraint | Detail |
|---|---|
| No PDF support | Same limitation as the existing local Tesseract binary provider |
| Cold-start latency | ~1–3 s for WASM + language model initialization on first request in a new container |
| WASM heap stays expanded | If a large image forces heap growth, subsequent warm requests in the same container also use elevated memory |
| 4.5 MB request body limit | Vercel limits POST body to 4.5 MB. iPhone photos as base64 can exceed this. The current upload handler reads a `multipart/form-data` file — multipart encoding itself adds ~33% overhead. Images over ~3.3 MB raw may need client-side resize before upload. (This was a pre-existing issue, not introduced by this change.) |

---

## Rollback

To revert to OCR.space at any time, set:
```
OCR_PROVIDER=ocr-space
```
No code changes required.
