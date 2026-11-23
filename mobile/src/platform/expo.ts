import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, FileMode, Paths, UploadType } from 'expo-file-system';
import { Platform } from 'react-native';
import type { Uploader } from '../api/client';
import type { FileStore, OpStorage, PickedFile } from '../core/controller';
import type { ImportOp } from '../domain/types';
import type { FileProbe } from '../domain/validate';

const OP_KEY = 'import-op-v1';
const BASE_URL_KEY = 'settings-base-url-v1';
export const DEFAULT_BASE_URL = 'http://127.0.0.1:8787';

export const uuid = () => Crypto.randomUUID();

/** AsyncStorage: each save is awaited by the controller before any network step. */
export const asyncOpStorage: OpStorage = {
  async load() {
    try {
      const raw = await AsyncStorage.getItem(OP_KEY);
      const op = raw ? (JSON.parse(raw) as ImportOp) : null;
      return op?.v === 1 ? op : null;
    } catch {
      return null;
    }
  },
  async save(op) {
    if (op) await AsyncStorage.setItem(OP_KEY, JSON.stringify(op));
    else await AsyncStorage.removeItem(OP_KEY);
  },
};

export const settings = {
  async loadBaseUrl() {
    return (await AsyncStorage.getItem(BASE_URL_KEY)) || DEFAULT_BASE_URL;
  },
  async saveBaseUrl(url: string) {
    await AsyncStorage.setItem(BASE_URL_KEY, url);
  },
};

/** App-private staging in the cache dir (not backed up; OS may purge it — handled as "copy missing"). */
function stagingDir() {
  const dir = new Directory(Paths.cache, 'import-staging');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

function probe(uri: string): FileProbe {
  const file = new File(uri);
  return {
    async size() {
      // Metadata only (Android: OpenableColumns.SIZE; iOS: file attributes). 0 is treated as "unknown".
      const s = file.size;
      return typeof s === 'number' && s > 0 ? s : null;
    },
    async open() {
      const handle = file.open(FileMode.ReadOnly);
      return {
        read: (length: number) => handle.readBytes(length),
        close: () => handle.close(),
      };
    },
  };
}

export const expoFileStore: FileStore = {
  probe,
  async stage(sourceUri) {
    const target = new File(stagingDir(), `${Crypto.randomUUID()}.bin`);
    // Native stream copy (works for Android content:// and iOS file URLs); bytes never enter JS.
    await new File(sourceUri).copy(target);
    return target.uri;
  },
  exists(uri) {
    try {
      return new File(uri).exists;
    } catch {
      return false;
    }
  },
  remove(uri) {
    try {
      const f = new File(uri);
      if (f.exists) f.delete();
    } catch {
      // best effort; the startup sweep retries
    }
  },
  sweep(keep) {
    try {
      for (const entry of stagingDir().list()) {
        if (entry instanceof File && entry.uri !== keep) entry.delete();
      }
    } catch {
      // best effort
    }
  },
};

/** Native streamed upload of the raw file bytes (URLSession uploadTask(fromFile:) / OkHttp stream). */
export const expoUploader: Uploader = {
  async upload(url, fileUri, headers, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await new File(fileUri).upload(url, {
        httpMethod: 'POST',
        uploadType: UploadType.BINARY_CONTENT,
        headers,
        signal: controller.signal,
      });
      return { status: res.status, body: res.body };
    } catch (e) {
      if (controller.signal.aborted) {
        const err = new Error('upload timeout');
        err.name = 'TimeoutError';
        throw err;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  },
};

/**
 * System picker. copyToCacheDirectory:false → on Android we get a temporary content:// grant and no copy is made
 * before validation; on iOS the system always hands over a copy inside our sandbox (asCopy), which we delete.
 */
export async function pickStatement(): Promise<PickedFile | null> {
  const res = await DocumentPicker.getDocumentAsync({
    type: ['application/pdf', 'text/csv', 'text/comma-separated-values', 'application/csv'],
    copyToCacheDirectory: false,
    multiple: false,
  });
  if (res.canceled || !res.assets?.[0]) return null;
  const a = res.assets[0];
  return {
    uri: a.uri,
    name: a.name,
    mimeType: a.mimeType ?? null,
    pickerCopy: Platform.OS === 'ios' && a.uri.startsWith('file://'),
  };
}
