# Wearlog

Wearlog helps you remember how many times you've worn your clothes since washing them. Add a photo of each garment, tap **+1 Wear now** when you put it on, and record a wash when it's ready for a fresh start.

Install it on your phone as a progressive web app. Wears save immediately on the device, work offline, and sync across devices when you reopen the app with an internet connection.

## Everyday use

- **Add a garment:** choose a photo, drag and zoom to crop it, and assign a wash group. Names are optional.
- **Log a wear:** tap **+1 Wear now** to record today's wear and the time you logged it.
- **Catch up:** open a garment to add several past wears, with an optional date.
- **Check history:** see previous entries and undo mistakes.
- **Wash a load:** select a group to preselect its worn garments, then untick anything you're leaving out.

Wearlog shows the current count so you can decide when to wash. Photos are saved as cropped 640×640 JPEGs.

## Hosting

Wearlog runs on Cloudflare:

| Service | Stores or serves |
| --- | --- |
| Worker with Static Assets | The PWA and API |
| D1 | Garments and wear/wash history |
| Private R2 bucket | Garment photos |
| Access | Sign-in and the owner allowlist |
| IndexedDB on your device | Offline photos, records, and pending entries |

Code deployments preserve the database and photo bucket. See [deployment setup](DEPLOYMENT.md) for provisioning, access policies, and CI configuration.

## Install on iPhone

Open your hosted Wearlog URL in Safari, sign in, and choose **Share → Add to Home Screen**. Open the installed app online and wait for **All changes synced** before using it offline.

When your session expires, entries stay on the device. Tap **Sign in to sync**, complete sign-in, and the app resumes syncing. Reopening the app or tapping **Sync** also retries pending work. Cached records remain available offline on the device after a cloud session expires.

## Local development

Requires Node.js 22.18+ and npm. The Cloudflare CLI and local runtime are pinned in the lockfile.

```sh
git clone https://github.com/martinkozle/wearlog.git
cd wearlog
npm ci
npm run dev
```

Local development uses simulated storage and accepts local requests without cloud sign-in. The development server binds to loopback. Production API requests require a valid Cloudflare Access assertion.

To build and test:

```sh
npm run build
npm test
```

Runtime tests exercise D1 and R2 behavior, duplicate retries, transactional conflicts, pagination, and valid/invalid/expired Access tokens. For mobile browser checks, install Python Playwright and Chromium at `/usr/bin/chromium`, then run `npm run test:browser`.

## Backups

**Settings → Export wardrobe backup** saves photos and history, including pending entries on that device. Import merges entries by their identifiers. A backup should be saved before clearing browser storage, since browsers can remove local data.

For cloud backups, export D1 and copy the R2 bucket using an S3-compatible tool. Keep both together: database records reference photos by their SHA-256 hashes. D1 also provides point-in-time recovery; retention depends on the account plan.

## API and synchronization

See [API.md](API.md). Wearlog stores immutable events with stable identifiers so retries are safe. Each wash references the wears included in that load; a delayed entry from another offline device remains available for the next wash. Past wears count toward the current wash cycle. Undoing a wash from history reverses the entire load.

Photos upload separately from records. Sync uses a server cursor to fetch new events in pages, and pending entries are removed only after acknowledgment and a successful local save.

For frontend releases, bump `CACHE` in `web/sw.js`. After the new shell downloads, close every Wearlog window and reopen to activate it while preserving local entries.
