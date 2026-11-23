import { useCallback, useEffect, useState } from 'react';
import { TextInput, View } from 'react-native';
import type { Api, MockStats, Scenario } from '../api/client';
import type { ImportController } from '../core/controller';
import { Body, Button, Card, Row, Title, colors, s } from './kit';
import { useSnapshot } from './ImportScreen';

const SCENARIOS: Scenario[] = ['happy', 'lost_ack', 'stale_status', 'delete_failure'];

/** Test-only screen: drives the kit mock's test-control routes. Not production architecture. */
export function DiagnosticsScreen({
  api,
  controller,
  baseUrl,
  onSaveBaseUrl,
  onBack,
}: {
  api: Api;
  controller: ImportController;
  baseUrl: string;
  onSaveBaseUrl: (url: string) => void;
  onBack: () => void;
}) {
  const snap = useSnapshot(controller);
  const [url, setUrl] = useState(baseUrl);
  const [mode, setMode] = useState<Scenario | null>(null);
  const [stats, setStats] = useState<MockStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api.test.state();
    if (r.kind === 'ok') {
      setMode(r.data.mode);
      setStats(r.data.stats);
      setError(null);
    } else setError(`Mock unreachable (${r.kind === 'http' ? r.status : r.kind})`);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const op = snap.op;
  return (
    <View style={{ gap: 16 }}>
      <Card tone="warn">
        <Title>Diagnostics (test-only)</Title>
        <Body muted>Controls the local mock server for the review scenarios.</Body>
      </Card>

      <Card>
        <Title>Server address</Title>
        <TextInput
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          accessibilityLabel="Mock server base URL"
          style={[s.body, { borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 10 }]}
        />
        <Button label="Save address" kind="secondary" onPress={() => { onSaveBaseUrl(url.trim()); void load(); }} />
      </Card>

      <Card>
        <Title>Scenario</Title>
        {error ? <Body testID="diag-error">{error}</Body> : null}
        {SCENARIOS.map(m => (
          <Button
            key={m}
            testID={`scenario-${m}`}
            label={m === mode ? `✓ ${m}` : m}
            kind={m === mode ? 'primary' : 'secondary'}
            onPress={async () => {
              await api.test.setScenario(m);
              await load();
            }}
          />
        ))}
      </Card>

      <Card>
        <Title>Mock counters</Title>
        {stats ? (
          Object.entries(stats).map(([k, v]) => <Row key={k} label={k} value={String(v)} />)
        ) : (
          <Body muted>—</Body>
        )}
        <Button label="Refresh counters" kind="secondary" onPress={load} />
        <Button
          label="Reset mock (destructive, test data only)"
          kind="danger"
          onPress={async () => {
            await api.test.reset();
            await load();
          }}
        />
      </Card>

      <Card>
        <Title>Local operation</Title>
        {op ? (
          <>
            <Row label="send" value={op.send} />
            <Row label="key" value={`${op.importKey.slice(0, 8)}…`} />
            <Row label="job" value={op.job ? `${op.job.jobId} ${op.job.status} r${op.job.revision}` : '—'} />
            <Row label="delete" value={op.del ? op.del.state : '—'} />
            <Row label="local copy" value={op.stagedUri ? 'present' : 'none'} />
          </>
        ) : (
          <Body muted>None</Body>
        )}
        <Button label="Clear local state" kind="danger" onPress={() => controller.clearLocal(true)} />
      </Card>

      <Button testID="diag-back" label="Back" kind="secondary" onPress={onBack} />
    </View>
  );
}
