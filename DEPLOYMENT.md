# Deploy Wearlog on Cloudflare

Wearlog uses a Worker with Static Assets, one D1 database, one private R2 Standard bucket, and a Cloudflare Access application. The `cloudflare.config.ts` file defines the app bindings. Access policies and resources persist independently of application deployments.

## Initial setup

1. Enable Workers, R2, and Cloudflare Zero Trust on your account. R2 activation includes a billing subscription with free usage allowances.
2. Create a D1 database named `wearlog` and an R2 bucket named `wearlog-photos`. Keep R2 public access disabled.
3. Create a reusable Access Allow policy limited to your email. Attach it to an Access application protecting the app hostname. Select your existing identity provider or configure email one-time PIN. Set a suitable session duration, such as seven days.
4. Copy `.env.example` to `.env` and fill in the account ID, D1 ID, bucket name, Access team issuer, and application audience. Set `WEARLOG_HOSTNAME` to your custom hostname, such as `wearlog.example.com`, to include it in future deployments. These identify resources; the deployment API token is supplied separately as `CLOUDFLARE_API_TOKEN`, or use `npx cf auth login` interactively.
5. Apply the database migrations and deploy:

```sh
npm ci
npx cf d1 migrations apply "$WEARLOG_D1_ID" --dir migrations
npm run deploy
```

Export the variables into the shell before running the migration command, or replace the database variable with its UUID. The cf build reads `.env` for the project configuration. A scoped API token needs Worker editing, D1 editing, and R2 editing permissions in the selected account; provisioning Access requires separate Access application/policy permissions.

Access should cover the entire Worker, including preview and custom-domain URLs. The worker-level destination uses the Worker's UUID, available from the Workers API. The app's default configuration disables preview URLs. The backend also verifies the signed Access assertion before serving wardrobe records or photos, and fails closed if the issuer or audience is missing.

The Cloudflare connector can provision resources and deploy a built Worker using its API without exporting its connection credentials. CLI deployments from another environment use that environment's own Cloudflare authorization.

## GitHub Actions

`Checks` builds and tests pushes and pull requests. `Deploy` is manually triggered from GitHub Actions and uses a `production` environment.

Configure these repository or environment variables:

- `CLOUDFLARE_ACCOUNT_ID`
- `WEARLOG_D1_ID`
- `WEARLOG_HOSTNAME` (custom hostname)
- `WEARLOG_R2_BUCKET`
- `WEARLOG_ACCESS_ISSUER`
- `WEARLOG_ACCESS_AUD`

Store a scoped `CLOUDFLARE_API_TOKEN` as an environment secret. The workflow applies pending SQL migrations before deployment. Use additive schema changes compatible with the currently running release.

## Verify a release

- A fresh, unauthenticated browser is sent to Cloudflare Access.
- Only the allowed identity can sign in.
- The R2 bucket's managed public domain and custom domains are disabled.
- Add a garment, log a wear, and verify it from a second device.
- Turn off connectivity, log another wear, reload, then reconnect and sync.
- With an expired session, retain pending entries and sign in using **Sign in to sync**.
- On iPhone, install from Safari and repeat the offline/sign-in checks in the installed app.

## Operations

Use `cf` resource commands or Cloudflare's API to inspect deployments, query D1, and inspect Worker logs. The Worker enables logs and samples traces. Photos remain in R2 and records remain in D1 across code deployments. Code rollback does not roll back the database or bucket.

Before a destructive database change, export D1 and copy the photo bucket. The in-app JSON backup is a portable copy of the wardrobe on that device, including unsynced entries. Keep a copy outside Cloudflare for recovery.

Cloudflare Workers and D1 free limits stop operations when exhausted. R2 Standard includes a free allowance and charges beyond it. Check account usage and configure billing alerts; Worker spending controls do not cap R2 charges. Photo uploads are bounded to 600 KB each. Consult current product pricing before enabling paid plans.
