import {secrets} from 'base44:runtime';
export function stable(v:any):any {return Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,stable(v[k])])):v;}
export async function digest(v:any) {return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(stable(v)))))].map(x=>x.toString(16).padStart(2,'0')).join('');}
async function mac(v:any) {
 const secret=secrets.get('LEX_OPERATION_SIGNING_SECRET');if(!secret||secret.length<32)throw new Error('operation_signing_not_configured');
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(JSON.stringify(stable(v)))))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export async function seal(kind:string,parent_id:string,document:any) {const data={kind,parent_id,document};return {...data,signature:await mac(data)};}
export async function verified(proof:any,kind:string,parent_id:string) {
 if(!proof||proof.kind!==kind||proof.parent_id!==parent_id||typeof proof.signature!=='string')return false;
 const expected=await mac({kind,parent_id,document:proof.document});if(expected.length!==proof.signature.length)return false;
 let diff=0;for(let i=0;i<expected.length;i++)diff|=expected.charCodeAt(i)^proof.signature.charCodeAt(i);return diff===0;
}
export const absent={$exists:false};
export const expect=(row:any,key:string)=>Object.hasOwn(row,key)?row[key]:absent;
export function rows(value:any):any[] {if(Array.isArray(value))return value;if(Array.isArray(value?.items))return value.items;throw new Error('storage_list_contract_unknown');}
export class EffectsPending extends Error {constructor(public code:string){super(code);}}
export async function cas(entity:any,id:string,where:any,changes:any) {
 let result;try {result=await entity.updateMany({id,...where},{$set:changes});}catch {throw new EffectsPending('cas_outcome_unknown');}
 if(result?.updated===1)return true;if(result?.updated===0)return false;throw new EffectsPending('cas_result_unknown');
}
