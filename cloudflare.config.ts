import {bindings, defineConfig, triggers} from 'cf/config';
export default defineConfig(({mode}) => ({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  worker: {
    name: 'wearlog',
    entrypoint: './src/worker.js',
    compatibilityDate: '2026-11-18',
    workersDev: true,
    previewUrls: false,
    triggers: [triggers.scheduled({schedule:'*/15 * * * *'})],
    domains: process.env.WEARLOG_HOSTNAME ? [process.env.WEARLOG_HOSTNAME] : undefined,
    assets: {runWorkerFirst: ['/api/*','/auth/*']},
    env: {
      DB: bindings.d1({name:'wearlog',id:mode==='development'?'00000000-0000-4000-8000-000000000001':process.env.WEARLOG_D1_ID}),
      PHOTOS: bindings.r2({name:process.env.WEARLOG_R2_BUCKET || 'wearlog-photos'}),
      ASSETS: bindings.assets(),
      ACCESS_ISSUER: bindings.text(process.env.WEARLOG_ACCESS_ISSUER || ''),
      ACCESS_AUD: bindings.text(process.env.WEARLOG_ACCESS_AUD || ''),
      LEGACY_MEMBERS: bindings.text(process.env.WEARLOG_LEGACY_MEMBERS || ''),
      LOCAL_DEV: bindings.text(mode==='development'?'true':'false'),
    },
    observability: {enabled:true,traces:{enabled:true,headSamplingRate:0.1}},
  },
}));
