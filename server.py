"""Wearlog: dependency-free single-user HTTP API and SQLite persistence."""
import json
import os
import sqlite3
import hmac
from datetime import datetime
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlsplit

ROOT = Path(__file__).parent / 'web'
DB = os.getenv('WEARLOG_DB', 'data/wearlog.sqlite3')
TOKEN = os.getenv('WEARLOG_TOKEN', '')


def connect():
    Path(DB).parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB, timeout=30)
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, body TEXT NOT NULL)')
    return db


def validate(r):
    if not isinstance(r, dict) or not isinstance(r.get('id'), str) or not 1 <= len(r['id']) <= 100:
        raise ValueError('Every record needs a stable id')
    if r.get('type') not in ('garment', 'wear', 'wash', 'undo'):
        raise ValueError('Unknown record type')
    try:
        datetime.fromisoformat(r['recordedAt'].replace('Z', '+00:00'))
    except (KeyError, ValueError, TypeError, AttributeError):
        raise ValueError('recordedAt must be an ISO timestamp')
    if r['type'] == 'garment':
        if not isinstance(r.get('name'), str) or len(r['name']) > 120 or not isinstance(r.get('group'), str) or len(r['group']) > 80:
            raise ValueError('Invalid garment name or group')
        photo = r.get('photo', '')
        if not isinstance(photo, str) or len(photo) > 800000 or (photo and not photo.startswith('data:image/jpeg;base64,')):
            raise ValueError('Photo must be a JPEG data URL under 800 KB')
    elif r['type'] == 'wear':
        if not isinstance(r.get('garmentId'), str) or type(r.get('quantity')) is not int or not 1 <= r['quantity'] <= 999:
            raise ValueError('Invalid wear quantity or garment')
        date = r.get('wornOn')
        if date is not None:
            try:
                datetime.strptime(date, '%Y-%m-%d')
            except (ValueError, TypeError):
                raise ValueError('wornOn must be YYYY-MM-DD or null')
    else:
        key = 'wearIds' if r['type'] == 'wash' else 'eventIds'
        if not isinstance(r.get(key), list) or len(r[key]) > 10000 or not all(isinstance(i, str) for i in r[key]):
            raise ValueError('Invalid event references')
    if len(json.dumps(r)) > 850000:
        raise ValueError('Record too large')


def sync(records):
    if not isinstance(records, list) or len(records) > 100:
        raise ValueError('Send at most 100 records')
    for r in records:
        validate(r)
    with connect() as db:
        for r in records:
            existing = db.execute('SELECT body FROM records WHERE id=?', (r['id'],)).fetchone()
            body = json.dumps(r, sort_keys=True, separators=(',', ':'))
            if existing and existing[0] != body:
                raise ValueError('Record id already exists with different content')
            db.execute('INSERT OR IGNORE INTO records VALUES (?,?)', (r['id'], body))
        return [json.loads(row[0]) for row in db.execute('SELECT body FROM records ORDER BY rowid')]


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def authorized(self):
        return not TOKEN or hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + TOKEN)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/api/health':
            return self.reply(200, {'status': 'ok'})
        if path == '/api/state':
            return self.reply(200, {'records': sync([])}) if self.authorized() else self.reply(401, {'error': 'Invalid access token'})
        files = {'/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/model.js': 'model.js', '/style.css': 'style.css', '/sw.js': 'sw.js', '/manifest.webmanifest': 'manifest.webmanifest', '/icon.svg': 'icon.svg', '/icon.png': 'icon.png'}
        if path not in files:
            return self.reply(404, {'error': 'Not found'})
        file = ROOT / files[path]
        mime = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json'}[file.suffix]
        raw = file.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', mime + '; charset=utf-8')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        if self.path != '/api/sync':
            return self.reply(404, {'error': 'Not found'})
        if not self.authorized():
            return self.reply(401, {'error': 'Invalid access token'})
        origin = self.headers.get('Origin')
        if origin and urlsplit(origin).netloc != self.headers.get('Host'):
            return self.reply(403, {'error': 'Cross-origin writes are not allowed'})
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            return self.reply(415, {'error': 'Use application/json'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 20000000:
                return self.reply(413, {'error': 'Request too large or empty'})
            payload = json.loads(self.rfile.read(size))
            records = sync(payload['records'])
        except (ValueError, KeyError, TypeError) as exc:
            return self.reply(400, {'error': str(exc)})
        return self.reply(200, {'records': records})


if __name__ == '__main__':
    connect().close()
    ThreadingHTTPServer(('0.0.0.0', int(os.getenv('PORT', '8080'))), Handler).serve_forever()
