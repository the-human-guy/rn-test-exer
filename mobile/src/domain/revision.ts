import type { ImportOp, ServerJob } from './types';

/**
 * Applies a server job view to the operation.
 * - Monotonic: a view with revision <= current revision is dropped (stale_status, late responses).
 * - Terminal: once deleted, nothing is applied (a late response can't resurrect the job).
 * - Bound: a view for another job id is dropped.
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
  // Keep the result only while it is the live state; drop it once deletion starts.
  if (job.status !== 'ready') delete job.result;
  return { ...op, job, pollError: undefined };
}

export const isTerminal = (op: ImportOp) => op.job?.status === 'deleted';
