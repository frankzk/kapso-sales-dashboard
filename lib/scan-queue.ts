interface ScanJob {
  /** Includes the destination captured when the QR was read. */
  key: string;
  run: () => Promise<void>;
  onError: (error: unknown) => void;
}

/** Keep every distinct pending scan, in order, including while the server is slow. */
export function createScanQueue(onPending: (count: number) => void) {
  const jobs: ScanJob[] = [];
  let draining = false;
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (jobs.length) {
        const job = jobs[0]!;
        try { await job.run(); }
        catch (error) { job.onError(error); }
        finally { jobs.shift(); onPending(jobs.length); }
      }
    } finally { draining = false; }
  }
  return {
    get pending() { return jobs.length; },
    enqueue(job: ScanJob) {
      if (jobs.some((pending) => pending.key === job.key)) return false;
      jobs.push(job);
      onPending(jobs.length);
      void drain();
      return true;
    },
  };
}
