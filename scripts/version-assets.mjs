// One version identifies the HTML, module graph, and offline shell for a release.
import {readFile, writeFile} from 'node:fs/promises';
const qrSource = await readFile(new URL(import.meta.resolve('qrcode-generator')), 'utf8');
const notices = await readFile('THIRD_PARTY_NOTICES.md', 'utf8');
await writeFile('web/qrcode.js', '/*\n' + notices + '\n*/\n' + qrSource);
const {version}=JSON.parse(await readFile('web/version.json','utf8'));
if(!/^[a-zA-Z0-9.-]+$/.test(version))throw new Error('Invalid app version');
for(const name of ['index.html','update.html']){
 let text=await readFile('web/'+name,'utf8');
 text=text.replace(/(<meta name="app-version" content=")[^"]*(")/,`$1${version}$2`);
 text=text.replace(/(\/(?:app|recover)\.js|\/style\.css)(?:\?v=[a-zA-Z0-9.-]+)?(?=")/g,`$1?v=${version}`);
 await writeFile('web/'+name,text);
}
for(const name of ['app.js','recover.js']){
 const text=(await readFile('web/'+name,'utf8')).replace(/(from '\.\/(?:model|schema|updates|qrcode)\.js)(?:\?v=[a-zA-Z0-9.-]+)?(')/g,`$1?v=${version}$2`);
 await writeFile('web/'+name,text);
}
const sw=(await readFile('web/sw.js','utf8')).replace(/const VERSION='[^']*';/,`const VERSION='${version}';`);
await writeFile('web/sw.js',sw);
