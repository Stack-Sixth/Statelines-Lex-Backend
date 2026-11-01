import {findExceptionByMerchant,EXCEPTION_BUSINESSES} from './bookingException.ts';
export function syntheticPaymentDenied(merchant:any) {
 return !!merchant&&!!findExceptionByMerchant({local_merchant_id:merchant.id});
}
// Wallet endpoints have account scope and no business selector. Never infer a
// production business context for an approved synthetic account's money call.
export async function syntheticWalletDenied(sr:any,user_id:string) {
 for(const entry of EXCEPTION_BUSINESSES) {
  if(entry.approved_user_id!==user_id||!entry.local_merchant_id)continue;
  const row=await sr.entities.Merchant.get(entry.local_merchant_id);
  if(row?.created_by_id!==user_id)throw new Error('Synthetic wallet ownership unresolved');
  return true;
 }
 return false;
}
