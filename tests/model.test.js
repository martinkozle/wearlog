import test from 'node:test';
import assert from 'node:assert/strict';
import {project, merge} from '../web/model.js';
const garment={id:'g',type:'garment',name:'Blue',group:'Merino'};
const wear=(id,q=1)=>({id,type:'wear',garmentId:'g',quantity:q,wornOn:null});
test('a wash clears only observed wears; delayed offline wear survives',()=>{const records=[garment,wear('a',2),{id:'wash',type:'wash',wearIds:['a']},wear('b')];assert.equal(project(records)[0].count,1);assert.equal(project([records[0],records[3],records[2],records[1]])[0].count,1);});
test('undo wash restores wears and undo wear removes it',()=>{const records=[garment,wear('a',3),{id:'w',type:'wash',wearIds:['a']},{id:'u',type:'undo',eventIds:['w']}];assert.equal(project(records)[0].count,3);records.push({id:'v',type:'undo',eventIds:['a']});assert.equal(project(records)[0].count,0);});
test('retry merge is idempotent and keeps local pending actions',()=>{const a=wear('a'),b=wear('b');const records=merge([garment,a],[a,b]);assert.equal(records.length,3);assert.equal(project(records)[0].count,2);});
