import { describe, expect, it, vi } from "vitest";
import { TesseractWorkerPool } from "./tesseract-worker-pool.js";
const tsv = "level\tpage_num\n";
const worker = () => ({ recognize: vi.fn(async () => ({ data: { tsv } })), terminate: vi.fn(async () => {}) });
describe("Tesseract worker ownership", () => {
  it("shares initialization and serializes each worker across concurrent scans", async () => {
    let active = 0; let max = 0;
    const w = worker();
    w.recognize.mockImplementation(async () => { active++; max = Math.max(active, max); await new Promise(r => setTimeout(r, 2)); active--; return {data:{tsv}}; });
    const create = vi.fn(async () => w); const pool = new TesseractWorkerPool(create, 1);
    expect(await Promise.all([1,2,3].map(() => pool.recognize(Buffer.from("test"))))).toEqual([tsv,tsv,tsv]);
    expect(create).toHaveBeenCalledTimes(1); expect(max).toBe(1);
    expect(w.recognize).toHaveBeenCalledWith(Buffer.from("test"), {}, {tsv:true});
    await pool.close(); expect(w.terminate).toHaveBeenCalledTimes(1);
  });
  it("cleans partially initialized workers and can retry initialization", async () => {
    const w=worker(); const create=vi.fn().mockResolvedValueOnce(w).mockRejectedValueOnce(new Error("init failed")).mockResolvedValue(w);
    const pool=new TesseractWorkerPool(create,2);
    await expect(pool.recognize(Buffer.alloc(0))).rejects.toThrow("init failed");
    expect(w.terminate).toHaveBeenCalledTimes(1);
    await expect(pool.recognize(Buffer.alloc(0))).resolves.toBe(tsv); await pool.close();
  });
  it("rejects missing layout without poisoning the next recognition", async () => {
    const w=worker(); w.recognize.mockResolvedValueOnce({data:{tsv:""}});
    const pool=new TesseractWorkerPool(async()=>w,1);
    await expect(pool.recognize(Buffer.alloc(0))).rejects.toThrow("valid TSV");
    await expect(pool.recognize(Buffer.alloc(0))).resolves.toBe(tsv); await pool.close();
  });
  it("drains queued work before shutdown and supports a fresh pool afterward", async () => {
    const w=worker(); let release!:()=>void;
    w.recognize.mockImplementationOnce(async()=>{await new Promise<void>(r=>{release=r}); return {data:{tsv}}});
    const create=vi.fn(async()=>w); const pool=new TesseractWorkerPool(create,1);
    const scan=pool.recognize(Buffer.alloc(0)); await new Promise(r=>setTimeout(r,0));
    const closed=pool.close(); await expect(pool.recognize(Buffer.alloc(0))).rejects.toThrow("closing");
    expect(w.terminate).not.toHaveBeenCalled(); release(); await scan; await closed;
    await expect(pool.recognize(Buffer.alloc(0))).resolves.toBe(tsv); expect(create).toHaveBeenCalledTimes(2); await pool.close();
  });
});
