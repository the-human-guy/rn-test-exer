import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { createApi } from './src/api/client';
import { ImportController } from './src/core/controller';
import type { RecurringItem } from './src/domain/types';
import { DEFAULT_BASE_URL, asyncOpStorage, expoFileStore, expoUploader, pickStatement, settings, uuid } from './src/platform/expo';
import { DetailsScreen } from './src/ui/DetailsScreen';
import { DiagnosticsScreen } from './src/ui/DiagnosticsScreen';
import { ImportScreen } from './src/ui/ImportScreen';
import { colors, s } from './src/ui/kit';

type Route = { name: 'main' } | { name: 'diagnostics' } | { name: 'details'; item: RecurringItem; currency: string };

export default function App() {
  const baseUrlRef = useRef(DEFAULT_BASE_URL);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [route, setRoute] = useState<Route>({ name: 'main' });

  const { api, controller } = useMemo(() => {
    const api = createApi({ baseUrl: () => baseUrlRef.current, uploader: expoUploader });
    const controller = new ImportController({ api, storage: asyncOpStorage, files: expoFileStore, uuid });
    return { api, controller };
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      baseUrlRef.current = await settings.loadBaseUrl();
      if (alive) setBaseUrl(baseUrlRef.current);
      await controller.start();
    })();
    const sub = AppState.addEventListener('change', state => (state === 'active' ? controller.resume() : controller.pause()));
    return () => {
      alive = false;
      sub.remove();
      controller.dispose();
    };
  }, [controller]);

  const saveBaseUrl = (url: string) => {
    baseUrlRef.current = url || DEFAULT_BASE_URL;
    setBaseUrl(baseUrlRef.current);
    void settings.saveBaseUrl(baseUrlRef.current);
  };

  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <StatusBar style="dark" />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 8, gap: 8 }}>
          <Text style={[s.title, { flexShrink: 1 }]} accessibilityRole="header">
            Statement import
          </Text>
          {route.name === 'main' ? (
            <Pressable
              testID="open-diagnostics"
              accessibilityRole="button"
              onPress={() => setRoute({ name: 'diagnostics' })}
              style={{ minHeight: 44, justifyContent: 'center' }}
            >
              <Text style={[s.body, { color: colors.primary }]}>Diagnostics</Text>
            </Pressable>
          ) : null}
        </View>
        <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }} keyboardShouldPersistTaps="handled">
          {route.name === 'main' ? (
            <ImportScreen controller={controller} pick={pickStatement} onDetails={(item, currency) => setRoute({ name: 'details', item, currency })} />
          ) : route.name === 'details' ? (
            <DetailsScreen item={route.item} currency={route.currency} onBack={() => setRoute({ name: 'main' })} />
          ) : (
            <DiagnosticsScreen api={api} controller={controller} baseUrl={baseUrl} onSaveBaseUrl={saveBaseUrl} onBack={() => setRoute({ name: 'main' })} />
          )}
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
