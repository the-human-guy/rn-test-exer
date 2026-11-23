import { applyServerJob } from '../src/domain/revision';
import type { ImportOp } from '../src/domain/types';
import { MAX_BYTES, validateFile, type FileProbe } from '../src/domain/validate';
import { sanitize } from '../src/log/logger';

function memProbe(bytes: Uint8Array, reportSize = true): FileProbe & { maxRead: number } {
  const probe = {
    maxRead: 0,
    async size() {
      return reportSize ? bytes.length : null;
    },
    async open() {
      let pos = 0;
      return {
        async read(n: number) {
          probe.maxRead = Math.max(probe.maxRead, n);
          const out = bytes.subarray(pos, pos + n);
          pos += out.length;
          return out;
        },
        close() {},
      };
    },
  };
  return probe;
}
const enc = (s: string) => new TextEncoder().encode(s);
const csv = enc('date,description,amount\n2026-09-01,X,-1.00\n');

describe('validateFile', () => {
  test('accepts pdf and csv by content', async () => {
    expect(await validateFile(memProbe(enc('%PDF-1.7 ...')), { name: 'a.pdf' })).toMatchObject({ ok: true, format: 'pdf' });
    expect(await validateFile(memProbe(csv), { name: 'a.csv' })).toMatchObject({ ok: true, format: 'csv' });
  });
  test('CSV header check uses the same 24-byte window as the server (CRLF header is rejected)', async () => {
    expect(await validateFile(memProbe(enc('date,description,amount\r\n1,2,3')), { name: 'a.csv' })).toEqual({ ok: false, reason: 'unrecognized_content' });
  });
  test('extension / MIME alone is not trusted', async () => {
    expect(await validateFile(memProbe(enc('This is plain text')), { name: 'x.pdf', mimeType: 'application/pdf' })).toEqual({ ok: false, reason: 'unrecognized_content' });
    expect(await validateFile(memProbe(csv), { name: 'x.pdf' })).toEqual({ ok: false, reason: 'type_mismatch' });
    expect(await validateFile(memProbe(enc('%PDF-1.4')), { name: 'x', mimeType: 'text/csv' })).toEqual({ ok: false, reason: 'type_mismatch' });
    expect(await validateFile(memProbe(enc('%PDF-1.4')), { name: 'no-extension' })).toMatchObject({ ok: true, format: 'pdf' });
  });
  test('size limit uses metadata and never reads the content of a too-large file', async () => {
    const big = memProbe(new Uint8Array(MAX_BYTES + 1));
    expect(await validateFile(big, { name: 'a.csv' })).toEqual({ ok: false, reason: 'too_large' });
    expect(big.maxRead).toBe(0);
    expect(await validateFile(memProbe(new Uint8Array(0)), { name: 'a.csv' })).toEqual({ ok: false, reason: 'empty' });
  });
  test('without size metadata, counts in bounded chunks', async () => {
    const big = new Uint8Array(MAX_BYTES + 1);
    big.set(csv);
    const p = memProbe(big, false);
    expect(await validateFile(p, { name: 'a.csv' })).toEqual({ ok: false, reason: 'too_large' });
    expect(p.maxRead).toBeLessThanOrEqual(64 * 1024);
    expect(await validateFile(memProbe(new Uint8Array(MAX_BYTES).fill(65), false), { name: 'a.csv' })).toEqual({ ok: false, reason: 'unrecognized_content' });
  });
  test('exactly 10 MiB is allowed', async () => {
    const b = new Uint8Array(MAX_BYTES);
    b.set(csv);
    expect(await validateFile(memProbe(b), { name: 'a.csv' })).toMatchObject({ ok: true, size: MAX_BYTES });
  });
});

describe('applyServerJob', () => {
  const base: ImportOp = { v: 1, importKey: 'k-12345678', file: { name: 'n', size: 1, format: 'csv' }, send: 'acked', job: { jobId: 'j1', status: 'ready', revision: 3, result: { currency: 'AUD', items: [] } } };
  test('drops stale and equal revisions', () => {
    expect(applyServerJob(base, { jobId: 'j1', status: 'processing', revision: 2 })).toBe(base);
    expect(applyServerJob(base, { jobId: 'j1', status: 'ready', revision: 3 })).toBe(base);
  });
  test('drops views of another job', () => {
    expect(applyServerJob(base, { jobId: 'j2', status: 'deleting', revision: 4 })).toBe(base);
  });
  test('advances and drops the result once deletion starts', () => {
    const next = applyServerJob(base, { jobId: 'j1', status: 'deleting', revision: 4 });
    expect(next.job).toEqual({ jobId: 'j1', status: 'deleting', revision: 4 });
  });
  test('deleted is terminal and drops the file name', () => {
    const del = applyServerJob(base, { jobId: 'j1', status: 'deleted', revision: 5 });
    expect(del.file).toEqual({ size: 1, format: 'csv' });
    expect(applyServerJob(del, { jobId: 'j1', status: 'ready', revision: 6 })).toBe(del);
  });
  test('deleting keeps the file name until deletion is confirmed', () => {
    expect(applyServerJob(base, { jobId: 'j1', status: 'deleting', revision: 4 }).file.name).toBe('n');
  });
});

test('logger sanitizer drops unknown fields and non-token strings', () => {
  expect(sanitize({ name: 'statement.csv', uri: 'file:///x', jobId: 'job-demo-001', reason: 'a b/c', size: 5 })).toEqual({ jobId: 'job-demo-001', size: 5 });
});
