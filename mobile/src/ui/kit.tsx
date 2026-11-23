import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

export const colors = {
  bg: '#F6F7F9',
  card: '#FFFFFF',
  text: '#14171A',
  muted: '#55606B',
  primary: '#1F5EFF',
  danger: '#B42318',
  dangerBg: '#FEF3F2',
  warnBg: '#FFF7E6',
  okBg: '#ECFDF3',
  ok: '#067647',
  border: '#D8DDE3',
};

export function Card({ children, tone }: { children: ReactNode; tone?: 'danger' | 'warn' | 'ok' }) {
  const bg = tone === 'danger' ? colors.dangerBg : tone === 'warn' ? colors.warnBg : tone === 'ok' ? colors.okBg : colors.card;
  return <View style={[s.card, { backgroundColor: bg }]}>{children}</View>;
}

export function Title({ children }: { children: ReactNode }) {
  return (
    <Text style={s.title} accessibilityRole="header">
      {children}
    </Text>
  );
}

export function Body({ children, muted, testID }: { children: ReactNode; muted?: boolean; testID?: string }) {
  return (
    <Text testID={testID} style={[s.body, muted && { color: colors.muted }]}>
      {children}
    </Text>
  );
}

export function Button({
  label,
  onPress,
  kind = 'primary',
  disabled,
  busy,
  testID,
}: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  busy?: boolean;
  testID?: string;
}) {
  const fg = kind === 'primary' ? '#fff' : kind === 'danger' ? colors.danger : colors.primary;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled || !!busy, busy: !!busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        kind === 'primary' ? { backgroundColor: colors.primary } : { borderColor: fg, borderWidth: 1 },
        (disabled || busy) && { opacity: 0.5 },
        pressed && { opacity: 0.7 },
      ]}
    >
      {busy ? <ActivityIndicator color={fg} style={{ marginRight: 8 }} /> : null}
      <Text style={[s.buttonText, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

export function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.row}>
      <Text style={[s.body, { color: colors.muted }]}>{label}</Text>
      <Text style={[s.body, s.rowValue]}>{value}</Text>
    </View>
  );
}

export const s = StyleSheet.create({
  card: { borderRadius: 12, padding: 16, gap: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  title: { fontSize: 20, fontWeight: '700', color: colors.text },
  body: { fontSize: 16, color: colors.text, lineHeight: 22 },
  button: {
    minHeight: 48,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  buttonText: { fontSize: 16, fontWeight: '600', textAlign: 'center', flexShrink: 1 },
  row: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', columnGap: 12 },
  rowValue: { fontWeight: '600', flexShrink: 1, textAlign: 'right' },
});
