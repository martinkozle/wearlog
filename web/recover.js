import {createUpdater} from './updates.js?v=2026.11.18.6';
const button=document.getElementById('recover'),status=document.getElementById('recovery-status');
const updater=createUpdater({version:document.querySelector('meta[name="app-version"]').content});
button.onclick=async()=>{button.disabled=true;status.textContent='Downloading app update…';try{await updater.apply();}catch(error){status.textContent=error.message;button.disabled=false;}};
