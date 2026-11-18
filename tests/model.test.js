import test from 'node:test';
import assert from 'node:assert/strict';
import {project, merge, sortGarments} from '../web/model.js';
const garment={id:'g',type:'garment',name:'Blue',group:'Merino'};
const wear=(id,q=1)=>({id,type:'wear',garmentId:'g',quantity:q,wornOn:null});
test('a wash clears only observed wears; delayed offline wear survives',()=>{const records=[garment,wear('a',2),{id:'wash',type:'wash',wearIds:['a']},wear('b')];assert.equal(project(records)[0].count,1);assert.equal(project([records[0],records[3],records[2],records[1]])[0].count,1);});
test('undo wash restores wears and undo wear removes it',()=>{const records=[garment,wear('a',3),{id:'w',type:'wash',wearIds:['a']},{id:'u',type:'undo',eventIds:['w']}];assert.equal(project(records)[0].count,3);records.push({id:'v',type:'undo',eventIds:['a']});assert.equal(project(records)[0].count,0);});
test('retry merge is idempotent and keeps local pending actions',()=>{const a=wear('a'),b=wear('b');const records=merge([garment,a],[a,b]);assert.equal(records.length,3);assert.equal(project(records)[0].count,2);});

test('garment sorting uses dates, current wear counts, and named garments first', () => {
 const garments = [
  {id:'a', name:'Wool 10', count:3, recordedAt:'2026-11-18T10:00:00+02:00'},
  {id:'b', name:'', count:0, recordedAt:'2026-11-18T08:30:00Z'},
  {id:'c', name:'wool 2', count:3, recordedAt:'2026-11-18T09:00:00Z'}
 ];
 const ids = order => sortGarments(garments, order).map(garment => garment.id);
 assert.deepEqual(ids('oldest'), ['a', 'b', 'c']);
 assert.deepEqual(ids('newest'), ['c', 'b', 'a']);
 assert.deepEqual(ids('least'), ['b', 'a', 'c']);
 assert.deepEqual(ids('most'), ['a', 'c', 'b']);
 assert.deepEqual(ids('name'), ['c', 'a', 'b']);
 assert.deepEqual(garments.map(garment => garment.id), ['a', 'b', 'c']);
});
