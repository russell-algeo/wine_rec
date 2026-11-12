# Reduced-menu OCR regression fixture

`photo-reduced-original.tsv` is the raw local Tesseract.js 7.0.0 / tesseract.js-core 7.0.0
TSV from the existing non-private photographed-menu fixture
`shared/test/fixtures/Screenshot 2026-03-08 at 10.48.03 PM.png` (the actual name uses
U+202F before PM), resized with Sharp 0.34.5 to width 554 and JPEG quality 80.
The original PNG SHA-256 is
`f5c226db41162b6966a9a1480dabaf9a298f6aac6e73473270a17289d51cc400`.
The source is unchanged; this TSV is the unfiltered `original` image pass using
`PSM.SINGLE_BLOCK` and the repository's bundled English language data.

The expected $31 (Stéphane Coquillette), $16 (Asahara Shuzo), and $17
(Kidoizumi Shuzo) are visible in the source pixels and already present in this
TSV. Three detached edge artifacts follow them: `_|`, `.`, and `‘3`.
Before the layout correction these suffixes caused all three prices to be null.
The deterministic test uses this capture; the real-engine test independently
regenerates the compressed image and runs the full local OCR selection pipeline.

This fixture establishes neither provider-backed wine identity nor general OCR
accuracy. In particular, a separate 720px/JPEG80 transform misreads $17 as $47,
and the RED screenshot has known region errors. No dictionary/digit correction
or additional hosted processing is part of this change.
