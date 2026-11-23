# Plan — Mobile Engineer test task: bank statement import without losing state

Source: `docs/mobile-engineer-test-task.pdf` (RU) + kit `README.md` + `mock-server.mjs` (read in full).
Budget: ~8h of work within 4 calendar days. Base scenario > polish. If time runs out, ship the working part and list unverified platforms and the remaining risks.

Legend: **[Q]** = open question for you (see the last section). **[V]** = verify during implementation, unknown now.

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

- Expo SDK (latest stable at the time, **[V]** version) + dev build via `expo prebuild` / `expo run:ios|android`. CNG, no committed `ios/`/`android/` folders unless needed.
- Picker: `expo-document-picker`. Files: `expo-file-system` (new `File`/`Directory` API: size, partial read through a file handle). Upload streamed from disk natively (`File` as the fetch body or `uploadAsync` BINARY_CONTENT) **[V]**: must not load the whole file into JS memory.
- Persisted operation state: `@react-native-async-storage/async-storage`. Every write is **awaited** before the next network step (POST/DELETE). The promise resolves after the native write completes. Dependency rule: only Expo SDK modules + well-known community packages, minimal count.
- Domain logic: a plain TS reducer/state machine + an API client. No XState or Redux; small scope.
- Tests: Jest. Domain + API client integration tests run in a Node env against the **real kit server** started in-process via `createMockServer({statePath: tmp})`, an import with no edits to the kit. Component tests: React Native Testing Library. E2E (optional, if time allows): Maestro.

## 4. Repo layout (decided)

```
/kit         kit, contents byte-identical (mock-server.mjs, fixtures/, package.json, README.md, .gitignore)
/mobile      RN client (own package.json, tests)
/README.md   ours: clean checkout, run, test, per-platform results
/docs        plan.md, task PDF, release-note.md, self-review.md
```

## 5. Client architecture

### 5.1 Persisted operation record (one active import,)
```
ImportOp {
  importKey: string            // UUID v4, created at "Confirm" and persisted BEFORE the first POST
  phase: 'prepared' | 'sending' | 'unknown' | 'tracking' | 'deleting' | 'deleted' | 'failed' | 'cancelled'
  localCopyPath?: string       // app-private copy, needed only until the job is confirmed
  fileMeta: { displayName, size, format }   // displayName stays in local private storage only, never logged
  jobId?: string
  lastStatus?: JobStatus, lastRevision: number
  result?: ReadyPayload
  deleteKey?: string           // created and persisted BEFORE the first DELETE, reused on every retry
  lastError?: ErrorCode        // codes, no PII
}
```

### 5.2 Flows
1. **Pick** → system picker (PDF/CSV filter is a hint only).
2. **Validate locally, before any POST** (no reliance on the extension or MIME):
   - Size from file metadata (picker size, then a stat of the copy). Reject > 10 MiB (10 × 1024 × 1024) **without reading the file**. [V] whether the picker copies before we can check size (iOS `asCopy`, Android `copyToCacheDirectory`). If it copies, the copy is deleted immediately on rejection.
   - Read only the first N bytes (~64) through a file handle → detect the format: `%PDF-` → pdf; `date,description,amount` header → csv; otherwise reject ("not a valid PDF/CSV"). The detected format must match the declared type (extension/MIME), otherwise reject.
3. **Confirm screen**: name, human-readable size, detected format. Cancel → delete the temp copy and clear the op.
4. **Confirm** → generate `importKey`, persist the op (`prepared`) → `sending` → POST (streamed bytes, headers).
   - 202 → store jobId, `tracking`, **delete the local copy**.
   - Network error / timeout (lost_ack) → `unknown`. Show "Outcome unknown, checking…" → GET by-key. 200 → adopt the job. 404 → offer a **user-initiated** "Retry send" (same key, same bytes from the kept copy). Never automatic after relaunch.
   - 409/413/415/4xx → `failed` with a readable message, delete the copy.
5. **Tracking**: poll `GET /imports/{jobId}` (~500ms, backoff, paused in background, resumed via AppState). **Monotonic revision gate**: apply a response only if `revision > lastRevision`. The stale r2 after ready r3 is ignored. Stop polling at `ready`.
6. **Ready**: list of 2 items + total "151.99 AUD / month". "Подробнее" (details) → detail card (merchant, amount, cadence, lastSeen). No subscription cancellation.
7. **Delete**: generate and persist `deleteKey` → `deleting`, DELETE.
   - 503/network → stay on "Deletion not confirmed. Data still on server", Retry (same deleteKey).
   - 202 → "Deleting on server…" and poll GET until `status=deleted` (r5). Only then "Deleted on server".
   - **No resurrection**: after `deleting`/`deleted`, any late response with a lower revision or non-delete status is dropped (revision gate + a terminal phase guard). In-flight polls are aborted (AbortController) and responses tagged with an op generation id.
8. **Relaunch** (normal app restart): load the op → `prepared`/`sending`/`unknown` → GET by-key (no POST) → same as 4; `tracking` → resume polling; `deleting` → resume polling of the delete status, not a re-DELETE (or a re-DELETE with the same key is safe; decide [V]).
9. **Cleanup**: the local copy is deleted on: 202/job found, failure, cancel, deleted. Startup sweep: delete any files in the private import dir not referenced by the persisted op. Copy dir = app-private (iOS: excluded from backup).

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

Extra: happy path csv + pdf end-to-end against the mock (bytes = `acceptedBytes`); late response after delete doesn't resurrect; logger redaction; 409 handling.
Command: `cd mobile && npm test`, which runs `fixtures:oversize` first (pretest). Output saved to `docs/test-results.txt`.

The validator must run against fixture files in Node and on device → abstract file access behind an interface (`FileSource` with `size()`, `readHead(n)`), implemented with expo-file-system in the app and `fs` in tests.

## 7. Native verification (Mac with iOS simulator + Android emulator; exact versions recorded by your on-device agent at test time)

- iOS (simulator or device) and Android (emulator or device): at least file picking + one full import on **each**. Record OS/device versions.
- Getting fixtures onto the device: iOS sim drag & drop into Files / `xcrun simctl addmedia`? [V]; Android `adb push fixtures/* /sdcard/Download/`.
- A platform that wasn't available → marked **unverified** everywhere. No web build as a substitute.
- This cloud container can run Jest + the mock but **not** simulators. Native runs happen on your machine.

## 8. Deliverables

- [ ] Client repo + unchanged kit.
- [ ] README: exact clean-checkout steps, commands to start the mock and the client, test command, devices/OS versions, **actual result per platform** (iOS and Android separately, unverified marked as such).
- [ ] `docs/release-note.md` (short): permissions actually needed (expected: none at runtime; the picker uses the system UI, plus Android cleartext HTTP to localhost/LAN, iOS ATS exception for local networking); where file copies live and when they're removed; how to clear data; rollout-stop signal (e.g. spike in `unknown`-outcome or duplicate-job rate, delete-not-confirmed rate); what needs a **new native binary** vs JS/OTA (native modules, ATS/cleartext config, permissions, SDK bump → binary; UI/logic → OTA).
- [ ] `docs/self-review.md` (≤1 page): 2–3 key decisions, what was simplified for the deadline, what breaks first in production and how we'd notice, **AI usage: what was generated and what you verified yourself**.
- [ ] Test results.
- [ ] Short video (**you** record it): iOS, Android, happy, lost_ack + relaunch, stale_status, delete_failure. Unverified parts shown honestly.

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

## 11. Decisions

- Expo dev build. AsyncStorage (awaited writes). Kit moved to `/kit`, unchanged. Hardware: Mac with iOS simulator + Android emulator.

## 12. Open questions

1. Package manager: npm (the kit uses npm) / yarn / pnpm / bun? Default: npm.
2. Navigation/state: react-navigation native stack + reducer/context (my pick) vs expo-router/zustand?
3. One active import at a time is fine? (Simplification; the PDF doesn't require several.)
4. CSV validation: require the exact `date,description,amount` header (same as the server's rule)? I recommend yes.
5. Diagnostics screen: always visible, labelled "test-only" (my pick; the reviewer needs it), or `__DEV__` only?
6. `.DS_Store` in the init commit: remove it? (Now in the root `.gitignore`.)
