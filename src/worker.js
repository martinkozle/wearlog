import {createRemoteJWKSet, jwtVerify} from 'jose';
import {validateRecord, photoHash} from '../web/schema.js';
const MAX_JSON = 256000, MAX_PHOTO = 600000;
const json = (data,status=200) => Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const problem = (status,message) => Object.assign(new Error(message),{status});
const keySets = new Map();
async function authenticate(request,env) {
  const url = new URL(request.url);
  if (env.LOCAL_DEV === 'true' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)) return;
  if (!env.ACCESS_ISSUER || !env.ACCESS_AUD) throw problem(503,'Access is not configured');
  const token=request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw problem(401,'Sign in to sync');
  try {
    const issuer=env.ACCESS_ISSUER;
    if (!keySets.has(issuer)) keySets.set(issuer,createRemoteJWKSet(new URL(issuer+'/cdn-cgi/access/certs')));
    await jwtVerify(token,keySets.get(issuer),{issuer,audience:env.ACCESS_AUD,algorithms:['RS256']});
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
async function handle(request,env) {
  const url=new URL(request.url),path=url.pathname;
  if(path==='/api/health')return json({status:'ok'});
  if(path==='/auth/resume')return new Response(null,{status:303,headers:{Location:'/', 'Cache-Control':'no-store'}});
  // Cloudflare Access protects the shell; validate its signed assertion on all data routes too.
  if(!path.startsWith('/api/'))return env.ASSETS.fetch(request);
  await authenticate(request,env);
  if(!['GET','POST','PUT'].includes(request.method))throw problem(405,'Method not allowed');
  if(request.method!=='GET') {
    const origin=request.headers.get('Origin');
    if(origin && origin!==url.origin)throw problem(403,'Cross-origin writes are not allowed');
    if(request.headers.get('Sec-Fetch-Site')==='cross-site')throw problem(403,'Cross-origin writes are not allowed');
  }
  const photo=path.match(/^\/api\/photos\/([a-f0-9]{64})$/);
  if(photo) {
    if(request.method==='GET') {
      const object=await env.PHOTOS.get(photo[1]);if(!object)throw problem(404,'Photo not found');
      return new Response(object.body,{headers:{'Content-Type':'image/jpeg','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
    }
    if(request.method!=='PUT')throw problem(405,'Use PUT for photo uploads');
    if(request.headers.get('Content-Type')!=='image/jpeg')throw problem(415,'Upload a JPEG');
    const bytes=await readBounded(request,MAX_PHOTO);
    if(bytes.length<4||bytes[0]!==255||bytes[1]!==216||bytes[2]!==255)throw problem(400,'Invalid JPEG');
    if(await photoHash(bytes)!==photo[1])throw problem(400,'Photo checksum mismatch');
    if(!await env.PHOTOS.head(photo[1]))await env.PHOTOS.put(photo[1],bytes,{httpMetadata:{contentType:'image/jpeg'}});
    return json({hash:photo[1]});
  }
  if(path!=='/api/sync'||request.method!=='POST')throw problem(404,'Not found');
  if(request.headers.get('Content-Type')?.split(';')[0]!=='application/json')throw problem(415,'Use application/json');
  let input;try{input=JSON.parse(new TextDecoder().decode(await readBounded(request,MAX_JSON)));}catch(e){if(e.status)throw e;throw problem(400,'Invalid JSON');}
  if(!input||!Array.isArray(input.records)||input.records.length>25||!Number.isSafeInteger(input.cursor??0)||(input.cursor??0)<0)throw problem(400,'Invalid sync batch');
  let records;try{records=input.records.map(validateRecord);}catch(e){throw problem(400,e.message);}
  const uniquePhotos=[...new Set(records.filter(r=>r.type==='garment'&&r.photoHash).map(r=>r.photoHash))];
  for(const hash of uniquePhotos)if(!await env.PHOTOS.head(hash))throw problem(409,'Upload garment photos before syncing');
  const db=env.DB.withSession('first-primary');
  if(records.length) {
    try{await db.batch(records.map(r=>db.prepare('INSERT INTO records(id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').bind(r.id,JSON.stringify(r))));}
    catch(e){if(String(e).includes('record_id_conflict'))throw problem(409,'Record id already exists with different content');throw e;}
  }
  const cursor=input.cursor??0;
  const {results}=await db.prepare('SELECT seq,body FROM records WHERE seq>? ORDER BY seq LIMIT 201').bind(cursor).all();
  const rows=results.slice(0,200);
  return json({version:2,records:rows.map(r=>JSON.parse(r.body)),acknowledged:records.map(r=>r.id),cursor:rows.at(-1)?.seq??cursor,hasMore:results.length>200});
}
export default {
  async fetch(request,env) {
    try{return await handle(request,env);}
    catch(e){if(!e.status)console.error(JSON.stringify({event:'request_failed',path:new URL(request.url).pathname,message:String(e)}));return json({error:e.status?e.message:'Server error; your pending changes are safe'},e.status||500);}
  }
};
