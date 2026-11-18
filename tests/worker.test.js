import test from 'node:test';
import {generateKeyPair, exportJWK, SignJWT} from 'jose';
import assert from 'node:assert/strict';
import {runtime} from '../scripts/test-runtime.mjs';
import {photoHash} from '../web/schema.js';
const garment={id:'g',type:'garment',recordedAt:'2026-11-18T08:00:00Z',name:'Blue',group:'Merino',photoHash:null};
const wear=(id)=>({id,type:'wear',recordedAt:'2026-11-18T09:00:00Z',garmentId:'g',quantity:1,wornOn:null});
const headers={'Content-Type':'application/json'};
const send=(mf,records,cursor=0)=>mf.dispatchFetch('http://localhost/api/sync',{method:'POST',headers,body:JSON.stringify({records,cursor})});
test('Worker storage and protocol in workerd',async t=>{
 const mf=await runtime();t.after(()=>mf.dispose());
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
  let response=await mf.dispatchFetch('http://localhost/api/photos/'+hash,{method:'PUT',headers:{'Content-Type':'image/jpeg'},body:bytes});assert.equal(response.status,200);
  response=await mf.dispatchFetch('http://localhost/api/photos/'+hash);assert.equal(response.status,200);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),bytes);
  response=await mf.dispatchFetch('http://localhost/api/photos/'+'0'.repeat(64),{method:'PUT',headers:{'Content-Type':'image/jpeg'},body:bytes});assert.equal(response.status,400);
  const r={...garment,id:'photo-g',photoHash:hash};assert.equal((await send(mf,[r])).status,200);
  const db=await mf.getD1Database('DB');assert.equal((await db.prepare('SELECT body FROM records WHERE id=?').bind('photo-g').first()).body.includes('base64'),false);
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
 async function request(token){return mf.dispatchFetch('http://localhost/api/sync',{method:'POST',headers:{...headers,'Cf-Access-Jwt-Assertion':token},body:'{"records":[]}'});}
 assert.equal((await request(await signed('test-audience'))).status,200);
 assert.equal((await request(await signed('wrong-app'))).status,401);
 assert.equal((await request(await signed('test-audience','-1h'))).status,401);
});
