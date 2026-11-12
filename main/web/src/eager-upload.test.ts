import { describe, expect, it, vi } from 'vitest';
import { createEagerUpload } from './eager-upload';
function deferred() {
  let resolve!: (value: { analysisId: string }) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<{ analysisId: string }>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
describe('eager upload ownership (offline)', () => {
  for (const kind of ['file', 'url'] as const) {
    it(`cancels late ${kind} response exactly once after removal`, async () => {
      const d = deferred(); const cancel = vi.fn().mockResolvedValue(undefined);
      const upload = createEagerUpload(d.promise, cancel, kind);
      upload.cancel(); upload.cancel(); d.resolve({ analysisId: 'late' }); await settle();
      expect(cancel).toHaveBeenCalledExactlyOnceWith('late');
      expect(await upload.adopt()).toBeNull();
    });
  }
  it('does not cancel replacement when abandoned response arrives', async () => {
    const a = deferred(); const b = deferred(); const cancel = vi.fn().mockResolvedValue(undefined);
    const old = createEagerUpload(a.promise, cancel, 'file'); old.cancel();
    const current = createEagerUpload(b.promise, cancel, 'file');
    b.resolve({ analysisId: 'new' }); expect(await current.adopt()).toEqual({ analysisId: 'new' });
    a.resolve({ analysisId: 'old' }); await settle(); expect(cancel).toHaveBeenCalledExactlyOnceWith('old');
  });
  it('cancels resolved but unadopted job', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const upload = createEagerUpload(Promise.resolve({ analysisId: 'ready' }), cancel, 'file');
    await settle(); upload.cancel(); upload.cancel(); await settle();
    expect(cancel).toHaveBeenCalledExactlyOnceWith('ready');
  });
  it('does not launch pending adoption after cancellation', async () => {
    const d = deferred(); const cancel = vi.fn().mockResolvedValue(undefined);
    const upload = createEagerUpload(d.promise, cancel, 'file');
    const adopting = upload.adopt(); upload.cancel(); d.resolve({ analysisId: 'abandoned' });
    expect(await adopting).toBeNull(); await settle(); expect(cancel).toHaveBeenCalledExactlyOnceWith('abandoned');
  });
  it('transfers ownership once, without canceling adopted run on reset', async () => {
    const cancel = vi.fn(); const d = deferred(); const upload = createEagerUpload(d.promise, cancel, 'file');
    const adopting = upload.adopt(); d.resolve({ analysisId: 'results' });
    expect(await adopting).toEqual({ analysisId: 'results' });
    upload.cancel(); expect(await upload.adopt()).toBeNull(); await settle(); expect(cancel).not.toHaveBeenCalled();
  });
  it('handles rejected abandoned uploads without phantom cancellation', async () => {
    const d = deferred(); const cancel = vi.fn(); const upload = createEagerUpload(d.promise, cancel, 'url');
    upload.cancel(); d.reject(new Error('upload failed')); await settle(); expect(cancel).not.toHaveBeenCalled();
    expect(await upload.adopt()).toBeNull();
  });
  it('ignores stale rejection after pending adoption is canceled', async () => {
    const d = deferred(); const cancel = vi.fn(); const upload = createEagerUpload(d.promise, cancel, 'file');
    const adopting = upload.adopt(); upload.cancel(); d.reject(new Error('stale failure'));
    expect(await adopting).toBeNull(); expect(cancel).not.toHaveBeenCalled();
  });
  it('preserves active upload failures for the current view', async () => {
    const d = deferred(); const upload = createEagerUpload(d.promise, vi.fn(), 'file');
    const adopting = upload.adopt(); d.reject(new Error('current failure'));
    await expect(adopting).rejects.toThrow('current failure');
  });
  for (const mode of ['sync', 'async']) {
    it(`does not retry or leak ${mode} cancellation failure`, async () => {
      const cancel = vi.fn(() => { if (mode === 'sync') throw Error('failed'); return Promise.reject(Error('failed')); });
      const upload = createEagerUpload(Promise.resolve({ analysisId: 'terminal' }), cancel, 'file');
      upload.cancel(); await settle(); upload.cancel(); await settle(); expect(cancel).toHaveBeenCalledTimes(1);
    });
  }
  it('retains pending transport until server-created job is identified', async () => {
    const d = deferred(); const cancel = vi.fn().mockResolvedValue(undefined);
    const upload = createEagerUpload(d.promise, cancel, 'file');
    upload.cancel(); await settle(); expect(cancel).not.toHaveBeenCalled();
    d.resolve({ analysisId: 'created' }); await settle(); expect(cancel).toHaveBeenCalledExactlyOnceWith('created');
  });
});
