import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { Api, HttpResult } from '../src/api/client';
import { ImportController, type FileStore, type OpStorage } from '../src/core/controller';
import type { ImportOp, ServerJob } from '../src/domain/types';
import { ImportScreen } from '../src/ui/ImportScreen';

const READY: ServerJob = {
  jobId: 'job-demo-001',
  status: 'ready',
  revision: 3,
  result: {
    currency: 'AUD',
    items: [
      { id: 'rec-001', merchant: 'StreamBeam', amountMinor: 1999, cadence: 'monthly', lastSeen: '2026-10-01' },
      { id: 'rec-002', merchant: 'BrightGrid', amountMinor: 13200, cadence: 'monthly', lastSeen: '2026-10-03' },
    ],
  },
};
const ok = (data: ServerJob): HttpResult<ServerJob> => ({ kind: 'ok', status: 200, data });

function setup(initial: ImportOp, api: Partial<Api>) {
  let stored: ImportOp | null = initial;
  const storage: OpStorage = { load: async () => stored, save: async op => void (stored = op) };
  const files: FileStore = { probe: jest.fn(), stage: jest.fn(), exists: () => false, remove: jest.fn(), sweep: jest.fn() };
  const controller = new ImportController({ api: api as Api, storage, files, uuid: () => 'delete-key-0001' });
  return controller;
}

const readyOp: ImportOp = { v: 1, importKey: 'import-key-0001', file: { name: 'statement.csv', size: 99, format: 'csv' }, send: 'acked', job: READY };

test('stale processing/rev2 after ready/rev3 does not roll the UI back', async () => {
  const responses = [ok(READY), ok({ jobId: 'job-demo-001', status: 'processing', revision: 2 })];
  const c = setup(readyOp, { getJob: jest.fn(async () => responses.shift() ?? ok(READY)) });
  await render(<ImportScreen controller={c} pick={async () => null} onDetails={() => {}} />);
  await act(() => c.start());
  expect(screen.getByText('Report ready')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('refresh'));
  await act(() => c.idle());
  expect(screen.getByText('Report ready')).toBeTruthy();
  expect(screen.queryByText('Processing')).toBeNull();
  expect(screen.getByText('StreamBeam')).toBeTruthy();
  expect(screen.getByText('151.99 AUD / month')).toBeTruthy();
  c.dispose();
});

test('"Check status" shows when it last checked, even when the server has nothing newer', async () => {
  const c = setup(readyOp, { getJob: jest.fn(async () => ok(READY)) });
  await render(<ImportScreen controller={c} pick={async () => null} onDetails={() => {}} />);
  await act(() => c.start());
  expect(screen.queryByTestId('checked-at')).toBeNull();
  await fireEvent.press(screen.getByTestId('refresh'));
  await act(() => c.idle());
  expect(screen.getByTestId('checked-at')).toHaveTextContent(/^Last checked at /);
  expect(screen.getByText('Report ready')).toBeTruthy();
  c.dispose();
});

test('"Check status" shows the error, not a check time, when the server is unreachable', async () => {
  const getJob = jest.fn(async (): Promise<HttpResult<ServerJob>> => ({ kind: 'network' }));
  const c = setup(readyOp, { getJob });
  await render(<ImportScreen controller={c} pick={async () => null} onDetails={() => {}} />);
  await act(() => c.start());
  await fireEvent.press(screen.getByTestId('refresh'));
  await act(() => c.idle());
  expect(screen.queryByTestId('checked-at')).toBeNull();
  expect(screen.getByText(/Can't reach the server/)).toBeTruthy();
  c.dispose();
});

test('503 on delete never shows "deleted"; the data is reported as still on the server', async () => {
  const deleteJob = jest.fn(async (): Promise<HttpResult<ServerJob>> => ({ kind: 'http', status: 503 }));
  const c = setup(readyOp, { getJob: jest.fn(async () => ok(READY)), deleteJob });
  await render(<ImportScreen controller={c} pick={async () => null} onDetails={() => {}} />);
  await act(() => c.start());
  await fireEvent.press(screen.getByTestId('delete'));
  await act(() => c.idle());
  expect(screen.getByTestId('delete-failed')).toHaveTextContent(/still on the server/);
  expect(screen.queryByTestId('deleted')).toBeNull();
  expect(screen.getByText('Retry deletion')).toBeTruthy();
  // 202 deleting is "not confirmed yet", not deleted.
  deleteJob.mockResolvedValueOnce(ok({ jobId: 'job-demo-001', status: 'deleting', revision: 4 }));
  await fireEvent.press(screen.getByTestId('delete'));
  await act(() => c.idle());
  expect(screen.getByTestId('deleting')).toHaveTextContent(/not confirmed yet/);
  expect(screen.queryByTestId('deleted')).toBeNull();
  expect(deleteJob.mock.calls.map(call => (call as unknown[])[1])).toEqual(['delete-key-0001', 'delete-key-0001']);
  c.dispose();
});

test('unknown POST outcome offers an explicit resend, never resends by itself', async () => {
  const createImport = jest.fn();
  const getByKey = jest.fn(async (): Promise<HttpResult<ServerJob>> => ({ kind: 'http', status: 404 }));
  const c = setup({ ...readyOp, send: 'sending', job: undefined, stagedUri: 'file:///staged.bin' }, { createImport, getByKey });
  await render(<ImportScreen controller={c} pick={async () => null} onDetails={() => {}} />);
  await act(() => c.start());
  expect(screen.getByText('Upload result unknown')).toBeTruthy();
  expect(screen.getByTestId('resend')).toBeTruthy();
  expect(getByKey).toHaveBeenCalledWith('import-key-0001');
  expect(createImport).not.toHaveBeenCalled();
  c.dispose();
});
