import type { RejectReason } from '../domain/validate';
import type { ErrorCode, RecurringItem } from '../domain/types';

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

export const formatMoney = (minor: number, currency: string) => `${(minor / 100).toFixed(2)} ${currency}`;

export const monthlyTotal = (items: RecurringItem[]) =>
  items.filter(i => i.cadence === 'monthly').reduce((sum, i) => sum + i.amountMinor, 0);

export const rejectionText: Record<RejectReason, string> = {
  too_large: 'This file is larger than 10 MiB. Nothing was uploaded.',
  empty: 'This file is empty. Nothing was uploaded.',
  unrecognized_content:
    'This file is not a valid PDF or statement CSV. It was checked by its content, not its name. Nothing was uploaded.',
  type_mismatch: "The file's content doesn't match its type. Nothing was uploaded.",
  unreadable: "The file couldn't be read. Nothing was uploaded.",
};

export const errorText: Record<ErrorCode, string> = {
  network: "Can't reach the server.",
  timeout: 'The server took too long to respond.',
  key_conflict: 'The server rejected this upload (key already used for another file).',
  too_large: 'The server rejected the file as too large.',
  unsupported_content: 'The server rejected the file content.',
  bad_request: 'The server rejected the request.',
  server_error: 'The server had a temporary problem.',
  not_found: 'The server has no record of this yet.',
  staged_copy_missing: 'The local copy of the file is no longer available.',
  unknown: 'The result is unknown.',
};
