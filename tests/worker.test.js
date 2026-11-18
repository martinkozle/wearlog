import test from 'node:test';
import {generateKeyPair, exportJWK, SignJWT} from 'jose';
import assert from 'node:assert/strict';
import {runtime} from '../scripts/test-runtime.mjs';
import {accountId} from '../src/wardrobes.js';
import {photoHash} from '../web/schema.js';
const garment={id:'g',type:'garment',recordedAt:'2026-11-18T08:00:00Z',name:'Blue',group:'Merino',photoHash:null};
const wear=(id)=>({id,type:'wear',recordedAt:'2026-11-18T09:00:00Z',garmentId:'g',quantity:1,wornOn:null});
const localAccount = await accountId('local@example.com');
const headers={'Content-Type':'application/json','X-Wearlog-Account':localAccount,'X-Wearlog-Wardrobe':'legacy'};
const send=(mf,records,cursor=0)=>mf.dispatchFetch('http://localhost/api/sync',{method:'POST',headers,body:JSON.stringify({records,cursor})});
test('Worker storage and protocol in workerd',async t=>{
 const mf=await runtime();t.after(()=>mf.dispose());
 assert.equal((await mf.dispatchFetch('http://localhost/api/wardrobes')).status,200);
 await t.test('retries are idempotent; cursors pull only new records',async()=>{
  let response=await send(mf,[garment,wear('w')]);assert.equal(response.status,200);const first=await response.json();assert.equal(first.records.length,2);
  response=await send(mf,[wear('w')],first.cursor);const retry=await response.json();assert.equal(retry.records.length,0);assert.deepEqual(retry.acknowledged,['w']);
 });
 await t.test('collision rolls back the entire batch',async()=>{
  const response=await send(mf,[wear('rollback'),{...garment,name:'Conflicting'}]);assert.equal(response.status,409);
  const state=await(await send(mf,[])).json();assert.equal(state.records.some(r=>r.id==='rollback'),false);
 });
 await t.test('invalid dates, quantities and cross-origin writes rejected',async()=>{
  assert.equal((await send(mf,[{...wear('bad'),wornOn:'2026-02-31'}])).status,400);
  assert.equal((await send(mf,[{...wear('bad'),quantity:0}])).status,400);
  assert.equal((await mf.dispatchFetch('http://localhost/api/sync',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:'{"records":[]}'})).status,403);
 });
 await t.test('photo uploads are bounded, content addressed, and outside record JSON',async()=>{
  const bytes=new Uint8Array([255,216,255,224,0,0,255,217]);const hash=await photoHash(bytes);
  let response=await mf.dispatchFetch('http://localhost/api/photos/'+hash,{method:'PUT',headers:{...headers,'Content-Type':'image/jpeg'},body:bytes});assert.equal(response.status,200);
  response=await mf.dispatchFetch('http://localhost/api/photos/'+hash,{headers});assert.equal(response.status,404);
  response=await mf.dispatchFetch('http://localhost/api/photos/'+'0'.repeat(64),{method:'PUT',headers:{...headers,'Content-Type':'image/jpeg'},body:bytes});assert.equal(response.status,400);
  const r={...garment,id:'photo-g',photoHash:hash};assert.equal((await send(mf,[r])).status,200);
  response=await mf.dispatchFetch('http://localhost/api/photos/'+hash,{headers});assert.equal(response.status,200);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),bytes);
  const db=await mf.getD1Database('DB');assert.equal((await db.prepare('SELECT body FROM wardrobe_records WHERE id=?').bind('photo-g').first()).body.includes('base64'),false);
 });
 await t.test('pagination resumes without dropping records',async()=>{
  for(let i=0;i<9;i++)assert.equal((await send(mf,Array.from({length:25},(_,j)=>wear(`page-${i}-${j}`)))).status,200);
  const first=await(await send(mf,[])).json();assert.equal(first.hasMore,true);assert.equal(first.records.length,200);
  const second=await(await send(mf,[],first.cursor)).json();assert.equal(second.hasMore,false);assert.ok(second.records.length>0);
  const ids=[...first.records,...second.records].map(r=>r.id);assert.equal(new Set(ids).size,ids.length);
 });
});
test('production data routes fail closed without an Access JWT',async t=>{
 const mf=await runtime({auth:true});t.after(()=>mf.dispose());
 assert.equal((await send(mf,[])).status,401);
 const response=await mf.dispatchFetch('http://localhost/api/sync',{method:'POST',headers:{...headers,'Cf-Access-Jwt-Assertion':'forged'},body:'{"records":[]}'});assert.equal(response.status,401);
});

test('Access signature, audience and expiry are verified',async t=>{
 const {publicKey,privateKey}=await generateKeyPair('RS256');
 const jwk={...await exportJWK(publicKey),kid:'test-key',alg:'RS256'};
 const mf=await runtime({auth:true,jwks:{keys:[jwk]}});t.after(()=>mf.dispose());
 async function signed(audience,expiry='1h') {return new SignJWT({email:'owner@example.com'}).setProtectedHeader({alg:'RS256',kid:'test-key'}).setIssuer('https://test.cloudflareaccess.com').setAudience(audience).setIssuedAt().setExpirationTime(expiry).sign(privateKey);}
 async function request(token){return mf.dispatchFetch('http://localhost/api/wardrobes',{headers:{'Cf-Access-Jwt-Assertion':token}});}
 assert.equal((await request(await signed('test-audience'))).status,200);
 assert.equal((await request(await signed('wrong-app'))).status,401);
 assert.equal((await request(await signed('test-audience','-1h'))).status,401);
});

test('shared wardrobes migrate, isolate members, attribute history and clean up', async t => {
 const {publicKey, privateKey} = await generateKeyPair('RS256');
 const jwk = {...await exportJWK(publicKey), kid:'wardrobes-key', alg:'RS256'};
 const mf = await runtime({auth:true, jwks:{keys:[jwk]}, legacyMembers:'martin@example.com, friend@example.com'});
 t.after(() => mf.dispose());
 const db = await mf.getD1Database('DB');
 await db.prepare('INSERT INTO records (id, body) VALUES (?, ?)').bind(garment.id, JSON.stringify(garment)).run();
 const photos = await mf.getR2Bucket('PHOTOS');
 const jpeg = new Uint8Array([255,216,255,224,0,0,255,217]);
 const hash = await photoHash(jpeg);
 const oldPhoto = {...garment, id:'old-photo', photoHash:hash};
 await photos.put(hash, jpeg);
 await db.prepare('INSERT INTO records (id, body) VALUES (?, ?)').bind(oldPhoto.id, JSON.stringify(oldPhoto)).run();

 async function client(email) {
  const jwt = await new SignJWT({email}).setProtectedHeader({alg:'RS256',kid:jwk.kid})
   .setIssuer('https://test.cloudflareaccess.com').setAudience('test-audience').setExpirationTime('1h').sign(privateKey);
  const account = await accountId(email);
  return (path, {body, wardrobe, method, bytes, as = account} = {}) => mf.dispatchFetch('http://localhost/api' + path, {
   method: method || (body === undefined ? 'GET' : 'POST'),
   headers: {
    'Cf-Access-Jwt-Assertion':jwt, 'X-Wearlog-Account':as,
    ...(wardrobe ? {'X-Wearlog-Wardrobe':wardrobe} : {}),
    ...(body === undefined ? {} : {'Content-Type':'application/json'}),
    ...(bytes ? {'Content-Type':'image/jpeg'} : {})
   },
   body: bytes || (body === undefined ? undefined : JSON.stringify(body))
  });
 }
 const [martin, friend, guest, outsider] = await Promise.all(
  ['martin', 'friend', 'guest', 'outsider'].map(name => client(name + '@example.com'))
 );
 async function get(request, status = 200) {
  const response = await request;
  assert.equal(response.status, status, status < 400 ? await response.clone().text() : '');
  return response.json();
 }
 const sync = (user, wardrobe, records = []) => user('/sync', {wardrobe, body:{records}});
 const [martinProfile, friendProfile, guestProfile] = await Promise.all([
  get(martin('/wardrobes')), get(friend('/wardrobes')), get(guest('/wardrobes'))
 ]);
 assert.deepEqual(martinProfile.wardrobes, [{id:'legacy', name:'Martin’s Wardrobe'}]);
 assert.deepEqual(friendProfile.wardrobes, martinProfile.wardrobes);
 assert.deepEqual(guestProfile.wardrobes, []);
 assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM records').first()).count, 0);
 const migrated = await get(sync(friend, 'legacy'));
 assert.deepEqual(migrated.records, [garment, oldPhoto]);
 assert.equal((await friend('/photos/' + hash, {wardrobe:'legacy'})).status, 200);
 assert.equal((await guest('/photos/' + hash, {wardrobe:'legacy'})).status, 404);
 const personal = await get(friend('/wardrobes', {body:{name:'Personal'}}), 201);
 assert.equal((await sync(martin, personal.id)).status, 404);
 assert.equal((await sync(friend, 'legacy', [wear('logged')])).status, 200);
 const verified = (await get(sync(martin, 'legacy'))).records.find(record => record.id === 'logged');
 assert.equal(verified.actor.name, 'Friend');
 await get(sync(martin, 'legacy', [{...wear('logged'), actor:{name:'Forged'}}]));
 assert.deepEqual((await get(sync(martin, 'legacy'))).records.find(record => record.id === 'logged'), verified);

 const base = '/wardrobes/legacy';
 const {token} = await get(friend(base + '/invite', {body:{}}), 201);
 assert.match(token, /^[a-z2-9]{8}$/);
 const preview = await get(guest('/invites?token=' + token.toUpperCase()));
 assert.equal(preview.name, 'Martin’s Wardrobe');
 assert.equal(preview.joined, false);
 assert.equal((await sync(guest, 'legacy')).status, 404);
 const joins = await Promise.all([guest, outsider].map(user => user('/invites', {body:{token}})));
 assert.deepEqual(joins.map(response => response.status).sort(), [200,404]);
 const joined = joins[0].ok ? guest : outsider;
 await get(joined('/invites', {body:{token}}));
 assert.equal((await joined('/sync', {wardrobe:'legacy', body:{records:[]}, as:martinProfile.account})).status, 409);
 await get(joined(base + '/leave', {body:{}}));
 await get(friend(base + '/leave', {body:{}}));
 assert.equal((await sync(friend, 'legacy')).status, 404);
 assert.equal((await get(sync(martin, 'legacy'))).records.find(record => record.id === 'logged').actor.name, 'Friend');

 assert.equal((await martin(base + '/leave', {body:{}})).status, 409);
 const otherGarment = {...oldPhoto, name:'Second copy'};
 assert.equal((await friend('/photos/' + hash, {wardrobe:personal.id, method:'PUT', bytes:jpeg})).status, 200);
 await get(sync(friend, personal.id, [otherGarment]));
 await get(martin(base + '/leave', {body:{deleteIfLast:true}}));
 assert.deepEqual((await get(martin('/wardrobes'))).wardrobes, []);
 assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM wardrobe_records WHERE wardrobe_id = 'legacy'").first()).count, 0);
 assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM wardrobe_invites WHERE wardrobe_id = 'legacy'").first()).count, 0);
 assert.equal((await friend('/photos/' + hash, {wardrobe:personal.id})).status, 200);
 for (let tries = 0; tries < 20 && await photos.head(hash); tries++) await new Promise(resolve => setTimeout(resolve, 25));
 assert.equal(await photos.head(hash), null);
});
