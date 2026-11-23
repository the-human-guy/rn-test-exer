import type { FileFormat } from './types';

export const MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
const CSV_HEADER = 'date,description,amount\n';
const HEAD_BYTES = 64;
const COUNT_CHUNK = 64 * 1024;

/** Minimal read access to a file. Implemented with expo-file-system in the app and node:fs in tests. */
export interface FileProbe {
  /** Size from metadata (no content read), or null if the provider doesn't report it. */
  size(): Promise<number | null>;
  open(): Promise<{ read(length: number): Promise<Uint8Array>; close(): void }>;
}

export type Declared = { name: string; mimeType?: string | null };

export type RejectReason = 'too_large' | 'empty' | 'unrecognized_content' | 'type_mismatch' | 'unreadable';

export type ValidationResult =
  | { ok: true; format: FileFormat; size: number }
  | { ok: false; reason: RejectReason };

/**
 * Same windows as the kit server: PDF = first 5 bytes are `%PDF-`; CSV = the first 24 bytes, with CR removed,
 * start with the header. A CRLF header doesn't fit in 24 bytes, so the server rejects it and so do we.
 */
export function detectFormat(head: Uint8Array): FileFormat | null {
  const ascii = (n: number) => String.fromCharCode(...head.subarray(0, n));
  if (ascii(5) === '%PDF-') return 'pdf';
  if (ascii(CSV_HEADER.length).replace(/\r/g, '').startsWith(CSV_HEADER)) return 'csv';
  return null;
}

/** Format implied by the extension / supplied MIME type. A hint only, never trusted alone. */
export function declaredFormat({ name, mimeType }: Declared): FileFormat | null {
  const ext = name.toLowerCase().split('.').pop();
  const mime = (mimeType ?? '').toLowerCase();
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (ext === 'csv' || mime === 'text/csv' || mime === 'text/comma-separated-values') return 'csv';
  return null;
}

/** Counts bytes in bounded chunks; stops as soon as `limit` is exceeded. Never holds the whole file. */
async function countUpTo(probe: FileProbe, limit: number): Promise<number> {
  const handle = await probe.open();
  try {
    let total = 0;
    for (;;) {
      const chunk = await handle.read(COUNT_CHUNK);
      if (chunk.length === 0) return total;
      total += chunk.length;
      if (total > limit) return total;
    }
  } finally {
    handle.close();
  }
}

export async function validateFile(probe: FileProbe, declared: Declared): Promise<ValidationResult> {
  try {
    let size = await probe.size();
    if (size === null) size = await countUpTo(probe, MAX_BYTES);
    if (size > MAX_BYTES) return { ok: false, reason: 'too_large' };
    if (size === 0) return { ok: false, reason: 'empty' };

    const handle = await probe.open();
    let head: Uint8Array;
    try {
      head = await handle.read(HEAD_BYTES);
    } finally {
      handle.close();
    }
    const detected = detectFormat(head);
    if (!detected) return { ok: false, reason: 'unrecognized_content' };
    const hinted = declaredFormat(declared);
    if (hinted && hinted !== detected) return { ok: false, reason: 'type_mismatch' };
    return { ok: true, format: detected, size };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}
