type OcrWorker = {
  recognize(image: Buffer, options: object, output: { tsv: boolean }): Promise<{ data: { tsv?: string | null } }>;
  terminate(): Promise<unknown>;
};

/** Bounded shared WASM workers. A worker never receives overlapping recognize jobs. */
export class TesseractWorkerPool {
  private ready: Promise<OcrWorker[]> | null = null;
  private tails: Promise<unknown>[];
  private next = 0;
  private closing: Promise<void> | null = null;

  constructor(private readonly create: () => Promise<OcrWorker>, private readonly size: number) {
    if (!Number.isInteger(size) || size < 1) throw new Error("Invalid OCR pool size");
    this.tails = Array.from({ length: size }, () => Promise.resolve());
  }

  private initialize(): Promise<OcrWorker[]> {
    if (!this.ready) {
      // Assign before invoking factories so simultaneous callers share one initialization.
      this.ready = Promise.resolve().then(async () => {
        const results = await Promise.allSettled(Array.from({ length: this.size }, () => this.create()));
        const workers = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") {
          await Promise.allSettled(workers.map((worker) => worker.terminate()));
          this.ready = null;
          throw failure.reason;
        }
        return workers;
      });
    }
    return this.ready;
  }

  recognize(image: Buffer): Promise<string> {
    if (this.closing) return Promise.reject(new Error("OCR pool is closing"));
    const ready = this.initialize();
    const slot = this.next++ % this.size;
    const result = this.tails[slot]!.then(async () => {
      const workers = await ready;
      // Tesseract.js v7 disables TSV by default. Plain text loses card geometry.
      const { data } = await workers[slot]!.recognize(image, {}, { tsv: true });
      if (typeof data.tsv !== "string" || !/^(?:level\t|[1-5]\t\d+\t)/.test(data.tsv)) {
        throw new Error("OCR engine did not return valid TSV layout data");
      }
      return data.tsv;
    });
    this.tails[slot] = result.catch(() => undefined);
    return result;
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closing = (async () => {
        await Promise.all(this.tails);
        const workers = await this.ready?.catch(() => []);
        await Promise.allSettled((workers ?? []).map((worker) => worker.terminate()));
        this.ready = null;
        this.next = 0;
      })().finally(() => { this.closing = null; });
    }
    return this.closing;
  }
}
