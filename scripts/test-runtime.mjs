import {Miniflare} from 'miniflare';
import {readFile} from 'node:fs/promises';
export async function runtime({port=0,persist=false,auth=false,jwks=null,legacyMembers=auth?'':'local@example.com'}={}) {
 const config={
  name:'wearlog',compatibilityDate:'2026-11-18',
  manifest:{mainModule:'worker.js',modules:{'worker.js':{type:'esm',contents:await readFile('.cloudflare/output/v1/workers/default/bundle/index.js','utf8')}}},
  env:{DB:{type:'d1',name:'wearlog'},PHOTOS:{type:'r2',name:'wearlog-photos'},ASSETS:{type:'assets'},LEGACY_MEMBERS:{type:'text',value:legacyMembers},LOCAL_DEV:{type:'text',value:auth?'false':'true'},ACCESS_ISSUER:{type:'text',value:'https://test.cloudflareaccess.com'},ACCESS_AUD:{type:'text',value:'test-audience'}},
  assets:{directory:new URL('../web',import.meta.url).pathname,runWorkerFirst:['/api/*','/auth/*'],hasUserWorker:true},
 };
 const mf=new Miniflare({workers:[{config,...(jwks?{dev:{outboundService:{type:'fetcher',handler:()=>Response.json(jwks)}}}:{})}],host:'127.0.0.1',port,logRequests:false});
 const db=await mf.getD1Database('DB');
 const sql=await readFile('migrations/0001_records.sql','utf8');
 // D1 exec expects each statement on one line; batch the schema and trigger separately.
 await db.batch([db.prepare(sql.slice(0,sql.indexOf('--'))),db.prepare(sql.slice(sql.indexOf('CREATE TRIGGER')))]);
 const wardrobes = await readFile('migrations/0002_wardrobes.sql', 'utf8');
 await db.batch(wardrobes.trim().split(/(?<=;)\s*(?=CREATE)/).map(statement => db.prepare(statement)));
 return mf;
}
if(process.argv[1]?.endsWith('test-runtime.mjs')) {
 const mf=await runtime({port:Number(process.env.PORT||8765)});
 console.log('Wearlog test server ready at '+await mf.ready);
 for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{await mf.dispose();process.exit(0);});
}
