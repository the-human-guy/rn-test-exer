import type { Api, HttpResult } from '../api/client';
import { applyServerJob } from '../domain/revision';
import type { ErrorCode, FileMeta, ImportOp, ServerJob } from '../domain/types';
import { validateFile, type FileProbe, type RejectReason } from '../domain/validate';
import { log } from '../log/logger';

/** A file chosen in the system picker. */
export type PickedFile = {
  uri: string;
  name: string;
  mimeType?: string | null;
  /** True when the picker itself created a copy inside our sandbox (iOS) that we must delete. */
  pickerCopy: boolean;
};

export interface OpStorage {
  load(): Promise<ImportOp | null>;
  /** Must resolve only after the write is durable. */
  save(op: ImportOp | null): Promise<void>;
}

export interface FileStore {
  probe(uri: string): FileProbe;
  /** Copies the picked bytes into app-private staging; returns the staged URI. */
  stage(sourceUri: string): Promise<string>;
  exists(uri: string): boolean;
  remove(uri: string): void;
  /** Deletes every staged file except `keep`. */
  sweep(keep?: string): void;
}

export type Draft = { stagedUri: string; file: FileMeta };

export type Busy = null | 'validating' | 'sending' | 'checking' | 'deleting' | 'refreshing';

export type Snapshot = {
  op: ImportOp | null;
  draft: Draft | null;
  rejection: RejectReason | null;
  busy: Busy;
  loaded: boolean;
  /** Time of the last successful manual status check (in memory only). */
  checkedAt: number | null;
};

export type ControllerDeps = {
  api: Api;
  storage: OpStorage;
  files: FileStore;
  uuid: () => string;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
};

const errorFromHttp = (r: HttpResult<unknown>): ErrorCode => {
  if (r.kind === 'network') return 'network';
  if (r.kind === 'timeout') return 'timeout';
  if (r.kind === 'ok') return 'unknown';
  if (r.status === 409) return 'key_conflict';
  if (r.status === 413) return 'too_large';
  if (r.status === 415) return 'unsupported_content';
  if (r.status === 404) return 'not_found';
  if (r.status >= 500) return 'server_error';
  return 'bad_request';
};

export class ImportController {
  private snap: Snapshot = { op: null, draft: null, rejection: null, busy: null, loaded: false, checkedAt: null };
  private listeners = new Set<(s: Snapshot) => void>();
  private chain: Promise<unknown> = Promise.resolve();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollDelay: number;
  private paused = false;
  private disposed = false;

  constructor(private deps: ControllerDeps) {
    this.pollDelay = deps.pollIntervalMs ?? 500;
  }

  // ---------- observation ----------
  get snapshot() {
    return this.snap;
  }
  subscribe(fn: (s: Snapshot) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private set(patch: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach(l => l(this.snap));
  }

  /**
   * Serialized, persisted update. `fn` receives the latest op, so concurrent responses never overwrite each other.
   * The promise resolves after the new state is durably stored.
   */
  private update(fn: (op: ImportOp | null) => ImportOp | null): Promise<ImportOp | null> {
    const run = this.chain.then(async () => {
      const prev = this.snap.op;
      const next = fn(prev);
      if (next !== prev) {
        await this.deps.storage.save(next);
        this.set({ op: next });
      }
      return next;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Update bound to one import: ignored if the op was replaced or cleared meanwhile. */
  private updateFor(importKey: string, fn: (op: ImportOp) => ImportOp) {
    return this.update(op => (op && op.importKey === importKey ? fn(op) : op));
  }

  private applyJob(importKey: string, job: ServerJob, extra?: (op: ImportOp) => ImportOp) {
    return this.updateFor(importKey, op => {
      let next = extra ? extra(op) : op;
      next = applyServerJob(next, job);
      const st = next.job?.status;
      if (next.del && (st === 'deleting' || st === 'deleted') && next.del.state !== 'accepted') {
        next = { ...next, del: { key: next.del.key, state: 'accepted' } };
      }
      if (next !== op) log('job.applied', { jobId: next.job?.jobId, status: st, revision: next.job?.revision });
      return next;
    });
  }

  // ---------- lifecycle ----------
  /** Called on app launch. Never re-sends the file on its own. */
  async start() {
    this.disposed = false;
    const op = await this.deps.storage.load();
    this.deps.files.sweep(op?.stagedUri);
    this.set({ op, loaded: true });
    if (!op) return;
    log('launch.restore', { send: op.send, status: op.job?.status, del: op.del?.state });
    if (op.send === 'pending' || op.send === 'sending' || op.send === 'unknown') {
      await this.updateFor(op.importKey, o => ({ ...o, send: 'unknown' }));
      await this.checkByKey();
      return;
    }
    if (op.del?.state === 'requesting') {
      // DELETE outcome unknown after relaunch: don't claim anything; ask the server.
      await this.updateFor(op.importKey, o => ({ ...o, del: { ...o.del!, state: 'failed', error: 'unknown' } }));
    }
    if (op.send === 'acked') await this.refresh();
  }

  pause() {
    this.paused = true;
    this.clearPoll();
  }
  resume() {
    this.paused = false;
    if (this.snap.op?.send === 'acked') void this.refresh();
  }
  dispose() {
    this.disposed = true;
    this.clearPoll();
  }
  /** Resolves when all queued persistence work is done (tests). */
  idle() {
    return this.chain;
  }

  // ---------- pick / confirm ----------
  async prepare(picked: PickedFile) {
    if (this.snap.op && !this.canStartNew()) return;
    this.discardDraft();
    this.set({ busy: 'validating', rejection: null });
    const { files } = this.deps;
    let stagedUri: string | null = null;
    try {
      const declared = { name: picked.name, mimeType: picked.mimeType };
      const source = await validateFile(files.probe(picked.uri), declared);
      if (!source.ok) return this.reject(source.reason);
      stagedUri = await files.stage(picked.uri);
      // Re-validate the private copy: the source could have changed between checks.
      const staged = await validateFile(files.probe(stagedUri), declared);
      if (!staged.ok || staged.format !== source.format) {
        files.remove(stagedUri);
        return this.reject(staged.ok ? 'type_mismatch' : staged.reason);
      }
      log('file.accepted', { format: staged.format, size: staged.size });
      this.set({ draft: { stagedUri, file: { name: picked.name, size: staged.size, format: staged.format } } });
    } catch {
      if (stagedUri) files.remove(stagedUri);
      this.reject('unreadable');
    } finally {
      if (picked.pickerCopy) files.remove(picked.uri);
      this.set({ busy: null });
    }
  }

  private reject(reason: RejectReason) {
    log('file.rejected', { reason });
    this.set({ rejection: reason });
  }

  discardDraft() {
    if (this.snap.draft) this.deps.files.remove(this.snap.draft.stagedUri);
    this.set({ draft: null, rejection: null });
  }

  /** Creates and persists the idempotency key BEFORE the first POST, then sends. */
  async confirm() {
    const draft = this.snap.draft;
    if (!draft || this.snap.busy) return;
    if (this.snap.op && !this.canStartNew()) return;
    // Busy is set synchronously so a second tap during the storage write can't create a second key.
    this.set({ busy: 'sending' });
    try {
      const old = this.snap.op;
      const op: ImportOp = { v: 1, importKey: this.deps.uuid(), file: draft.file, stagedUri: draft.stagedUri, send: 'pending' };
      await this.update(() => op);
      if (old?.stagedUri) this.deps.files.remove(old.stagedUri);
      this.set({ draft: null, checkedAt: null });
    } finally {
      this.set({ busy: null });
    }
    await this.send();
  }

  /** Explicit user retry after an unknown outcome. Same key, same bytes. */
  async retrySend() {
    if (this.snap.op?.send !== 'unknown' || this.snap.busy) return;
    await this.send();
  }

  private async send() {
    const op = this.snap.op;
    if (!op || !op.stagedUri) return;
    const key = op.importKey;
    if (!this.deps.files.exists(op.stagedUri)) {
      await this.updateFor(key, o => ({ ...o, send: 'unknown', sendError: 'staged_copy_missing' }));
      return;
    }
    this.set({ busy: 'sending' });
    try {
      await this.updateFor(key, o => ({ ...o, send: 'sending', sendError: undefined }));
      log('post.start', { size: op.file.size, format: op.file.format });
      const r = await this.deps.api.createImport(op.stagedUri, key, op.file.name ?? '');
      if (r.kind === 'ok') return await this.acked(key, r.data);
      const code = errorFromHttp(r);
      log('post.failed', { code, httpStatus: r.kind === 'http' ? r.status : undefined });
      if (r.kind === 'http' && r.status < 500) {
        // Definitive rejection: nothing was created for this key.
        await this.updateFor(key, o => ({ ...o, send: 'failed', sendError: code, stagedUri: undefined }));
        this.deps.files.remove(op.stagedUri);
        return;
      }
      // Lost response / timeout / 5xx: the job may exist. Ask by key — never resend automatically.
      await this.updateFor(key, o => ({ ...o, send: 'unknown', sendError: code }));
    } finally {
      this.set({ busy: null });
    }
    await this.checkByKey();
  }

  private async acked(importKey: string, job: ServerJob) {
    const staged = this.snap.op?.stagedUri;
    await this.applyJob(importKey, job, o => ({ ...o, send: 'acked', sendError: undefined, stagedUri: undefined }));
    // Remove the private copy only after the ack is persisted; a crash in between is handled by start() sweep.
    if (staged) this.deps.files.remove(staged);
    log('post.acked', { jobId: job.jobId });
    this.schedulePoll(true);
  }

  /** Recovers a job after an uncertain POST outcome. GET only. */
  async checkByKey() {
    const op = this.snap.op;
    if (!op || op.send !== 'unknown') return;
    this.set({ busy: 'checking' });
    try {
      const r = await this.deps.api.getByKey(op.importKey);
      if (r.kind === 'ok') return await this.acked(op.importKey, r.data);
      const code = errorFromHttp(r);
      log('bykey.miss', { code });
      await this.updateFor(op.importKey, o =>
        o.send === 'unknown' && o.sendError !== code ? { ...o, sendError: code } : o,
      );
    } finally {
      this.set({ busy: null });
    }
  }

  // ---------- status ----------
  /** One authoritative GET. Also used for the manual "check status" action. */
  async refresh() {
    const op = this.snap.op;
    if (!op?.job || op.send !== 'acked') return;
    if (op.job.status === 'deleted') return;
    const r = await this.deps.api.getJob(op.job.jobId);
    if (r.kind === 'ok') {
      await this.applyJob(op.importKey, r.data);
      this.pollDelay = this.deps.pollIntervalMs ?? 500;
    } else {
      const code = errorFromHttp(r);
      log('get.failed', { code });
      await this.updateFor(op.importKey, o => (o.pollError === code ? o : { ...o, pollError: code }));
      this.pollDelay = Math.min(this.pollDelay * 2, this.deps.maxPollIntervalMs ?? 5000);
    }
    this.schedulePoll();
  }

  async manualRefresh() {
    if (this.snap.busy) return;
    this.set({ busy: 'refreshing' });
    try {
      await this.refresh();
      // A check that returns the same revision changes nothing else on screen, so the time is the feedback.
      this.set({ checkedAt: this.snap.op?.pollError ? null : Date.now() });
    } finally {
      this.set({ busy: null });
    }
  }

  private needsPoll(op: ImportOp | null) {
    if (!op?.job || op.send !== 'acked') return false;
    const s = op.job.status;
    if (s === 'queued' || s === 'processing' || s === 'deleting') return true;
    return op.del?.state === 'accepted' && s !== 'deleted';
  }

  private schedulePoll(reset = false) {
    if (reset) this.pollDelay = this.deps.pollIntervalMs ?? 500;
    if (this.pollTimer || this.paused || this.disposed || !this.needsPoll(this.snap.op)) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.refresh();
    }, this.pollDelay);
  }

  private clearPoll() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  // ---------- delete ----------
  async requestDelete() {
    const op = this.snap.op;
    if (!op?.job || op.send !== 'acked' || this.snap.busy) return;
    if (op.del?.state === 'accepted' || op.job.status === 'deleted') return;
    const importKey = op.importKey;
    // Key persisted before the first DELETE and reused for every retry.
    const delKey = op.del?.key ?? this.deps.uuid();
    this.set({ busy: 'deleting' });
    try {
      await this.updateFor(importKey, o => ({ ...o, del: { key: delKey, state: 'requesting' } }));
      const r = await this.deps.api.deleteJob(op.job.jobId, delKey);
      if (r.kind === 'ok') {
        await this.applyJob(importKey, r.data, o => ({ ...o, del: { key: delKey, state: 'accepted' } }));
        log('delete.accepted', { status: r.data.status, revision: r.data.revision });
        this.schedulePoll(true);
      } else {
        const code = errorFromHttp(r);
        log('delete.failed', { code });
        await this.updateFor(importKey, o => ({ ...o, del: { key: delKey, state: 'failed', error: code } }));
      }
    } finally {
      this.set({ busy: null });
    }
  }

  // ---------- reset ----------
  /** A new import is allowed only when nothing for the current key can exist on the server. */
  canStartNew() {
    const op = this.snap.op;
    if (!op) return true;
    if (op.send === 'failed') return true;
    return op.job?.status === 'deleted';
  }

  /** True while the private copy needed for "Send again" is still on disk. */
  hasStagedCopy() {
    const uri = this.snap.op?.stagedUri;
    return !!uri && this.deps.files.exists(uri);
  }

  /**
   * Gives up on an upload whose outcome is unknown. By-key 404 means "not found yet", so the key is checked
   * once more first: if the job turned up it is adopted instead of discarded.
   */
  async discardUnknown() {
    const op = this.snap.op;
    if (!op || op.send !== 'unknown' || this.snap.busy) return;
    await this.checkByKey();
    const now = this.snap.op;
    if (now?.importKey === op.importKey && now.send === 'unknown' && now.sendError === 'not_found') {
      await this.clearLocal(true);
    }
  }

  /** Forget the local record (only when nothing is left on the server, or per diagnostics). */
  async clearLocal(force = false) {
    if (!force && !this.canStartNew()) return;
    this.clearPoll();
    const staged = this.snap.op?.stagedUri;
    await this.update(() => null);
    if (staged) this.deps.files.remove(staged);
    this.set({ rejection: null });
  }
}
