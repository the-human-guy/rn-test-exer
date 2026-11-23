# Self-review

> DRAFT: the author must review and adjust before sending, especially the AI section and the platform results.

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

**What breaks first in production, and how we'd notice**
- Ambiguous outcomes on flaky mobile networks (timeouts mid-upload) leave users in "unknown". This shows in the share of unknown-outcome and by-key-404 states, and in time to resolution.
- Large files on slow links. The upload has a 60 s timeout and no resume. This shows in timeout rate by file size bucket.
- Provider quirks with `content://` metadata (missing size, revoked grants). This shows in the `unreadable` rejection rate per Android version.

**AI usage**
- An AI coding assistant read the PDF and kit, drafted the plan, and wrote most of the client code and tests. Native behavior (picker copy semantics, `content://` handling, streamed upload) was checked against the installed module sources, not from memory.
- _Author to fill: what you verified yourself: reviewed the state machine and the failure paths, ran the matrix on iOS/Android (devices/versions), cross-checked mock counters against the UI._
