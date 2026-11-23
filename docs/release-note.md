# Release note: statement import fragment

**Permissions actually needed**
- Android: `INTERNET` only (plus `<package>.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`, a signature-level permission AndroidX declares for the app's own receivers; no user prompt). The picker is the system document UI (SAF, `ACTION_OPEN_DOCUMENT`) and needs no storage permission. `READ/WRITE_EXTERNAL_STORAGE` (declared by `expo-file-system`), `SYSTEM_ALERT_WINDOW` and `VIBRATE` are removed from the main manifest (`android.blockedPermissions`). The **debug** build additionally requests `SYSTEM_ALERT_WINDOW` (dev menu overlay) and `ACCESS_LOCAL_NETWORK` (Metro), both from React Native's debug-only manifests; they aren't in a release build. Cleartext HTTP is allowed only in the debug build, for the local mock. A release build talking to a real backend must use HTTPS.
- iOS: no runtime permission. ATS keeps `NSAllowsArbitraryLoads=false` and `NSAllowsLocalNetworking=true` (local mock only). `NSLocalNetworkUsageDescription` is set for the physical-device LAN case; iOS prompts only when a LAN host is used.

**Where file copies exist**
- Android: no copy before validation. The app reads the temporary `content://` grant (size from metadata, first 64 bytes for content sniffing).
- iOS: the system picker always hands over a copy inside the app sandbox (tmp/Inbox). The app deletes it right after staging or rejection.
- Staging: one private copy in `Caches/import-staging/` (not backed up). It is deleted as soon as the server confirms the job (202 or found by key), on rejection or cancel, and at startup for any orphan.
- No bytes are kept anywhere else. Persisted state (AsyncStorage) has the idempotency key, delete key, job id, status, revision, format, size, display name and, while ready, the two report items.

**How to clear data**
- In the app: delete the import, which is confirmed only after `status=deleted`, then "Clear this record". Diagnostics has "Clear local state" (forced).
- OS level: uninstall, or Android "Clear storage". This removes AsyncStorage and the cache.
- Server side (mock): `POST /__test/reset`.

**Rollout stop signals** (counts only; no file names or content)
- More than one job per idempotency key (server-side duplicate rate). This is a stop factor.
- A rising share of imports stuck in "unknown outcome" or in by-key 404 after a lost response.
- Any "deleted" shown without a server `deleted` status (client assertion), or a rising delete-not-confirmed rate.
- 409 key-reuse errors (a key-generation or persistence bug), and crash-free sessions dropping on the picker or upload path.

**JS/OTA vs new native binary**
- OTA (JS only): UI and copy, the state machine, validation rules, polling and backoff, logging allowlist, error texts.
- Needs a new binary: adding or upgrading native modules (`expo-file-system`, `expo-document-picker`, AsyncStorage, `expo-crypto`), an Expo SDK or RN upgrade, permission, ATS or cleartext changes, `NSLocalNetworkUsageDescription`, bundle ID or app config changes, and the upload transport (native streaming lives in `expo-file-system`).
