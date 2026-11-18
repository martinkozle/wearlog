# Wearlog API v3

Same-origin JSON API protected by Cloudflare Access. Browser requests use the Access session cookie; the Worker also verifies the signature, issuer, audience, and expiry of the `Cf-Access-Jwt-Assertion` supplied by Access. Data routes require a verified Access assertion containing the signed-in user's email.

## Wardrobes and invites

- **GET /api/wardrobes** returns the current account identifier, display name, and wardrobe list. **POST** with `{"name":"Home"}` creates a wardrobe with the caller as its first member.
- **GET /api/wardrobes/:id/members** lists members. **POST /api/wardrobes/:id/invite** with `{}` generates a single-use token valid for seven days.
- **GET /api/invites?token=…** previews the name and whether the caller already joined. **POST /api/invites** with `{"token":"…"}` accepts it.
- **POST /api/wardrobes/:id/leave** removes the caller. If the caller is the last member, the endpoint requires `{"deleteIfLast":true}` and deletes the wardrobe, records, and invites atomically. Photos are cleaned up separately.

Send `X-Wearlog-Account` with the account identifier from the wardrobe list on account-specific requests. Send `X-Wearlog-Wardrobe` with the active wardrobe ID on sync and photo requests. The Worker verifies the signed identity and wardrobe membership independently.

## GET /api/health

Returns `{"status":"ok"}`. The Worker does not require an assertion for this route, but the surrounding Access policy still applies.

## PUT /api/photos/:sha256

Upload JPEG bytes with `Content-Type: image/jpeg`, maximum 600,000 bytes. The path contains the lowercase SHA-256 digest of the exact bytes. Content is checked against the hash; repeating the same upload is safe. Returns `{"hash":"..."}` after the object is stored in private R2 storage.

## GET /api/photos/:sha256

Returns JPEG bytes referenced by a garment in the requested wardrobe. A missing photo returns 404. Clients retain the photo locally for offline use. The bucket has no public delivery URL.

## POST /api/sync

Content-Type: `application/json`. Maximum 25 records and 256,000 bytes per request. Upload referenced photos first.

```json
{"cursor":0,"records":[]}
```

An empty array pulls events. A successful response contains:

```json
{"version":3,"records":[],"acknowledged":[],"cursor":0,"hasMore":false}
```

`records` contains at most 200 events after the supplied cursor, in server insertion order. `acknowledged` lists accepted input IDs, even when those events fall on a later response page. Persist merged events, the new cursor, and outbox acknowledgment atomically before continuing. While `hasMore` is true, request subsequent pages. Keep all pending entries on failures. Reusing an ID with different content rejects the entire input batch.

Returned records can include a server-assigned `actor` with `id` and `name`. Existing records may have no actor. Keep the cursor and outbox separately for each account and wardrobe. Each record contains a stable `id`, `type`, and `recordedAt` timestamp with timezone. Garments use a `photoHash` referencing their R2 JPEG, or `null`:

```json
{"id":"garment-uuid","type":"garment","recordedAt":"2026-11-18T07:00:00Z","name":"Blue merino","group":"Merino","photoHash":null}
{"id":"wear-uuid","type":"wear","recordedAt":"2026-11-18T07:01:00Z","garmentId":"garment-uuid","quantity":1,"wornOn":"2026-11-18"}
{"id":"wash-uuid","type":"wash","recordedAt":"2026-11-18T18:00:00Z","wearIds":["wear-uuid"]}
{"id":"undo-uuid","type":"undo","recordedAt":"2026-11-18T18:01:00Z","eventIds":["wash-uuid"]}
{"id":"delete-uuid","type":"delete","recordedAt":"2026-11-18T18:02:00Z","garmentId":"garment-uuid"}
```

Names can be empty, up to 120 characters; wash groups are required, up to 80 characters. Wear quantity is an integer from 1 to 999. `wornOn` is a local calendar date or `null`. A wash can include several garments. Undo reverses wear or wash events. A delete event hides a garment while preserving its event log. Referenced records can arrive out of order. Current counts sum active wear quantities, excluding those referenced by an active wash. The shared validator is `web/schema.js`; projection is `web/model.js`.

Errors use `{"error":"message"}`: 400 malformed records, 401 sign-in needed, 403 cross-origin writes, 404 missing route/photo, 409 conflicting ID or missing photo upload, 413 size limit, 415 content type, and 503 missing deployment authentication configuration. Access itself can redirect unauthenticated requests to sign-in before they reach the Worker. Clients must treat these redirects as a sign-in requirement and preserve pending actions.

The JSON export format remains version 1 and embeds photos for portability. It is separate from the sync protocol and applies to the active wardrobe.
