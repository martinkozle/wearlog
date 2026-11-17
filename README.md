# Wearlog

Wearlog helps you remember how many times you've worn your clothes since washing them. Add a photo of each garment, tap **+1 Wear now** when you put it on, and record a wash when it's ready for a fresh start.

It's a self-hosted web app you can install on your phone. Log wears offline, then reopen the app at home or on your VPN to sync with your server.

## Everyday use

- **Add a garment:** choose a photo, drag and zoom to crop it, and assign a wash group. You can give it a name too.
- **Log a wear:** tap **+1 Wear now** to record today's wear and the time you logged it.
- **Catch up:** open a garment to add several past wears, with an optional wear date.
- **Check history:** see previous entries and undo mistakes.
- **Wash a load:** select a group to preselect its worn garments, then untick anything you're leaving out.

Wearlog shows the current wear count so you can decide when each garment needs washing. Photos are saved as cropped 640×640 JPEGs.

## Install on your server

Requires Docker with Compose:

```sh
git clone https://github.com/martinkozle/wearlog.git
cd wearlog
docker compose up -d --build
```

The app listens at `127.0.0.1:8080`. Configure your reverse proxy to serve it at the root of a stable **HTTPS** hostname, and preserve the original `Host` header. If your proxy also runs in Docker, connect both services to a shared network and proxy to `wearlog:8080`.

Wearlog is designed for a personal wardrobe accessed over a trusted LAN or VPN. By default, anyone who can reach the API can read and update it. To require an access token, create a `.env` file:

```dotenv
WEARLOG_TOKEN=replace-with-a-long-random-secret
```

Apply the setting with `docker compose up -d`, then enter the token in the app's **Settings** on each device. Keep `.env` private.

### Install on iPhone

Open your HTTPS address in Safari and choose **Share → Add to Home Screen**. Open the installed app while connected and wait for **All changes synced** before using it offline.

The app keeps photos and pending entries in IndexedDB, the browser's local database. Sync runs when you open or return to the app, when connectivity returns while it's open, or when you tap **Sync**. On iPhone, reopen the app at home or on your VPN to sync pending changes.

HTTPS is required for offline support on your phone. For local development, `http://localhost:8080` also works.

### Run with Python

Requires Python 3.12+ and uses the standard library:

```sh
python server.py
```

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `WEARLOG_DB` | `data/wearlog.sqlite3` | SQLite database path |
| `WEARLOG_TOKEN` | Empty | Optional API access token |

## Backups

The Docker volume `wardrobe` contains the SQLite database, including garment photos and history. Back it up regularly using SQLite's online backup facility, or stop the service before copying the entire volume, including its WAL files.

In the app, **Settings → Export wardrobe backup** saves a portable JSON copy, including pending entries on that phone. Importing a backup merges entries by their identifiers.

Keep a backup of unsynced entries: clearing browser data or browser storage eviction can remove the phone's local copy. To use another phone, open the same server address, enter the token if configured, and sync.

## Updates

```sh
git pull
docker compose up -d --build
```

After the updated app shell downloads, close all Wearlog windows and reopen it to activate the update. Keep browser data intact to preserve pending entries.

## API and development

The backend stores an immutable event log in SQLite. Stable event identifiers make sync retries safe. Each wash references the wear entries selected for that load, so a delayed offline entry remains available for the next wash. Past wears count toward the current wash cycle; an optional date describes when they happened. Undoing a wash from history reverses the whole load.

See [API.md](API.md) for record formats, authentication, and sync behavior. The frontend uses native browser modules and runs directly from `web/`.

Run the checks:

```sh
python -m unittest discover -s tests -v
npm test
```

For the browser smoke test, install Playwright for Python and Chromium at `/usr/bin/chromium`, then run `python tests/browser_check.py`. It starts a temporary server and checks photo upload, offline reload, wear logging, washing, undo, and sync across browser sessions.

When changing the frontend, bump `CACHE` in `web/sw.js` so installed apps download the updated shell.
