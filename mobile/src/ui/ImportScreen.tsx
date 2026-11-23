import { useSyncExternalStore } from 'react';
import { ActivityIndicator, View } from 'react-native';
import type { ImportController, PickedFile } from '../core/controller';
import type { ImportOp, RecurringItem } from '../domain/types';
import { Body, Button, Card, Row, Title, colors } from './kit';
import { errorText, formatBytes, formatMoney, monthlyTotal, rejectionText } from './format';

export function useSnapshot(c: ImportController) {
  return useSyncExternalStore(
    fn => c.subscribe(fn),
    () => c.snapshot,
  );
}

type Props = {
  controller: ImportController;
  pick: () => Promise<PickedFile | null>;
  onDetails: (item: RecurringItem, currency: string) => void;
};

export function ImportScreen({ controller: c, pick, onDetails }: Props) {
  const snap = useSnapshot(c);
  const { op, draft, rejection, busy } = snap;

  const choose = async () => {
    const picked = await pick();
    if (picked) await c.prepare(picked);
  };

  if (!snap.loaded) {
    return (
      <Card>
        <ActivityIndicator />
        <Body>Loading…</Body>
      </Card>
    );
  }

  if (draft) {
    return (
      <Card>
        <Title>Confirm upload</Title>
        <Row label="Name" value={draft.file.name ?? ''} />
        <Row label="Size" value={formatBytes(draft.file.size)} />
        <Row label="Format" value={draft.file.format.toUpperCase()} />
        <Body muted>The file will be sent to the server for analysis.</Body>
        <Button testID="confirm" label="Upload" onPress={() => c.confirm()} busy={busy === 'sending'} />
        <Button testID="cancel" label="Cancel" kind="secondary" onPress={() => c.discardDraft()} disabled={!!busy} />
      </Card>
    );
  }

  const chooser = (label = 'Choose statement (PDF or CSV)') => (
    <>
      {rejection ? (
        <Card tone="danger">
          <Body testID="rejection">{rejectionText[rejection]}</Body>
        </Card>
      ) : null}
      <Button testID="choose" label={label} onPress={choose} busy={busy === 'validating'} />
    </>
  );

  if (!op) {
    return (
      <View style={{ gap: 16 }}>
        <Card>
          <Title>No import yet</Title>
          <Body muted>Choose a bank statement to find recurring payments.</Body>
        </Card>
        {chooser()}
      </View>
    );
  }

  return (
    <View style={{ gap: 16 }}>
      <OpView op={op} c={c} busy={busy} checkedAt={snap.checkedAt} onDetails={onDetails} />
      {c.canStartNew() ? (
        <>
          {chooser('Start a new import')}
          {op.job?.status !== 'deleted' ? null : (
            <Button label="Clear this record" kind="secondary" onPress={() => c.clearLocal()} />
          )}
        </>
      ) : null}
    </View>
  );
}

function OpView({
  op,
  c,
  busy,
  checkedAt,
  onDetails,
}: {
  op: ImportOp;
  c: ImportController;
  busy: string | null;
  checkedAt: number | null;
  onDetails: Props['onDetails'];
}) {
  if (op.send === 'pending' || op.send === 'sending') {
    return (
      <Card>
        <Title>Uploading…</Title>
        <ActivityIndicator />
        <Body muted>{`${op.file.format.toUpperCase()}, ${formatBytes(op.file.size)}`}</Body>
      </Card>
    );
  }

  if (op.send === 'unknown') {
    const missing = !c.hasStagedCopy();
    return (
      <Card tone="warn">
        <Title>Upload result unknown</Title>
        <Body testID="unknown">
          The server may have received the file. We check using the same upload key. Nothing is sent again unless you tap
          "Send again".
        </Body>
        {op.sendError && op.sendError !== 'staged_copy_missing' ? <Body muted>{errorText[op.sendError]}</Body> : null}
        {missing ? <Body muted>{errorText.staged_copy_missing}</Body> : null}
        <Button testID="check" label="Check again" onPress={() => c.checkByKey()} busy={busy === 'checking'} disabled={!!busy} />
        <Button
          testID="resend"
          label="Send again (same file, same key)"
          kind="secondary"
          onPress={() => c.retrySend()}
          disabled={!!busy || missing}
          busy={busy === 'sending'}
        />
        {op.sendError === 'not_found' ? (
          <Button testID="discard" label="Discard this upload" kind="danger" onPress={() => c.discardUnknown()} disabled={!!busy} />
        ) : null}
      </Card>
    );
  }

  if (op.send === 'failed') {
    return (
      <Card tone="danger">
        <Title>Upload failed</Title>
        <Body testID="send-failed">{errorText[op.sendError ?? 'unknown']}</Body>
      </Card>
    );
  }

  const job = op.job!;
  const del = op.del;

  if (job.status === 'deleted') {
    return (
      <Card tone="ok">
        <Title>Deleted on the server</Title>
        <Body testID="deleted">The server confirmed that this import and its report are deleted.</Body>
      </Card>
    );
  }

  const deleting = job.status === 'deleting' || del?.state === 'accepted';
  return (
    <View style={{ gap: 16 }}>
      <Card>
        <Title>{statusTitle(job.status)}</Title>
        <Row label="Status" value={job.status} />
        <Row label="Job" value={job.jobId} />
        {job.status === 'queued' || job.status === 'processing' ? (
          <>
            <ActivityIndicator />
            <Body muted>The file was accepted. The report is not ready yet.</Body>
          </>
        ) : null}
        {op.pollError ? <Body muted>{`${errorText[op.pollError]} Retrying…`}</Body> : null}
      </Card>

      {job.status === 'ready' && job.result ? (
        <Card>
          <Title>Recurring payments</Title>
          {job.result.items.map(item => (
            <View key={item.id} style={{ gap: 6, paddingVertical: 4 }}>
              <Row label={item.merchant} value={`${formatMoney(item.amountMinor, job.result!.currency)} / ${item.cadence}`} />
              <Button testID={`details-${item.id}`} label="Details" kind="secondary" onPress={() => onDetails(item, job.result!.currency)} />
            </View>
          ))}
          <View style={{ borderTopWidth: 1, borderColor: colors.border, paddingTop: 8 }}>
            <Row label="Total" value={`${formatMoney(monthlyTotal(job.result.items), job.result.currency)} / month`} />
          </View>
          <Button testID="refresh" label="Check status" kind="secondary" onPress={() => c.manualRefresh()} busy={busy === 'refreshing'} disabled={!!busy} />
          {checkedAt ? <Body muted testID="checked-at">{`Last checked at ${new Date(checkedAt).toLocaleTimeString()}.`}</Body> : null}
        </Card>
      ) : null}

      {deleting ? (
        <Card tone="warn">
          <Title>Deleting on the server…</Title>
          <ActivityIndicator />
          <Body testID="deleting">Deletion was requested. It is not confirmed yet.</Body>
        </Card>
      ) : (
        <Card tone={del?.state === 'failed' ? 'danger' : undefined}>
          {del?.state === 'failed' ? (
            <Body testID="delete-failed">
              {`Deletion not confirmed. Your data is still on the server. ${errorText[del.error ?? 'unknown']}`}
            </Body>
          ) : null}
          <Button
            testID="delete"
            label={del?.state === 'failed' ? 'Retry deletion' : 'Delete from server'}
            kind="danger"
            onPress={() => c.requestDelete()}
            busy={busy === 'deleting'}
            disabled={!!busy}
          />
        </Card>
      )}
    </View>
  );
}

const statusTitle = (s: string) =>
  ({ queued: 'Queued', processing: 'Processing', ready: 'Report ready', deleting: 'Deleting', deleted: 'Deleted' })[s] ?? s;
