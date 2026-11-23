# Plan — Mobile Engineer test task: bank statement import without losing state

Source: `docs/mobile-engineer-test-task.pdf` (RU) + kit `README.md` + `mock-server.mjs` (read in full).
Budget: ~8h of work within 4 calendar days. Base scenario > polish. If time runs out, ship the working part and list unverified platforms and the remaining risks.

Decisions: §11. Status: §12.

---

## 1. Hard constraints (from PDF/kit)

- Stack: React Native + TypeScript. Expo **development build** is allowed. Graded on a **native** run, not web, not Expo Go.
- **Do not modify** the server or the fixtures. Add code only to the mobile client and its tests. Don't change sources between scenario runs.
- Requests go over real HTTP to the kit's mock, not through a stubbed call in the UI.
- Not needed: a real PDF parser, AI, bank integrations, auth, payments, store publishing, own cloud services, a public URL, external APIs, passwords. **Don't publish to the stores.** Don't add store credentials or other people's work materials to the repo.
- No raw bytes, file name, or transaction descriptions in analytics or crash logs.
- **Stop factors** (instant fail regardless of UI): a critical document or secret leak; **a second job after a resend**; **a false "deleted" confirmation**.

## 2. Mock facts that drive the design (from `mock-server.mjs`)

| Item | Behavior |
|---|---|
| `POST /imports` | Headers `Idempotency-Key` (8–128 chars) and `X-File-Name` (1–255), raw body. `createRequests++` **before** the body is read. Limit 10 MiB → 413. Bytes sniff: PDF = starts with `%PDF-`; CSV = starts with `date,description,amount\n` (CR stripped) → otherwise 415. Same key + same sha256 → 202 same job (`duplicateHits++`). Same key + other bytes → 409. |
| `lost_ack` | Job is committed (`newJobs++`), then the socket is destroyed → client sees a network error. |
| `GET /imports/by-key/{key}` | Always computed in `happy` mode. 404 = not found *yet*. |
| `GET /imports/{jobId}` | queued (<250ms, rev1) → processing (<1s, rev2) → ready (rev3, items). `stale_status`: 1st GET after the scenario switch → ready r3, 2nd → processing r2, then ready again. |
| `DELETE /imports/{jobId}` | Requires `Idempotency-Key`. `deleteRequests++`. `delete_failure` → 503, nothing committed. Key reused for another job → 409. 202 → `deleting` r4; `deleted` r5 after ≥1s on GET. |
| Ready payload | AUD; rec-001 StreamBeam 1999 monthly 2026-10-01; rec-002 BrightGrid 13200 monthly 2026-10-03 → total **151.99 AUD/mo**. |
| Test routes | `POST /__test/reset`, `POST /__test/scenario {mode}`, `GET /__test/state` (mode, stats, jobs). |
| Network | Binds `127.0.0.1:8787` (`HOST`/`PORT` env). Android emulator: `adb reverse tcp:8787 tcp:8787`. iOS simulator: direct loopback. Physical device: an explicitly chosen LAN host, never exposed to the internet. |
| Persistence | `.mock-state.json` survives mock restarts. |

Note: the server never returns `status: "error"`. "error" in the UI = client-side or transport failure (network, 409, 413, 415, 5xx, timeout).

## 3. Stack (decided: Expo dev build, AsyncStorage)

- Expo SDK 58 (RN 0.88) + dev build via `expo run:ios|android`. CNG, no committed `ios/`/`android/` folders.
- Picker: `expo-document-picker`. Files: `expo-file-system` (new `File`/`Directory` API: size, partial read through a file handle). Upload streamed from disk natively with `File.upload` (BINARY_CONTENT); the file is never loaded into JS memory.
- Persisted operation state: `@react-native-async-storage/async-storage`. Every write is **awaited** before the next network step (POST/DELETE). The promise resolves after the native write completes. Dependency rule: only Expo SDK modules + well-known community packages, minimal count.
- Domain logic: a plain TS reducer/state machine + an API client. No XState or Redux; small scope.
- Tests: Jest. Domain + API client integration tests run in a Node env against the **real kit server**, started in a child process via the kit's `createMockServer({statePath: tmp})` on a random port, with no edits to the kit. Component tests: React Native Testing Library. No E2E automation.

## 4. Repo layout (decided)

```
/kit         kit, contents byte-identical (mock-server.mjs, fixtures/, package.json, README.md, .gitignore)
/mobile      RN client (own package.json, tests)
/README.md   ours: clean checkout, run, test, per-platform results
/docs        plan.md, task PDF, release-note.md, self-review.md
```

## 5. Client architecture

### 5.1 Persisted operation record (one active import; `mobile/src/domain/types.ts`)
```
ImportOp {
  v: 1
  importKey: string            // UUID v4, created at "Confirm" and persisted BEFORE the first POST
  file: { name?, size, format } // name stays in local private storage only, never logged; dropped once status=deleted
  stagedUri?: string           // app-private copy, present only while a (re)send may be needed
  send: 'pending' | 'sending' | 'unknown' | 'acked' | 'failed'
  sendError?: ErrorCode        // codes, no PII
  job?: { jobId, status, revision, result? }   // last accepted server view; result only while ready
  del?: { key, state: 'requesting' | 'failed' | 'accepted', error? }  // key persisted BEFORE the first DELETE
  pollError?: ErrorCode
}
```
Transfer state (`send`) and deletion state (`del`) are separate fields; the job status comes only from the server.

### 5.2 Flows
1. **Pick** → system picker (PDF/CSV filter is a hint only).
2. **Validate locally, before any POST** (no reliance on the extension or MIME):
   - Size from file metadata (picker size, then a stat of the copy). Reject > 10 MiB (10 × 1024 × 1024) **without reading the file**. Android: no copy before validation (`copyToCacheDirectory:false`, `content://` read in place). iOS: the system always hands over a sandbox copy (`asCopy`); it is deleted immediately on rejection.
   - Read only the first N bytes (~64) through a file handle → detect the format: `%PDF-` → pdf; `date,description,amount` header → csv; otherwise reject ("not a valid PDF/CSV"). The detected format must match the declared type (extension/MIME), otherwise reject.
3. **Confirm screen**: name, human-readable size, detected format. Cancel → delete the temp copy and clear the op.
4. **Confirm** → mark busy synchronously (a double tap can't mint a second key) → generate `importKey`, persist the op (`pending`) → `sending` → POST (streamed bytes, headers).
   - 202 → store the job, `acked`, **delete the local copy**.
   - Network error / timeout / 5xx (lost_ack) → `unknown`. Show "Upload result unknown" → GET by-key. 200 → adopt the job. 404 → offer a **user-initiated** "Send again" (same key, same bytes from the kept copy; disabled if the copy is gone). Never automatic after relaunch.
   - While `unknown`, no new import can start. "Discard this upload" re-checks by key first: a job that turned up is adopted; only a fresh 404 clears the record and the copy.
   - 409/413/415/4xx → `failed` with a readable message, delete the copy.
5. **Tracking**: poll `GET /imports/{jobId}` (~500ms, backoff, paused in background, resumed via AppState). **Monotonic revision gate**: apply a response only if `revision > lastRevision`. The stale r2 after ready r3 is ignored. Stop polling at `ready`.
6. **Ready**: list of 2 items + total "151.99 AUD / month". "Подробнее" (details) → detail card (merchant, amount, cadence, lastSeen). No subscription cancellation.
7. **Delete**: generate and persist `deleteKey` → `deleting`, DELETE.
   - 503/network → stay on "Deletion not confirmed. Data still on server", Retry (same deleteKey).
   - 202 → "Deleting on server…" and poll GET until `status=deleted` (r5). Only then "Deleted on server".
   - **No resurrection**: after `deleting`/`deleted`, any late response with a lower revision or non-delete status is dropped (revision gate + a terminal phase guard). In-flight polls are aborted (AbortController) and responses tagged with an op generation id.
8. **Relaunch** (normal app restart): load the op → `pending`/`sending`/`unknown` → `unknown` + GET by-key (no POST) → same as 4; `acked` → one GET, resume polling if not final; DELETE in flight at kill (`del.state=requesting`) → shown as "not confirmed", one GET decides (a `deleting`/`deleted` view marks it accepted); a retry re-sends DELETE with the same key.
9. **Cleanup**: the local copy is deleted on: 202/job found, failure, cancel, discard. The file name is dropped once the server returns `deleted`. Startup sweep: delete any files in the private import dir not referenced by the persisted op. Copy dir = app-private (iOS: excluded from backup).

### 5.3 Privacy
- A single `log()` wrapper with an allowlist of fields (codes, jobId, status, revision, sizes). No file name, bytes, or descriptions. No analytics or crash SDK added. State this in the release note.
- `X-File-Name` is sent because the contract requires it. That is the only place it leaves the device.
- Unit test: the logger is given an op with a file name → the output contains no name.

### 5.4 Base URL / diagnostics
- Base URL from config (default `http://127.0.0.1:8787`), overridable in the Diagnostics screen for a physical-device LAN host, persisted.
- Diagnostics screen: scenario switch (happy/lost_ack/stale_status/delete_failure), reset, live `GET /__test/state` counters (createRequests, newJobs, duplicateHits, deleteRequests), current op dump (no PII). Dev-only gating.

### 5.5 UI requirements
- States: empty (no import), validating, confirm, sending, unknown outcome, queued, processing, ready, error (with action), deleting, delete-failed, deleted.
- No state claims more than the server confirmed: 202 is never shown as a "report".
- Small screen (iPhone SE / ~360dp Android) + largest system font (iOS AX sizes, Android font scale 2.0): ScrollView layouts, no fixed heights, buttons wrap, `allowFontScaling` left on. Manual check + screenshots.
- Accessibility labels on primary actions.

## 6. Tests (reproducible; each test resets the mock)

Required by the PDF:
1. **Persisted key**: the key exists in storage before the POST is issued (storage spy/order assertion). Relaunch (re-init the store from storage) reuses the same key; no POST on relaunch.
2. **One job under lost_ack**: scenario `lost_ack` → send → network error → recovery via by-key/retry → `/__test/state.stats.newJobs === 1`.
3. **Stale revision**: `stale_status` → reducer/poller receives ready r3 then processing r2 → state stays ready r3. Plus a component test that the UI still shows ready.
4. **Failed delete**: `delete_failure` → 503 → state ≠ deleted, UI text ≠ "deleted" → switch to happy → retry with the **same** deleteKey → eventually `deleted`.
5. **Local rejection of the two bad files**: `spoofed.pdf` and `oversize.csv` (generated via `npm run fixtures:oversize`) → rejected; `createRequests` unchanged before vs after.

Extra: happy path csv + pdf end-to-end against the mock (bytes = `acceptedBytes`); late response after delete doesn't resurrect; logger redaction; double-tap on Upload → one POST; discard of an unknown outcome re-checks by key; CSV sniff window matches the server (CRLF header rejected); file name dropped after `deleted`.
Command: `cd mobile && npm test`. The acceptance suite generates `oversize.csv` with the kit's own `make-oversize.mjs` in `beforeAll` if it's missing. Output saved to `docs/test-results.txt`.

The validator must run against fixture files in Node and on device → abstract file access behind an interface (`FileSource` with `size()`, `readHead(n)`), implemented with expo-file-system in the app and `fs` in tests.

## 7. Native verification (macOS, iOS Simulator + Android emulator)

- iOS and Android: file picking + the full acceptance flow on **each**, debug dev build. OS/device versions recorded in the README.
- Getting fixtures onto the device: iOS Simulator: copy into the Files app's local storage (`simctl get_app_container booted com.apple.DocumentsApp groups`, see README); Android: `adb push kit/fixtures/. /sdcard/Download/`.
- A platform that wasn't run is marked **unverified** everywhere. No web build as a substitute.

## 8. Deliverables

- [x] Client repo + unchanged kit.
- [x] README: exact clean-checkout steps, commands to start the mock and the client, test command, devices/OS versions, **actual result per platform** (iOS and Android separately, unverified marked as such).
- [x] `docs/release-note.md` (short): permissions actually needed (expected: none at runtime; the picker uses the system UI, plus Android cleartext HTTP to localhost/LAN, iOS ATS exception for local networking); where file copies live and when they're removed; how to clear data; rollout-stop signal (e.g. spike in `unknown`-outcome or duplicate-job rate, delete-not-confirmed rate); what needs a **new native binary** vs JS/OTA (native modules, ATS/cleartext config, permissions, SDK bump → binary; UI/logic → OTA).
- [x] `docs/self-review.md` (≤1 page): 2–3 key decisions, what was simplified for the deadline, what breaks first in production and how we'd notice, **AI usage: what was generated and what was verified by hand**.
- [x] Test results (`docs/test-results.txt`).
- [x] Short video, recorded by hand: iOS, Android, happy, lost_ack + relaunch, stale_status, delete_failure. Unverified parts shown honestly.

## 9. Grading map (from PDF)

| Block | Weight | Covered by |
|---|---|---|
| Transfer & state | 30 | §5.2 steps 4–8, tests 1–4 |
| Both native platforms | 20 | §7, §5.2 steps 1–2, 9 |
| Privacy | 20 | §5.2 steps 2 and 9, §5.3 |
| Tests & diagnostics | 15 | §6, §5.4 |
| UI | 10 | §5.5 |
| Release note | 5 | §8 |

Each block is scored 0–4 (4 = all base scenarios + failure cases, tests, explained trade-offs). Points = weight × level / 4. The reviewer runs everything from a clean checkout and cross-checks the mock counters vs the UI vs the tests. Nothing extra may be needed for acceptance.

## 10. Phases (≈8h)

1. Scaffold Expo + TS + dev build on both platforms, mock reachable (1h).
2. Domain: op model, reducer, revision gate, storage, API client + integration tests against the mock (2h).
3. File layer: picker, private copy, size/sniff validation, streamed upload, cleanup + tests 5 (1.5h).
4. UI screens + Diagnostics (1.5h).
5. Relaunch/recovery, delete flow, edge tests (1h).
6. Native verification, large-font/small-screen pass, README, release note, self-review (1h).

## 11. Decisions (with rationale, for the video and the self-review)

| # | Decision | Why |
|---|---|---|
| D1 | **Expo development build** (CNG, `expo run:ios/android`), not bare RN or Expo Go | Explicitly allowed by the PDF. Native modules (picker, file system) without hand-maintained native projects. Expo Go is not accepted for grading. |
| D2 | **AsyncStorage, every write awaited** before the next network step | "Key persisted before the first POST" is guaranteed by awaiting the native write. MMKV's sync writes aren't needed; one less native dependency. |
| D3 | **Minimal, well-known deps only** (Expo SDK modules, AsyncStorage, safe-area-context) | Supply-chain/privacy risk, reviewer trust. |
| D4 | **Kit moved to `/kit`, contents byte-identical**; client in `/mobile`; root README is ours | The kit stays verifiably unmodified (diff against the zip); a clear entry point for the reviewer. |
| D5 | **npm** | Same as the kit; no extra tooling for a clean checkout. |
| D6 | **No navigation library; the screen is derived from the persisted op state** (+ a tiny local route for Details/Diagnostics). The domain logic is a plain TS controller + a pure revision reducer. | *Changed from "react-navigation" during implementation:* relaunch lands on the right screen automatically, one dependency fewer (D3). Testable without RN. |
| D7 | **One active import at a time** | Simplification for the deadline; the PDF doesn't require several. Named in the self-review. |
| D8 | **Local validation by content**: size from metadata (no full read) ≤ 10 MiB; first 5 bytes `%PDF-`, or the first 24 bytes (CR removed) start with `date,description,amount\n`, the same windows the server uses; the detected format must match the declared type | No reliance on the extension/MIME (PDF requirement). Identical rules to the server, so 415/413 never happen for a file we let through (a CRLF header is rejected by both). Rejection before the POST keeps `createRequests` unchanged. |
| D9 | **Idempotency key = UUID created at Confirm, persisted before the POST, reused for every retry**; separate persisted delete key | Exactly one job under lost_ack/relaunch (stop factor: a second job). |
| D10 | **Unknown POST outcome → GET by-key; resend only on explicit user action** (same key + same bytes). No new import while the outcome is unknown; discard re-checks by key first | The PDF requires no spontaneous resend after relaunch; by-key 404 can mean "still in flight". Starting over with a new key after a 404 could create a second job and orphan the first one where the app can no longer delete it. |
| D11 | **Monotonic revision gate + terminal phase guard** | stale_status can't roll the UI back; a late response can't resurrect a deleted job. |
| D12 | **"Deleted" shown only after GET returns `status=deleted`**; 503 → "not confirmed, data still on server" + retry with the same key | Stop factor: a false deletion claim. |
| D13 | **Private temp copy deleted as soon as the job is confirmed** (or on failure/cancel/discard) + a startup sweep of orphans; the file name is dropped from the persisted record once the server returns `deleted` | Minimal data at rest; the copy is kept only while a resend may be needed, the name only while the server still holds the import. |
| D14 | **Logger with a field allowlist; no analytics/crash SDK** | No bytes, file names, or descriptions in logs. The file name leaves the device only in the required `X-File-Name` header. |
| D15 | **Diagnostics screen always visible, labelled "test-only"** (scenario switch, reset, mock counters, base URL) | The reviewer needs it to run the matrix without code changes between runs. |
| D16 | **Integration tests run against the real kit server** started in a child process (`createMockServer`, temp state file, random port) | Real HTTP, real counters (`newJobs`, `createRequests`), reproducible: a fresh state per test. |
| D17 | **Native runs on macOS** (iOS Simulator + Android emulator); exact versions recorded in the README | Both platforms run locally with no accounts or devices needed; a platform that isn't run is marked unverified. |
| D18 | Removed the committed `.DS_Store`; root `.gitignore` covers it | Junk file, not part of the server/fixtures. |
| D19 | **Expo SDK 58** (RN 0.88). Picker: `expo-document-picker` with `copyToCacheDirectory:false` | Android: no copy before validation (temporary `content://` grant, size from `OpenableColumns.SIZE`). iOS: the system always hands over a sandbox copy (`asCopy`), which we delete. Verified in the module sources. |
| D20 | **Native streamed upload** via `expo-file-system` `File.upload` (BINARY_CONTENT) | Bytes go disk → socket natively (URLSession `uploadTask(fromFile:)` / OkHttp stream); never loaded into JS. |
| D21 | **Staging in `Caches/import-staging`** (not backed up) | Privacy over durability: if the OS purges it during "unknown", the resend needs a re-pick (by-key recovery still works). |
| D22 | Only `INTERNET` permission on Android (template extras blocked); cleartext only in debug; iOS ATS local networking only | Least privilege; see the release note. |
| D23 | **Confirm marks the controller busy synchronously**, before the awaited storage write | A double tap inside that write window would otherwise mint a second key and send twice (stop factor: a second job). Covered by a test that fails on the old code (2 POSTs). |

## 12. Status

- Done: client (`mobile/`), tests 29/29 against the real kit mock (`docs/test-results.txt`), typecheck, README, release note, self-review, video.
- Verified in the installed module sources: iOS picker always uses `asCopy: true` (the URL is the app's own Inbox copy, safe to delete); Android `File.open` supports `content://` via `openFileDescriptor`; `File.upload` streams from disk and honours `signal`.
- iOS: iPhone 17 Simulator, iOS 26.2, built with Xcode 27.2 (27B52). Xcode 26.2 (Swift 6.2.3) can't compile Expo SDK 58's `expo-modules-jsi` ("sending 'slot' risks causing data races"), so the README requires 27.2. Full flow run and recorded: happy, lost_ack + relaunch, stale_status, delete_failure, spoofed/oversize.
- Android: Medium Phone emulator, Android 16 / API 36. Full flow run and recorded. Counters at the end: `createRequests 2, newJobs 2, duplicateHits 0, acceptedBytes 224, deleteRequests 3`, as expected.
- Open: on iOS under `lost_ack` the mock counted `duplicateHits 2` (same key, no extra job, no extra bytes). The app has no automatic resend; suspected OS-level (URLSession) retry of the POST after the dropped connection. Not confirmed. Check: one `lost_ack` upload with no taps → expect `createRequests +2`, `duplicateHits +1`.
- Manual native run used `statement.csv`; `statement.pdf` is covered by the acceptance tests.
