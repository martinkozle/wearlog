# Wearlog development

- Use `cf` and `cloudflare.config.ts` for Cloudflare workflows. Retrieve current CLI schemas with `cf cli search` before relying on command syntax.
- Keep wear/wash/undo behavior in `web/model.js` and record validation in `web/schema.js` shared with the Worker.
- Preserve the local outbox on all upload, authentication, and sync failures. Acknowledge records and advance the cursor in the same IndexedDB write.
- Require Cloudflare Access on every production hostname. Verify signed assertions on data routes. Local authentication bypass is restricted to loopback and development mode.
- Keep photo storage private. Photos are content-addressed JPEGs in R2; D1 holds references.
- Bump the service-worker cache version for frontend changes.
- Run `npm run build` and `npm test` for backend/protocol changes. Run `npm run test:browser` for user flow, storage, or sync changes.
- Write public documentation for a reader discovering the app. Explain current behavior and useful operating constraints.
