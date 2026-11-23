import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createApi, type Uploader } from '../../src/api/client';
import { ImportController, type FileStore, type OpStorage } from '../../src/core/controller';
import type { ImportOp } from '../../src/domain/types';
import type { FileProbe } from '../../src/domain/validate';

export const FIXTURES = path.resolve(__dirname, '../../../kit/fixtures');
export const fixture = (name: string) => path.join(FIXTURES, name);

export async function startKitMock(): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  const child: ChildProcess = spawn(process.execPath, [path.join(__dirname, 'run-kit-mock.mjs')], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const baseUrl = await new Promise<string>((resolve, reject) => {
    let buf = '';
    child.stdout!.on('data', d => {
      buf += String(d);
      const m = buf.match(/READY (\S+)/);
      if (m) resolve(m[1]);
    });
    child.once('exit', code => reject(new Error(`mock exited ${code}`)));
  });
  return {
    baseUrl,
    stop: () =>
      new Promise(resolve => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}

export function nodeProbe(file: string): FileProbe {
  return {
    async size() {
      return fs.statSync(file).size;
    },
    async open() {
      const fd = fs.openSync(file, 'r');
      return {
        async read(length: number) {
          const buf = Buffer.alloc(length);
          const n = fs.readSync(fd, buf, 0, length, null);
          return new Uint8Array(buf.subarray(0, n));
        },
        close: () => fs.closeSync(fd),
      };
    },
  };
}

export function nodeFileStore(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-'))) {
  const store: FileStore & { dir: string; list(): string[] } = {
    dir,
    probe: nodeProbe,
    async stage(source) {
      const target = path.join(dir, `${randomUUID()}.bin`);
      fs.copyFileSync(source, target);
      return target;
    },
    exists: uri => fs.existsSync(uri),
    remove: uri => fs.rmSync(uri, { force: true }),
    sweep(keep) {
      for (const f of fs.readdirSync(dir)) if (path.join(dir, f) !== keep) fs.rmSync(path.join(dir, f), { force: true });
    },
    list: () => fs.readdirSync(dir),
  };
  return store;
}

/** Test uploader: sends the file bytes as the raw body over real HTTP. */
export const nodeUploader: Uploader = {
  async upload(url, fileUri, headers, timeoutMs) {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: fs.readFileSync(fileUri),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, body: await res.text() };
  },
};

/** Storage that records every durable write (to assert "persisted before POST"). */
export function memoryStorage(initial: ImportOp | null = null) {
  let value = initial ? JSON.stringify(initial) : null;
  const writes: (ImportOp | null)[] = [];
  const storage: OpStorage & { writes: typeof writes; raw: () => string | null } = {
    writes,
    raw: () => value,
    async load() {
      return value ? JSON.parse(value) : null;
    },
    async save(op) {
      value = op ? JSON.stringify(op) : null;
      writes.push(op ? JSON.parse(value!) : null);
    },
  };
  return storage;
}

export function makeController(baseUrl: string, opts: { storage?: ReturnType<typeof memoryStorage>; files?: ReturnType<typeof nodeFileStore>; fetchFn?: typeof fetch } = {}) {
  const storage = opts.storage ?? memoryStorage();
  const files = opts.files ?? nodeFileStore();
  const api = createApi({ baseUrl: () => baseUrl, uploader: nodeUploader, fetchFn: opts.fetchFn, uploadTimeoutMs: 5000 });
  const controller = new ImportController({ api, storage, files, uuid: randomUUID, pollIntervalMs: 100 });
  return { controller, storage, files, api };
}

export async function mock(baseUrl: string, p: string, body?: unknown) {
  const res = await fetch(baseUrl + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

export const stats = async (baseUrl: string) => (await mock(baseUrl, '/__test/state')).stats;
export const reset = (baseUrl: string) => mock(baseUrl, '/__test/reset', {});
export const scenario = (baseUrl: string, mode: string) => mock(baseUrl, '/__test/scenario', { mode });

export async function waitFor(cond: () => boolean, timeoutMs = 5000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise(r => setTimeout(r, 25));
  }
}

export const picked = (name: string) => ({ uri: fixture(name), name, mimeType: null, pickerCopy: false });
