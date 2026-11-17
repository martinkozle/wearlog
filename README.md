# Wearlog

A small, self-hosted wardrobe tracker. Photo first, no wear limits, no Immich dependency. A mobile PWA backed by SQLite with no runtime Python or JavaScript dependencies.

- Upload a garment photo, drag and zoom to crop, and choose a wash group. Name optional.
- **+1 Wear now** records today's wear and the time you tapped it.
- Open a garment for history, past wears in batches, optional wear dates, and undo.
- **Wash a load** preselects worn garments in the current group. Exclude anything elsewhere.
- Works offline after first loading online. Photos, records, and pending changes live in IndexedDB on your phone. Reopen at home or on VPN to sync. No background sync guarantee on iOS.
- Export and merge JSON backups in Settings.

## Run on your server

```sh
git clone https://github.com/martinkozle/laundry-tracker-immich.git
cd laundry-tracker-immich
docker compose up -d --build
```

Proxy a stable **HTTPS** hostname to `127.0.0.1:8080`. Keep access on your LAN/VPN as planned. Preserve the original `Host` header; POST requests check `Origin` against it. Mount at the hostname root (subpath deployment is not supported). If your proxy runs in Docker, put it and Wearlog on a shared network and proxy to `wearlog:8080`, or configure the published binding for your setup. The default binding only accepts connections on the server's loopback interface.

On iPhone, open the HTTPS URL in Safari, use Share → Add to Home Screen, then open the installed app once while connected. Add a garment and check that Sync reports success before relying on offline use. HTTP over a LAN IP does **not** provide the service-worker support needed for offline installation. Localhost HTTP is fine for development.

### Optional access token

By default, this is a trusted LAN/VPN application with **no authentication**. Anyone who can reach the API can read and write the wardrobe. For shared networks, configure a long random token in a server-side `.env` file:

```dotenv
WEARLOG_TOKEN=replace-with-a-long-random-secret
```

Restart with `docker compose up -d`, then enter that token in the PWA's Settings. It is saved on that device and sent as a Bearer token over HTTPS. Health checks and the empty app shell remain public; wardrobe API access requires the token. This is single-user access control, not an account system. Do not commit `.env`, personal photos, or database files to this public repository.

### Without Docker

Requires Python 3.12+:

```sh
python server.py
```

Open `http://localhost:8080`. Environment: `PORT` (8080), `WEARLOG_DB` (`data/wearlog.sqlite3`), `WEARLOG_TOKEN` (optional).

## Backups and updates

The Docker volume `wardrobe` holds `/data/wearlog.sqlite3` and its SQLite WAL files; images are stored within records in the database. Use a SQLite online backup, or stop the container before copying the entire volume. Back up the volume regularly. Settings → Export provides a portable copy of all records and photos currently on the phone, including unsynced changes. Import merges by stable IDs rather than replacing the wardrobe.

Browser storage is not a permanent backup: clearing website data or browser storage eviction can remove unsynced changes. On another phone, use the same server URL (and token if configured), then Sync. Uninstalling/reinstalling is not a supported backup strategy.

To update: `git pull` then `docker compose up -d --build`. The service worker caches a versioned app shell; future frontend changes must bump `CACHE` in `web/sw.js`. After a new worker downloads, close all app windows and reopen to activate it. Do not clear website storage to update.

## API and sync model

See [API.md](API.md). Records are immutable, uniquely identified events. SQLite inserts a batch transactionally; retries with identical IDs and content are harmless. The client persists its records and outbox together before showing a successful action. On successful sync it atomically merges server records with any newer pending local records, and removes only acknowledged outbox entries.

A wash explicitly references the wear event IDs visible when recorded. It does not blindly set a counter to zero on arrival: a previously unseen wear from another offline device survives. Unknown-date past wears are applied to the current wash cycle unless subsequently washed; choosing an old date does not retroactively change past wash membership. Counts are derived from active, unwashed wear events. Undo is permanent reversal of an event; undoing a wash restores its referenced wears (unless another active wash covers them). Undo for a load reverses the whole load, including from garment history.

For this pilot, garments cannot be edited or archived after creation; there is no image recognition, analytics, multi-user account system, or Immich integration. Photos are cropped to 640×640 JPEGs; originals are not retained. All history and photos are returned on each sync, suitable for a personal wardrobe. Pagination, photo deduplication, garment editing, and retention can follow if needed.

## Development checks

```sh
python -m unittest discover -s tests -v
npm test
```

Optional browser smoke check: install Playwright for Python and Chromium, then run `python tests/browser_check.py` (uses `/usr/bin/chromium` and a temporary database). It covers photo upload, offline reload, past wears, washing, undo, synchronization, and a second browser session.

No build step or npm install is needed for the app. The backend uses Python's standard HTTP server; this is a small trusted-network pilot behind a reverse proxy, rather than a public multi-tenant service.
