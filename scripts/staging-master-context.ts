// Explicitly bound to the disposable staging project. Never accepts another URL.
import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
export const STAGING_REF = 'zuloxsrfcwhefedgfcnb';
export const FIXTURE_FILE = '.env.staging-fixture.local';
export function stagingContext() {
  const values: Record<string,string> = {};
  for (const line of readFileSync('.env.local','utf8').split(/\r?\n/)) {
    const m=line.match(/^([A-Z0-9_]+)="(.*)"$/); if(m) values[m[1]!]=m[2]!;
  }
  if(values.NEXT_PUBLIC_SUPABASE_URL!==`https://${STAGING_REF}.supabase.co`) throw new Error('Refusing non-staging destination');
  for(const name of ['NEXT_PUBLIC_SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY']) {
    const token=values[name]?.split('.')[1];
    if(!token) throw new Error('Missing staging credential');
    const payload=JSON.parse(Buffer.from(token,'base64url').toString());
    if(payload.ref!==STAGING_REF) throw new Error('Wrong project credential');
  }
  const client=(key:string)=>createClient(values.NEXT_PUBLIC_SUPABASE_URL!,key,{auth:{persistSession:false,autoRefreshToken:false}});
  return {admin:client(values.SUPABASE_SERVICE_ROLE_KEY!), user:()=>client(values.NEXT_PUBLIC_SUPABASE_ANON_KEY!), url:values.NEXT_PUBLIC_SUPABASE_URL!, anon:values.NEXT_PUBLIC_SUPABASE_ANON_KEY!};
}
export function checked<T extends {data:any;error:any}>(result:T, label:string):NonNullable<T['data']> {
  if(result.error) throw new Error(`${label}: ${result.error.code ?? ''} ${result.error.message}`);
  return result.data!;
}
export function saveFixture(value:unknown) { writeFileSync(FIXTURE_FILE,JSON.stringify(value,null,2),{mode:0o600}); }
export function loadFixture():any { return JSON.parse(readFileSync(FIXTURE_FILE,'utf8')); }
