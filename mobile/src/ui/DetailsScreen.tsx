import type { RecurringItem } from '../domain/types';
import { formatMoney } from './format';
import { Body, Button, Card, Row, Title } from './kit';

export function DetailsScreen({ item, currency, onBack }: { item: RecurringItem; currency: string; onBack: () => void }) {
  return (
    <Card>
      <Title>{item.merchant}</Title>
      <Row label="Amount" value={formatMoney(item.amountMinor, currency)} />
      <Row label="Frequency" value={item.cadence} />
      <Row label="Last seen" value={item.lastSeen} />
      <Body muted>A recurring payment found by the server in your statement.</Body>
      <Button testID="back" label="Back" kind="secondary" onPress={onBack} />
    </Card>
  );
}
