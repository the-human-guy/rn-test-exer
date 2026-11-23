# Statement import — React Native client + candidate kit

A small React Native + TypeScript (Expo development build) client for the test assignment in `docs/mobile-engineer-test-task.pdf`. It picks a synthetic statement, validates it locally, sends the raw bytes to the kit's mock over HTTP, tracks the async job, recovers a lost response and relaunch, and deletes the import safely.

```
kit/      the candidate kit, contents unchanged (mock server, fixtures, its own tests)
mobile/   the RN client and its tests
docs/     task PDF, plan + decisions, release note, self-review, test results
```

## Requirements

- Node.js 20+ (tested with 22), npm.
- iOS: macOS with Xcode 27.2 (tested; builds for the iOS 26.2 simulator) and an iOS Simulator. Xcode 26.2 (Swift 6.2.3) fails to compile Expo SDK 58's `expo-modules-jsi` ("sending 'slot' risks causing data races"). Android: Android Studio SDK and an emulator, `adb` on PATH.
- No accounts, keys or internet access are needed at runtime.

## Clean checkout → run

Terminal 1, the mock (no install needed):

```bash
cd kit && npm run fixtures:oversize && npm start
```

Terminal 2, the client:

```bash
cd mobile && npm ci
```

```bash
npx expo run:ios
```

```bash
adb reverse tcp:8787 tcp:8787 && npx expo run:android
```

`expo run:*` generates the native projects (CNG, not committed), builds a **native debug build**, installs it and starts Metro. This is not Expo Go and not web.

The default server address is `http://127.0.0.1:8787`. The iOS Simulator reaches the host loopback directly; the Android emulator reaches it through `adb reverse`. On a physical device, start the mock with `HOST=<your LAN IP>` and set that address in **Diagnostics → Server address**. Don't expose the mock to the internet.

### Putting the fixtures on the device

- Android: `adb push kit/fixtures/. /sdcard/Download/`, then pick them from Downloads.
- iOS Simulator (booted): copy them into the Files app's local storage, then pick them from Files → "On My iPhone":
  ```bash
  G=$(xcrun simctl get_app_container booted com.apple.DocumentsApp groups | awk '/LocalStorage/{print $2}')
  mkdir -p "$G/File Provider Storage" && cp kit/fixtures/* "$G/File Provider Storage/"
  ```

## Tests

```bash
cd mobile && npm test
```

- `test/acceptance.node.test.ts` runs the acceptance matrix against the **real, unmodified kit mock** over HTTP. It starts the mock in a child process with an isolated temp state file and a random port, and resets it before every test, so counters are reproducible. It generates `oversize.csv` with the kit's own command if it's missing.
- `test/domain.node.test.ts`: validation (content sniffing, the 10 MiB limit without reading the file, bounded counting), the revision gate, and the logger sanitizer.
- `test/screen.ui.test.tsx`: the UI doesn't roll back on a stale status, never shows "deleted" on a 503 or while still `deleting`, and offers an explicit resend for an unknown POST outcome.

Latest output: `docs/test-results.txt`. The kit's own tests: `cd kit && npm test`.

| PDF requirement | Test |
|---|---|
| Key persisted before the POST, reused after relaunch | `persisted key: …` |
| One job under `lost_ack` (`newJobs=1`) | `lost_ack: …` (×2) |
| Stale revision ignored | `stale_status: …` + UI test |
| Failed delete, then a retry with the same key reaches `deleted` | `delete_failure: …` + UI test |
| `spoofed.pdf` + `oversize.csv` rejected before the POST (`createRequests` unchanged) | `spoofed.pdf and oversize.csv …` |
| Late response doesn't resurrect a deleted job | `late response …` |
| No file name / bytes / descriptions in logs | `logs never contain …` |
| Double tap on Upload → one POST, one job | `double-tap on Upload …` |
| Unknown outcome: no new import; discard re-checks by key | `unknown outcome: …` (×2) |

## Manual acceptance run (for the video)

Use **Diagnostics** (top right, test-only) to switch scenarios and watch the mock counters. There's no code change between runs.

1. **happy**: Reset mock → choose `statement.csv` → the confirm screen shows name, size and format → Upload → Queued/Processing (no report yet) → Report ready: StreamBeam 19.99, BrightGrid 132.00, **Total 151.99 AUD / month** → Details opens the card. Repeat with `statement.pdf`.
2. **lost_ack + relaunch**: scenario `lost_ack` → upload → the response is lost → "Upload result unknown" → the app checks by key and finds the job. Also kill the app during or after the upload and relaunch: it shows the job **without** resending. Counters: `newJobs = 1`.
3. **stale_status**: with a ready report, switch to `stale_status` → tap **Check status** several times → it stays "Report ready" (the stale processing/rev2 is ignored).
4. **delete_failure**: switch to `delete_failure` → Delete from server → "Deletion not confirmed. Your data is still on the server." → switch to `happy` → Retry deletion (same key) → "Deleting on the server…" → "Deleted on the server".
5. **spoofed + oversize**: note `createRequests` → pick `spoofed.pdf` (rejected: content isn't a PDF) and `oversize.csv` (rejected: > 10 MiB) → `createRequests` is unchanged.

## Platform results

| Platform | Device / OS | Picker | Full import | Scenarios | Result |
|---|---|---|---|---|---|
| iOS | iPhone 17 Simulator, iOS 26.2 (Xcode 27.2) | Files, "On My iPhone" | CSV, upload, report, details, check status, delete | happy, lost_ack + relaunch, stale_status, delete_failure, spoofed/oversize | **PASS** (see note) |
| Android | Medium Phone emulator, Android 16 / API 36 | Downloads | CSV, upload, report, details, check status, delete | happy, lost_ack + relaunch, stale_status, delete_failure, spoofed/oversize | **PASS** |

Both platforms were run by hand from the steps above, on a debug dev build on macOS, and recorded on video. Unit and integration tests are 29/29 against the real mock.

- Android counters at the end of the run: `createRequests 2, newJobs 2, duplicateHits 0, acceptedBytes 224, deleteRequests 3`. These are the expected numbers.
- iOS note: the counters showed `duplicateHits 2`. Every duplicate request reused an existing key, the server returned the existing job, and `acceptedBytes` matched `newJobs` (no job and no data were created twice). The app has no automatic resend. The likely cause is iOS (URLSession) retrying the POST itself after the mock drops the connection in `lost_ack`. This has not been confirmed (see `docs/self-review.md`).

## Docs

- `docs/plan.md`: plan and **decisions with rationale** (§11)
- `docs/release-note.md`: permissions, file copies, data clearing, rollout stop signals, OTA vs binary
- `docs/self-review.md`: decisions, simplifications, production risks, AI usage
