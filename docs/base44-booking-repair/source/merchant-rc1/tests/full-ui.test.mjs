import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {transform} from '../candidate/node_modules/esbuild/lib/main.js';
const source=fs.readFileSync(new URL('../candidate/src/pages/dashboard/Track.jsx',import.meta.url),'utf8');
function flatten(node){if(!node||typeof node!=='object')return [];return [node,...(node.children||[]).flat(Infinity).flatMap(flatten)];}
function text(node){if(typeof node==='string'||typeof node==='number')return String(node);if(!node)return '';return (node.children||[]).flat(Infinity).map(text).join('');}
async function renderTrack(invoke){
 const updated={};let index=0;
 const seed=[[{id:'a'},{id:'b'}],'',{status:'',service_level:'',from:'',to:''},{id:'a'},[],'timeline',false,false,false,false,new Set(['a','b'])];
 const bindings={React:{Fragment:'fragment'},useState:()=>{const i=index++;return [seed[i],value=>{updated[i]=typeof value==='function'?value(seed[i]):value}];},useEffect:()=>{},
 base44:{functions:{invoke}},readShipments:async()=>seed[0],readShipment:async id=>({id}),readShipmentTimeline:async()=>[],useToast:()=>({toast:()=>{}}),usePlatformLinks:()=>({}),window:{confirm:()=>true},h:(type,props,...children)=>({type,props:props||{},children}),motion:{div:'div'},downloadCsv:()=>{}};
 for(const statement of source.match(/^import.*;$/gm)||[]){const braces=statement.match(/\{([^}]+)\}/);if(braces)for(const name of braces[1].split(',').map(s=>s.trim()))if(!(name in bindings))bindings[name]=()=>null;const def=statement.match(/^import (\w+) from/);if(def&&!(def[1] in bindings))bindings[def[1]]=()=>null;}
 const js=(await transform(source.replace(/^import.*;\n/gm,'').replace('export default function Track','function Track'),{loader:'jsx',jsxFactory:'h'})).code;
 const component=new Function(...Object.keys(bindings),js+';return Track;')(...Object.values(bindings));
 return {tree:component(),updated};
}
test('full Track archive keeps pending records selected and never deletes',async()=>{
 const calls=[];const {tree,updated}=await renderTrack(async(name,body)=>{calls.push({name,body});return {data:{archived:body.shipment_id==='a'}};});
 const button=flatten(tree).find(n=>n.type==='button'&&text(n).trim()==='Archive');assert.ok(button);
 await button.props.onClick();assert.deepEqual([...updated[10]],['b']);assert.deepEqual(calls.map(c=>c.name),['archiveMerchantShipment','archiveMerchantShipment']);
});
test('full Track cancellation supplies reason and preserves pending selection',async()=>{
 const calls=[];const {tree,updated}=await renderTrack(async(name,body)=>{calls.push({name,body});return {data:name==='cancelOrderGate'?{cancellable:true}:body.shipment_id==='a'?{cancelled:true}:{pending:true}};});
 const button=flatten(tree).find(n=>n.type==='button'&&text(n).trim()==='Cancel');await button.props.onClick();assert.deepEqual([...updated[10]],['b']);
 assert.ok(calls.filter(c=>c.name==='cancelOrderOnDomain').every(c=>c.body.reason==='Customer requested cancellation'));
});
async function createFixture(finalizeBody) {
 const full=fs.readFileSync(new URL('../candidate/src/pages/dashboard/CreateShipment.jsx',import.meta.url),'utf8');
 let index=0;const calls=[];const updated={};let finished=0,saved=0;
 const details={intake_method:'dropoff',origin_address:'Synthetic origin',destination_address:'Synthetic destination',origin_city:'A',destination_city:'B',weight_lb:1,length_in:1,width_in:1,height_in:1,service_level:'standard',payment_method_id:'pm_unit',compliance:{}};
 const seed=[8,false,null,{id:'m'},null,'',0,false,{1:{valid:true}},details,{canProceed:true,result:{status:'permitted'},declarationChecked:true},{open:false},{ready:true,loading:false},{quote_id:'quote',total:1}];
 const bindings={React:{Fragment:'fragment'},useCallback:f=>f,useEffect:()=>{},useState:()=>{const i=index++;return [seed[i],v=>updated[i]=v];},
 useShipmentDraft:()=>({draftId:'existing-draft',saveNow:async()=>{saved++;return 'existing-draft';},finishBooking:()=>finished++,startNew:()=>{}}),
 useToast:()=>({toast:()=>{}}),SHIPMENT_STEPS:Array(9).fill('Step'),lastStepIndex:8,base44:{functions:{invoke:async(name,body)=>{calls.push({name,body});if(name==='finalizeShipment')return {data:finalizeBody};throw new Error('unexpected effect: '+name);}},entities:new Proxy({}, {get:()=>{throw new Error('Unexpected direct entity access');}})},h:(type,props,...children)=>({type,props:props||{},children})};
 for(const statement of full.match(/^import.*;$/gm)||[]){const braces=statement.match(/\{([^}]+)\}/);if(braces)for(const name of braces[1].split(',').map(s=>s.trim()))if(!(name in bindings))bindings[name]=()=>null;const def=statement.match(/^import (\w+) from/);if(def&&!(def[1] in bindings))bindings[def[1]]=()=>null;}
 const js=(await transform(full.replace(/^import.*;\n/gm,'').replace('export default function CreateShipment','function CreateShipment'),{loader:'jsx',jsxFactory:'h'})).code;
 const component=new Function(...Object.keys(bindings),js+';return CreateShipment;')(...Object.values(bindings));const tree=component();
 const button=flatten(tree).find(n=>n.type==='button'&&text(n).includes('Create shipment'));assert.ok(button);await button.props.onClick();return {calls,updated,finished,saved};
}
test('full CreateShipment pending response keeps draft and emits no operational/financial effects',async()=>{
 const f=await createFixture({pending:true,reason:'reconciliation_required'});assert.equal(f.saved,1);assert.equal(f.finished,0);assert.equal(f.updated[2],undefined);assert.deepEqual(f.calls.map(c=>c.name),['finalizeShipment']);
 const payload=f.calls[0].body;assert.equal(payload.draft_id,'existing-draft');assert.equal(payload.shipment.command_id,undefined);assert.equal(payload.shipment.tracking_number,undefined);assert.equal(payload.shipment.order_id,undefined);
});
