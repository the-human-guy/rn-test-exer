# Self-review

**Key decisions**
1. **Persisted idempotency first, network second.** The key is generated at Confirm and durably written (awaited AsyncStorage) before the POST. Every retry and relaunch reuses it. A lost or uncertain response becomes an explicit "unknown" state, resolved by `GET /imports/by-key`. A resend happens only when the user taps it, with the same key and bytes. This removes the "second job" stop factor by construction.
2. **The server is the source of truth, guarded by revision.** One reducer function (`applyServerJob`) applies server views only if `revision` increases and the job isn't `deleted`. This covers `stale_status`, late poll responses and late ACKs in one place. "Deleted" is rendered only from a server `status=deleted`. 202/`deleting` reads "not confirmed yet", and 503 reads "still on the server".
3. **Validate by content before anything leaves the device, without reading big files.** Size comes from metadata (bounded chunked counting if a provider doesn't report it), then the first 64 bytes are sniffed. The detected format must match the declared one. The private copy is re-validated after staging, and bytes are streamed natively from disk on upload, never through JS memory.

**Simplified for the deadline**
- One active import at a time. A new import is possible only after the previous one is deleted, failed or discarded.
- Polling with backoff instead of push. No background upload (foreground session).
- Minimal UI and no navigation library (screen derived from state). English copy only. No i18n.
- If the OS purges the staging cache while the outcome is unknown, a resend needs the file to be picked again.
- No E2E automation (Maestro/Detox). Native flows are checked manually and on video.
- Not investigated: under `lost_ack` on iOS the mock counted 2 duplicate requests with the same key, which Android didn't have. Nothing was created twice: the server deduplicated by key, so these requests show up only as `duplicateHits`. The app has no automatic resend. My guess is that iOS (URLSession) retries the POST itself when the connection is dropped before any response arrives. Next step: one `lost_ack` upload with nothing else tapped. If the guess is right, `createRequests` goes up by 2 and `duplicateHits` by 1. The PDF fixture was covered by tests, not in the manual native run.

**What breaks first in production, and how we'd notice**
- Ambiguous outcomes on flaky mobile networks (timeouts mid-upload) leave users in "unknown". This shows in the share of unknown-outcome and by-key-404 states, and in time to resolution.
- Large files on slow links. The upload has a 60 s timeout and no resume. This shows in timeout rate by file size bucket.
- Provider quirks with `content://` metadata (missing size, revoked grants). This shows in the `unreadable` rejection rate per Android version.

**AI usage**
- I used an AI coding assistant to read the PDF and kit, draft the plan and write most of the client code and tests; I set the decisions and reviewed the plan before implementation. Native behavior (picker copy semantics, `content://` handling, streamed upload) was checked against the installed module sources, not from memory.
- What I checked myself:
  - **Plan and code against the PDF.** I reviewed both, with a separate AI review pass as a second reader. That found real bugs, which were then fixed and covered by tests:
    - a double tap on Upload could send two POSTs;
    - "discard" could drop a job that already existed on the server;
    - the CSV header check didn't match the server's rule;
    - "Check status" gave no visible feedback.
  - **The acceptance run on both platforms.** I ran it by hand and recorded it: iOS 26.2 Simulator and Android 16 / API 36 emulator.
  - **Counters against the UI.** I compared the mock counters in Diagnostics with what the UI showed. That is how the iOS duplicate requests above were found.
