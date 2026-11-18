import {defineConfig} from 'vite';
import {cloudflare} from '@cloudflare/vite-plugin';
export default defineConfig({publicDir:'web',plugins:[cloudflare()],server:{host:'127.0.0.1'}});
