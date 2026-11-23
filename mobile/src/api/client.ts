import type { JobStatus, ServerJob } from '../domain/types';

const STATUSES: JobStatus[] = ['queued', 'processing', 'ready', 'deleting', 'deleted'];

/** Streams a local file as the raw request body. Implemented natively in the app, with node:fs in tests. */
export interface Uploader {
  upload(
    url: string,
    fileUri: string,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<{ status: number; body: string }>;
}

export type HttpResult<T> =
  | { kind: 'ok'; status: number; data: T }
  | { kind: 'http'; status: number }
  | { kind: 'network' }
  | { kind: 'timeout' };

export type MockStats = {
  createRequests: number;
  newJobs: number;
  duplicateHits: number;
  acceptedBytes: number;
  deleteRequests: number;
};

export type Scenario = 'happy' | 'lost_ack' | 'stale_status' | 'delete_failure';

export function parseJob(raw: unknown): ServerJob | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.jobId !== 'string' || typeof r.revision !== 'number') return null;
  if (!STATUSES.includes(r.status as JobStatus)) return null;
  const job: ServerJob = { jobId: r.jobId, status: r.status as JobStatus, revision: r.revision };
  if (job.status === 'ready') {
    if (typeof r.currency !== 'string' || !Array.isArray(r.items)) return null;
    job.result = {
      currency: r.currency,
      items: r.items
        .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
        .map(i => ({
          id: String(i.id),
          merchant: String(i.merchant),
          amountMinor: Number(i.amountMinor),
          cadence: String(i.cadence),
          lastSeen: String(i.lastSeen),
        })),
    };
  }
  return job;
}

type FetchFn = typeof fetch;

export function createApi(opts: {
  baseUrl: () => string;
  uploader: Uploader;
  fetchFn?: FetchFn;
  timeoutMs?: number;
  uploadTimeoutMs?: number;
}) {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const uploadTimeoutMs = opts.uploadTimeoutMs ?? 60_000;
  const url = (path: string) => opts.baseUrl().replace(/\/+$/, '') + path;

  async function request(path: string, init: RequestInit = {}): Promise<HttpResult<unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(url(path), { ...init, signal: controller.signal });
      const text = await res.text();
      if (res.status < 200 || res.status >= 300) return { kind: 'http', status: res.status };
      return { kind: 'ok', status: res.status, data: text ? JSON.parse(text) : null };
    } catch {
      return controller.signal.aborted ? { kind: 'timeout' } : { kind: 'network' };
    } finally {
      clearTimeout(timer);
    }
  }

  function asJob(r: HttpResult<unknown>): HttpResult<ServerJob> {
    if (r.kind !== 'ok') return r;
    const job = parseJob(r.data);
    return job ? { kind: 'ok', status: r.status, data: job } : { kind: 'http', status: 502 };
  }

  return {
    async createImport(fileUri: string, key: string, fileName: string): Promise<HttpResult<ServerJob>> {
      try {
        const res = await opts.uploader.upload(
          url('/imports'),
          fileUri,
          {
            'Content-Type': 'application/octet-stream',
            'Idempotency-Key': key,
            'X-File-Name': encodeHeaderValue(fileName),
          },
          uploadTimeoutMs,
        );
        if (res.status < 200 || res.status >= 300) return { kind: 'http', status: res.status };
        const job = parseJob(JSON.parse(res.body));
        return job ? { kind: 'ok', status: res.status, data: job } : { kind: 'http', status: 502 };
      } catch (e) {
        return (e as Error)?.name === 'TimeoutError' ? { kind: 'timeout' } : { kind: 'network' };
      }
    },
    getByKey: async (key: string) => asJob(await request(`/imports/by-key/${encodeURIComponent(key)}`)),
    getJob: async (jobId: string) => asJob(await request(`/imports/${encodeURIComponent(jobId)}`)),
    deleteJob: async (jobId: string, key: string) =>
      asJob(await request(`/imports/${encodeURIComponent(jobId)}`, { method: 'DELETE', headers: { 'Idempotency-Key': key } })),

    // Test-control routes of the kit mock (diagnostics only).
    test: {
      reset: () => request('/__test/reset', { method: 'POST' }),
      setScenario: (mode: Scenario) =>
        request('/__test/scenario', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode }),
        }),
      state: async (): Promise<HttpResult<{ mode: Scenario; stats: MockStats }>> =>
        (await request('/__test/state')) as HttpResult<{ mode: Scenario; stats: MockStats }>,
    },
  };
}

export type Api = ReturnType<typeof createApi>;

/** HTTP header values must be ASCII; non-ASCII names are percent-encoded. */
export function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  const safe = /^[\x20-\x7e]*$/.test(value) ? value : encodeURIComponent(value);
  return safe.slice(0, 255) || 'statement';
}
