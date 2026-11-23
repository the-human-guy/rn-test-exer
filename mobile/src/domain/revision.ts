import type { ImportOp, ServerJob } from './types';

/**
 * Applies a server job view to the operation.
 * - Monotonic: a view with revision <= current revision is dropped (stale_status, late responses).
 * - Terminal: once deleted, nothing is applied (a late response can't resurrect the job).
 * - Bound: a view for another job id is dropped.
 * - Minimal: the result is kept only while ready; the file name is dropped once deletion is confirmed.
 * Returns the same object when nothing changed.
 */
export function applyServerJob(op: ImportOp, incoming: ServerJob): ImportOp {
  const current = op.job;
  if (current) {
    if (incoming.jobId !== current.jobId) return op;
    if (current.status === 'deleted') return op;
    if (incoming.revision <= current.revision) return op;
  }
  const job: ServerJob = { ...incoming };
  if (job.status !== 'ready') delete job.result;
  const file = job.status === 'deleted' ? { size: op.file.size, format: op.file.format } : op.file;
  return { ...op, job, file, pollError: undefined };
}

export const isTerminal = (op: ImportOp) => op.job?.status === 'deleted';
