/** Own an eager upload until it is adopted by the results view or abandoned.
 * Abandoning a pending HTTP request must still cancel a job returned later.
 * Cancellation is best-effort, one attempt only: never resubmit the upload.
 */
export function createEagerUpload<T extends { analysisId: string }>(
  promise: Promise<T>,
  cancelJob: (id: string) => Promise<unknown>,
  kind: "file" | "url",
) {
  let state: "active" | "canceled" | "adopted" = "active";
  let result: T | undefined;
  let cancelSent = false;
  function cancelResolvedJob() {
    if (!result || cancelSent) return;
    cancelSent = true;
    // Handle synchronous and asynchronous transport failures without an unhandled rejection.
    void Promise.resolve().then(() => cancelJob(result!.analysisId)).catch(() => {});
  }
  void promise.then((value) => {
    result = value;
    if (state === "canceled") cancelResolvedJob();
  }).catch(() => {});
  return {
    kind,
    cancel() {
      if (state !== "active") return;
      state = "canceled";
      cancelResolvedJob();
    },
    async adopt(): Promise<T | null> {
      try {
        const value = await promise;
        if (state !== "active") return null;
        state = "adopted";
        return value;
      } catch (error) {
        if (state === "canceled") return null;
        throw error;
      }
    },
  };
}
export type EagerUpload<T extends { analysisId: string }> = ReturnType<typeof createEagerUpload<T>>;
