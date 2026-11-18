import {createRemoteJWKSet, jwtVerify} from 'jose';
import {validateRecord, photoHash, normalizeInviteCode} from '../web/schema.js';
import {accountId, cleanWardrobePhotos, displayName, findMembership, manageWardrobes, photoKey} from './wardrobes.js';
const MAX_JSON = 256000, MAX_PHOTO = 600000;
const json = (data,status=200) => Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const problem = (status,message) => Object.assign(new Error(message),{status});
const keySets = new Map();
async function authenticate(request,env) {
  const url = new URL(request.url);
  if (env.LOCAL_DEV === 'true' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)) {
    return {email: 'local@example.com', name: 'Local'};
  }
  if (!env.ACCESS_ISSUER || !env.ACCESS_AUD) throw problem(503,'Access is not configured');
  const token=request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw problem(401,'Sign in to sync');
  try {
    const issuer=env.ACCESS_ISSUER;
    if (!keySets.has(issuer)) keySets.set(issuer,createRemoteJWKSet(new URL(issuer+'/cdn-cgi/access/certs')));
    const {payload} = await jwtVerify(token,keySets.get(issuer),{issuer,audience:env.ACCESS_AUD,algorithms:['RS256']});
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error('Missing identity');
    return {email, name: displayName(email)};
  } catch { throw problem(401,'Sign in to sync'); }
}
async function readBounded(request,max) {
  const advertised=Number(request.headers.get('Content-Length'));
  if(advertised>max)throw problem(413,'Upload is too large');
  if(!request.body)return new Uint8Array();
  const reader=request.body.getReader(),chunks=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();throw problem(413,'Upload is too large');}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}return bytes;
}
async function readJson(request) {
  if(request.headers.get('Content-Type')?.split(';')[0]!=='application/json')throw problem(415,'Use application/json');
  try {
    return JSON.parse(new TextDecoder().decode(await readBounded(request,MAX_JSON)));
  } catch (error) {
    if (error.status) throw error;
    throw problem(400,'Invalid JSON');
  }
}
async function handle(request,env,ctx) {
  const url=new URL(request.url),path=url.pathname;
  if(path==='/api/health')return json({status:'ok'});
  if(path==='/auth/resume') {
    const token = normalizeInviteCode(url.searchParams.get('invite'));
    const location = token ? '/?invite=' + token : '/';
    return new Response(null,{status:303,headers:{Location:location, 'Cache-Control':'no-store'}});
  }
  // Cloudflare Access protects the shell; validate its signed assertion on all data routes too.
  if(!path.startsWith('/api/'))return env.ASSETS.fetch(request);
  const user = await authenticate(request,env);
  user.id = await accountId(user.email);
  if(!['GET','POST','PUT'].includes(request.method))throw problem(405,'Method not allowed');
  if(request.method!=='GET') {
    const origin=request.headers.get('Origin');
    if(origin && origin!==url.origin)throw problem(403,'Cross-origin writes are not allowed');
    if(request.headers.get('Sec-Fetch-Site')==='cross-site')throw problem(403,'Cross-origin writes are not allowed');
  }

  const db = env.DB.withSession('first-primary');
  if (/^\/api\/(wardrobes|invites)(?:\/|$)/.test(path)) {
    const response = await manageWardrobes({db, request, url, user, json, problem, readJson, env});
    if (path === '/api/wardrobes' || path.endsWith('/leave')) {
      ctx.waitUntil(cleanWardrobePhotos(env).catch(error => console.error('Wardrobe photo cleanup failed', error)));
    }
    return response;
  }

  const photo=path.match(/^\/api\/photos\/([a-f0-9]{64})$/);
  if (!photo && (path !== '/api/sync' || request.method !== 'POST')) throw problem(404,'Not found');
  const wardrobe = request.headers.get('X-Wearlog-Wardrobe');
  if (!wardrobe) throw problem(426,'Update Wearlog to sync your wardrobe');
  if (request.headers.get('X-Wearlog-Account') !== user.id) throw problem(409,'Your sign-in changed. Reopen Wearlog to continue.');
  if (!await findMembership(db, wardrobe, user.email)) throw problem(404,'Wardrobe unavailable');

  if(photo) {
    const hash = photo[1];
    const key = photoKey(wardrobe, hash);
    if(request.method==='GET') {
      const record = await db.prepare(`
        SELECT 1 FROM wardrobe_records WHERE wardrobe_id = ? AND json_extract(body, '$.photoHash') = ?
        AND EXISTS (SELECT 1 FROM wardrobe_members WHERE wardrobe_id = ? AND email = ?)
      `).bind(wardrobe, hash, wardrobe, user.email).first();
      if (!record) throw problem(404,'Photo not found');
      const object=await env.PHOTOS.get(key);if(!object)throw problem(404,'Photo not found');
      return new Response(object.body,{headers:{'Content-Type':'image/jpeg','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
    }
    if(request.method!=='PUT')throw problem(405,'Use PUT for photo uploads');
    if(request.headers.get('Content-Type')!=='image/jpeg')throw problem(415,'Upload a JPEG');
    const bytes=await readBounded(request,MAX_PHOTO);
    if(bytes.length<4||bytes[0]!==255||bytes[1]!==216||bytes[2]!==255)throw problem(400,'Invalid JPEG');
    if(await photoHash(bytes)!==hash)throw problem(400,'Photo checksum mismatch');
    if (!await findMembership(db, wardrobe, user.email)) throw problem(404,'Wardrobe unavailable');
    if(!await env.PHOTOS.head(key))await env.PHOTOS.put(key,bytes,{httpMetadata:{contentType:'image/jpeg'}});
    // A leave can complete while R2 is writing. A deleted wardrobe's namespace is never reused.
    if (!await db.prepare('SELECT 1 FROM wardrobes WHERE id = ?').bind(wardrobe).first()) {
      await db.prepare('INSERT OR REPLACE INTO wardrobe_photo_cleanup (wardrobe_id) VALUES (?)').bind(wardrobe).run();
      ctx.waitUntil(cleanWardrobePhotos(env).catch(error => console.error('Wardrobe photo cleanup failed', error)));
      throw problem(404,'Wardrobe unavailable');
    }
    return json({hash});
  }
  const input = await readJson(request);
  if(!input||!Array.isArray(input.records)||input.records.length>25||!Number.isSafeInteger(input.cursor??0)||(input.cursor??0)<0)throw problem(400,'Invalid sync batch');
  let records;try{records=input.records.map(validateRecord);}catch(e){throw problem(400,e.message);}
  const uniquePhotos=[...new Set(records.filter(r=>r.type==='garment'&&r.photoHash).map(r=>r.photoHash))];
  for(const hash of uniquePhotos)if(!await env.PHOTOS.head(photoKey(wardrobe, hash)))throw problem(409,'Upload garment photos before syncing');
  if (records.length) {
    try {
      const writes = await db.batch(records.map(r => db.prepare(`
        INSERT INTO wardrobe_records (wardrobe_id, id, body, actor_id, actor_name)
        SELECT wardrobe_id, ?, ?, ?, ? FROM wardrobe_members WHERE wardrobe_id = ? AND email = ?
        ON CONFLICT (wardrobe_id, id) DO UPDATE SET body = excluded.body
      `).bind(r.id, JSON.stringify(r), user.id, user.name, wardrobe, user.email)));
      if (!writes[0].meta.changes) throw problem(404,'Wardrobe unavailable');
    } catch (error) {
      if (String(error).includes('record_id_conflict')) throw problem(409,'Record id already exists with different content');
      throw error;
    }
  }
  const cursor=input.cursor??0;
  const {results}=await db.prepare(`
    SELECT seq, body, actor_id, actor_name FROM wardrobe_records WHERE wardrobe_id = ? AND seq > ?
    AND EXISTS (SELECT 1 FROM wardrobe_members WHERE wardrobe_id = ? AND email = ?) ORDER BY seq LIMIT 201
  `).bind(wardrobe, cursor, wardrobe, user.email).all();
  const rows=results.slice(0,200);
  const incoming = rows.map(row => ({
    ...JSON.parse(row.body),
    ...(row.actor_id ? {actor: {id: row.actor_id, name: row.actor_name}} : {})
  }));
  return json({version:3,records:incoming,acknowledged:records.map(r=>r.id),cursor:rows.at(-1)?.seq??cursor,hasMore:results.length>200});
}

export default {
  async scheduled(_event, env) {
    await cleanWardrobePhotos(env);
    await env.DB.prepare('DELETE FROM wardrobe_invites WHERE expires_at <= ?').bind(Date.now()).run();
  },
  async fetch(request,env,ctx) {
    try{return await handle(request,env,ctx);}
    catch(e){if(!e.status)console.error(JSON.stringify({event:'request_failed',path:new URL(request.url).pathname,message:String(e)}));return json({error:e.status?e.message:'Server error; your pending changes are safe'},e.status||500);}
  }
};
