import {inviteAlphabet, normalizeInviteCode, photoHash} from '../web/schema.js';

export const LEGACY_WARDROBE = 'legacy';
export const accountId = email => photoHash(new TextEncoder().encode(email));
export const displayName = email => email.split('@')[0].split(/[._-]+/).filter(Boolean)
  .map(part => part[0].toUpperCase() + part.slice(1)).join(' ').slice(0, 120) || email;

export async function migrateLegacy(db, configuredMembers) {
  if (!configuredMembers || await db.prepare('SELECT 1 FROM legacy_wardrobe_migration').first()) return;
  const emails = [...new Set(configuredMembers.split(',').map(email => email.trim().toLowerCase()).filter(Boolean))];
  if (!emails.length || emails.length > 25 || emails.some(email => !/^[^\s@]+@[^\s@]+$/.test(email))) {
    throw new Error('Invalid WEARLOG_LEGACY_MEMBERS configuration');
  }
  // A concurrent request rolls back if another request already claimed the migration.
  // Copy at runtime so writes by the pre-upgrade Worker during SQL deployment are included.
  try {
    await db.batch([
      db.prepare('INSERT INTO legacy_wardrobe_migration VALUES (1)'),
      db.prepare('INSERT INTO wardrobes (id, name) VALUES (?, ?)').bind(LEGACY_WARDROBE, 'Martin’s Wardrobe'),
      ...emails.map(email => db.prepare('INSERT INTO wardrobe_members VALUES (?, ?)').bind(LEGACY_WARDROBE, email)),
      db.prepare('INSERT INTO wardrobe_records (wardrobe_id, id, body) SELECT ?, id, body FROM records ORDER BY seq').bind(LEGACY_WARDROBE),
      db.prepare('DELETE FROM records')
    ]);
  } catch (error) {
    if (!await db.prepare('SELECT 1 FROM legacy_wardrobe_migration').first()) throw error;
  }
}

export function findMembership(db, wardrobe, email) {
  return db.prepare('SELECT 1 FROM wardrobe_members WHERE wardrobe_id = ? AND email = ?').bind(wardrobe, email).first();
}

export async function manageWardrobes({db, request, url, user, json, problem, readJson, env}) {
  const {pathname: path} = url;
  if (path === '/api/wardrobes' && request.method === 'GET') {
    await migrateLegacy(db, env.LEGACY_MEMBERS);
    const {results: wardrobes} = await db.prepare(`
      SELECT w.id, w.name FROM wardrobe_members m JOIN wardrobes w ON w.id = m.wardrobe_id
      WHERE m.email = ? ORDER BY w.name COLLATE NOCASE, w.id
    `).bind(user.email).all();
    return json({account: user.id, name: user.name, wardrobes});
  }

  if (request.headers.get('X-Wearlog-Account') !== user.id) throw problem(409, 'Your sign-in changed. Reopen Wearlog to continue.');

  if (path === '/api/wardrobes' && request.method === 'POST') {
    const input = await readJson(request);
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 80) throw problem(400, 'Enter a wardrobe name up to 80 characters');
    const id = crypto.randomUUID();
    await db.batch([
      db.prepare('INSERT INTO wardrobes VALUES (?, ?)').bind(id, name),
      db.prepare('INSERT INTO wardrobe_members VALUES (?, ?)').bind(id, user.email)
    ]);
    return json({id, name}, 201);
  }

  if (path === '/api/invites' && ['GET', 'POST'].includes(request.method)) {
    const token = normalizeInviteCode(request.method === 'GET' ? url.searchParams.get('token') : (await readJson(request))?.token);
    if (!token) throw problem(404, 'Invite unavailable');
    const hash = await accountId(token);
    const now = Date.now();
    if (request.method === 'POST') {
      await db.prepare(`
        UPDATE wardrobe_invites SET redeemed_by = ?
        WHERE token_hash = ? AND expires_at > ? AND redeemed_by IS NULL
        AND NOT EXISTS (SELECT 1 FROM wardrobe_members WHERE wardrobe_id = wardrobe_invites.wardrobe_id AND email = ?)
      `).bind(user.email, hash, now, user.email).run();
    }
    const invite = await db.prepare(`
      SELECT w.id, w.name, EXISTS (
        SELECT 1 FROM wardrobe_members WHERE wardrobe_id = w.id AND email = ?
      ) AS joined
      FROM wardrobe_invites i JOIN wardrobes w ON w.id = i.wardrobe_id
      WHERE i.token_hash = ? AND i.expires_at > ?
      AND (i.redeemed_by IS NULL OR i.redeemed_by = ?)
    `).bind(user.email, hash, now, user.email).first();
    if (!invite || (request.method === 'POST' && !invite.joined)) throw problem(404, 'This invite has expired or is no longer available');
    return json({id: invite.id, name: invite.name, joined: Boolean(invite.joined)});
  }

  const match = path.match(/^\/api\/wardrobes\/(legacy|[a-f0-9-]{36})\/(invite|leave|members)$/);
  if (!match) throw problem(404, 'Not found');
  const [, wardrobe, action] = match;

  if (action === 'members' && request.method === 'GET') {
    const {results} = await db.prepare(`
      SELECT email FROM wardrobe_members WHERE wardrobe_id = ?
      AND EXISTS (SELECT 1 FROM wardrobe_members WHERE wardrobe_id = ? AND email = ?)
      ORDER BY email
    `).bind(wardrobe, wardrobe, user.email).all();
    if (!results.length) throw problem(404, 'Wardrobe unavailable');
    return json({members: results.map(({email}) => ({email, name: displayName(email), you: email === user.email}))});
  }

  if (action === 'invite' && request.method === 'POST') {
    const token = Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => inviteAlphabet[byte & 31]).join('');
    const expiresAt = Date.now() + 7 * 86400000;
    const result = await db.prepare(`
      INSERT INTO wardrobe_invites (token_hash, wardrobe_id, expires_at)
      SELECT ?, wardrobe_id, ? FROM wardrobe_members WHERE wardrobe_id = ? AND email = ?
    `).bind(await accountId(token), expiresAt, wardrobe, user.email).run();
    if (!result.meta.changes) throw problem(404, 'Wardrobe unavailable');
    return json({token, expiresAt}, 201);
  }

  if (action === 'leave' && request.method === 'POST') {
    const input = await readJson(request);
    const result = await db.prepare(`
      DELETE FROM wardrobe_members WHERE wardrobe_id = ? AND email = ?
      AND (? = 1 OR EXISTS (SELECT 1 FROM wardrobe_members WHERE wardrobe_id = ? AND email <> ?))
    `).bind(wardrobe, user.email, input?.deleteIfLast === true ? 1 : 0, wardrobe, user.email).run();
    if (!result.meta.changes && await findMembership(db, wardrobe, user.email)) {
      throw problem(409, 'You’re the last member. Confirm that you want to delete this wardrobe.');
    }
    return json({left: true});
  }
  throw problem(405, 'Method not allowed');
}

export function photoKey(wardrobe, hash) {
  return wardrobe === LEGACY_WARDROBE ? hash : `wardrobes/${wardrobe}/${hash}`;
}

// Process one bounded page at a time. Jobs survive partial failures and later requests retry them.
export async function cleanWardrobePhotos(env) {
  const db = env.DB.withSession('first-primary');
  const job = await db.prepare('SELECT wardrobe_id, cursor, revision FROM wardrobe_photo_cleanup ORDER BY rowid LIMIT 1').first();
  if (!job) return;
  const {wardrobe_id: wardrobe, cursor, revision} = job;
  const page = await env.PHOTOS.list({
    prefix: wardrobe === LEGACY_WARDROBE ? '' : `wardrobes/${wardrobe}/`,
    delimiter: wardrobe === LEGACY_WARDROBE ? '/' : undefined,
    cursor: cursor ?? undefined,
    limit: 100
  });
  const keys = page.objects.map(object => object.key)
    .filter(key => wardrobe !== LEGACY_WARDROBE || /^[a-f0-9]{64}$/.test(key));
  if (keys.length) await env.PHOTOS.delete(keys);
  if (page.truncated) {
    await db.prepare('UPDATE wardrobe_photo_cleanup SET cursor = ? WHERE wardrobe_id = ? AND cursor IS ? AND revision = ?')
      .bind(page.cursor, wardrobe, cursor, revision).run();
  } else {
    await db.prepare('DELETE FROM wardrobe_photo_cleanup WHERE wardrobe_id = ? AND cursor IS ? AND revision = ?').bind(wardrobe, cursor, revision).run();
  }
}
