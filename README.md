# Statement import — React Native client + candidate kit

A small React Native + TypeScript (Expo development build) client for the test assignment in `docs/mobile-engineer-test-task.pdf`. It picks a synthetic statement, validates it locally, sends the raw bytes to the kit's mock over HTTP, tracks the async job, recovers a lost response and relaunch, and deletes the import safely.

```
kit/      the candidate kit, contents unchanged (mock server, fixtures, its own tests)
mobile/   the RN client and its tests
docs/     task PDF, plan + decisions, release note, self-review, test results
```

## Requirements

- Node.js 20+ (tested with 22), npm.
- iOS: macOS with Xcode and an iOS Simulator. Android: Android Studio SDK and an emulator, `adb` on PATH.
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
- iOS Simulator: drag the files from `kit/fixtures/` onto the Simulator window and save them into Files ("On My iPhone").

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
| iOS | _TBD (Simulator, iOS version)_ | _not yet verified_ | _not yet verified_ | _not yet verified_ | **UNVERIFIED** |
| Android | _TBD (Emulator, API level)_ | _not yet verified_ | _not yet verified_ | _not yet verified_ | **UNVERIFIED** |

Verified so far, in a Linux container: unit and integration tests (22/22) against the real mock, TypeScript typecheck, Metro bundles for iOS and Android, and `expo prebuild` config (permissions, ATS, cleartext). No native run has been done yet. A platform stays **UNVERIFIED** until it has actually been run.

## Docs

- `docs/plan.md`: plan and **decisions with rationale** (§11)
- `docs/release-note.md`: permissions, file copies, data clearing, rollout stop signals, OTA vs binary
- `docs/self-review.md`: decisions, simplifications, production risks, AI usage
