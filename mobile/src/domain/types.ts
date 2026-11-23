export type FileFormat = 'pdf' | 'csv';

export type JobStatus = 'queued' | 'processing' | 'ready' | 'deleting' | 'deleted';

export type RecurringItem = {
  id: string;
  merchant: string;
  amountMinor: number;
  cadence: string;
  lastSeen: string;
};

export type ReadyResult = {
  currency: string;
  items: RecurringItem[];
};

/** Authoritative job view as returned by the server. */
export type ServerJob = {
  jobId: string;
  status: JobStatus;
  revision: number;
  result?: ReadyResult;
};

export type SendState =
  | 'pending' // key persisted, request not issued yet
  | 'sending' // request in flight
  | 'unknown' // outcome uncertain (lost response / relaunch); never resent automatically
  | 'acked' // server confirmed a job for this key
  | 'failed'; // definitive client/server rejection

export type DeleteState =
  | 'requesting' // delete key persisted, DELETE in flight
  | 'failed' // DELETE not accepted (or outcome unknown) — server data still present
  | 'accepted'; // server returned 202 deleting; waiting for GET status=deleted

export type ErrorCode =
  | 'network'
  | 'timeout'
  | 'key_conflict'
  | 'too_large'
  | 'unsupported_content'
  | 'bad_request'
  | 'server_error'
  | 'not_found'
  | 'staged_copy_missing'
  | 'unknown';

export type FileMeta = {
  /** Display name. Kept only in app-private storage; never logged. */
  name: string;
  size: number;
  format: FileFormat;
};

/** The single persisted import operation. */
export type ImportOp = {
  v: 1;
  importKey: string;
  file: FileMeta;
  /** App-private copy of the bytes; present only while a (re)send may be needed. */
  stagedUri?: string;
  send: SendState;
  sendError?: ErrorCode;
  job?: ServerJob;
  del?: { key: string; state: DeleteState; error?: ErrorCode };
  /** Last polling problem (transient, informative). */
  pollError?: ErrorCode;
};
