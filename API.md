# Wearlog API v1

Same-origin JSON API. When `WEARLOG_TOKEN` is configured, send `Authorization: Bearer <token>` on state/sync requests. No CORS access. External devices such as ESP32 can use HTTP clients with no Origin header, over a trusted LAN/VPN (prefer HTTPS). Never embed a server token in public source code.

## GET /api/health

Unauthenticated liveness: `{"status":"ok"}`.

## GET /api/state

Returns `{"records":[...]}` containing the complete immutable record log in insertion order. No side effects.

## POST /api/sync

Content-Type: `application/json`. Body `{"records":[...]}`. Up to 100 records and 20 MB per request; client sends batches of ten to keep photo batches under this limit. Empty array pulls latest state. Returns the same shape as `/api/state`, after transaction commit. Identical retries are safe. Conflicting reuse of an ID rejects the entire batch. IDs should be UUIDs.

All records have `id`, `type`, `recordedAt` (ISO timestamp). Shapes:

```json
{"id":"garment-uuid","type":"garment","recordedAt":"2026-11-17T07:00:00Z","name":"Blue merino","group":"Merino","photo":"data:image/jpeg;base64,..."}
```

Name may be empty; max 120 characters. Group max 80. Photo may be empty for API-created items, or a JPEG data URL under 800,000 characters. UI produces 640px square JPEGs.

```json
{"id":"wear-uuid","type":"wear","recordedAt":"2026-11-17T07:01:00Z","garmentId":"garment-uuid","quantity":1,"wornOn":"2026-11-17"}
```

`quantity` is integer 1–999. `wornOn` is a local calendar date or `null` for unknown dates. `recordedAt` always captures entry time. Send a new ID for each intentional action; keep it unchanged when retrying.

```json
{"id":"wash-uuid","type":"wash","recordedAt":"2026-11-17T18:00:00Z","wearIds":["wear-uuid"]}
{"id":"undo-uuid","type":"undo","recordedAt":"2026-11-17T18:01:00Z","eventIds":["wash-uuid"]}
```

A wash resets only referenced wear events. It may cover multiple garments. Undo reverses wear or wash events, and can reverse garment creation for API clients. Undo records themselves are terminal, not undoable. References may arrive out of order. Current count = sum of quantities for a garment's wear records, excluding undone records and wears referenced by active washes. See `web/model.js` for the projection shared by UI and tests.

Errors: 400 invalid payload or conflicting ID; 401 invalid/missing token; 403 cross-origin write; 404 unknown route; 413 request size; 415 content type. Error bodies: `{"error":"message"}`. Clients must retain pending records on every failure.
