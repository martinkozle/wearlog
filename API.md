# Wearlog API v2

Same-origin JSON API protected by Cloudflare Access. Browser requests use the Access session cookie; the Worker also verifies the signature, issuer, audience, and expiry of the `Cf-Access-Jwt-Assertion` supplied by Access. Automated clients can use Access service tokens after an explicit policy is configured for them.

## GET /api/health

Returns `{"status":"ok"}`. The Worker does not require an assertion for this route, but the surrounding Access policy still applies.

## PUT /api/photos/:sha256

Upload JPEG bytes with `Content-Type: image/jpeg`, maximum 600,000 bytes. The path contains the lowercase SHA-256 digest of the exact bytes. Content is checked against the hash; repeating the same upload is safe. Returns `{"hash":"..."}` after the object is stored in private R2 storage.

## GET /api/photos/:sha256

Returns JPEG bytes after authentication. A missing photo returns 404. Clients retain the photo locally for offline use. The bucket has no public delivery URL.

## POST /api/sync

Content-Type: `application/json`. Maximum 25 records and 256,000 bytes per request. Upload referenced photos first.

```json
{"cursor":0,"records":[]}
```

An empty array pulls events. A successful response contains:

```json
{"version":2,"records":[],"acknowledged":[],"cursor":0,"hasMore":false}
```

`records` contains at most 200 events after the supplied cursor, in server insertion order. `acknowledged` lists accepted input IDs, even when those events fall on a later response page. Persist merged events, the new cursor, and outbox acknowledgment atomically before continuing. While `hasMore` is true, request subsequent pages. Keep all pending entries on failures. Reusing an ID with different content rejects the entire input batch.

Each record contains a stable `id`, `type`, and `recordedAt` timestamp with timezone. Garments use a `photoHash` referencing their R2 JPEG, or `null`:

```json
{"id":"garment-uuid","type":"garment","recordedAt":"2026-11-18T07:00:00Z","name":"Blue merino","group":"Merino","photoHash":null}
{"id":"wear-uuid","type":"wear","recordedAt":"2026-11-18T07:01:00Z","garmentId":"garment-uuid","quantity":1,"wornOn":"2026-11-18"}
{"id":"wash-uuid","type":"wash","recordedAt":"2026-11-18T18:00:00Z","wearIds":["wear-uuid"]}
{"id":"undo-uuid","type":"undo","recordedAt":"2026-11-18T18:01:00Z","eventIds":["wash-uuid"]}
```

Names can be empty, up to 120 characters; wash groups are required, up to 80 characters. Wear quantity is an integer from 1 to 999. `wornOn` is a local calendar date or `null`. A wash can include several garments. Undo reverses wear or wash events; undo records are terminal. Referenced records can arrive out of order. Current counts sum active wear quantities, excluding those referenced by an active wash. The shared validator is `web/schema.js`; projection is `web/model.js`.

Errors use `{"error":"message"}`: 400 malformed records, 401 sign-in needed, 403 cross-origin writes, 404 missing route/photo, 409 conflicting ID or missing photo upload, 413 size limit, 415 content type, and 503 missing deployment authentication configuration. Access itself can redirect unauthenticated requests to sign-in before they reach the Worker. Clients must treat these redirects as a sign-in requirement and preserve pending actions.

The JSON export format remains version 1 and embeds photos for portability. It is separate from the v2 sync protocol.
