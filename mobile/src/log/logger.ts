/**
 * Privacy-safe logger. Only allow-listed, non-identifying fields are emitted.
 * File names, bytes, URIs and transaction descriptions can never pass through:
 * unknown fields are dropped, and string values are emitted only for allow-listed enum-like fields.
 */
const ALLOWED = new Set([
  'jobId',
  'status',
  'revision',
  'send',
  'del',
  'code',
  'httpStatus',
  'size',
  'format',
  'reason',
  'scenario',
]);

export type LogFields = Record<string, unknown>;
export type LogSink = (line: string) => void;

let sink: LogSink = line => {
  if (typeof __DEV__ !== 'undefined' && __DEV__) console.log(line);
};

export function setLogSink(next: LogSink) {
  sink = next;
}

export function sanitize(fields: LogFields = {}): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!ALLOWED.has(k)) continue;
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && /^[\w.-]{1,64}$/.test(v)) out[k] = v;
  }
  return out;
}

export function log(event: string, fields?: LogFields) {
  sink(`[import] ${event} ${JSON.stringify(sanitize(fields))}`);
}
