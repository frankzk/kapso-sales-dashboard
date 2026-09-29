#!/usr/bin/env node
// READ-ONLY backup of the explicitly named production project. Never restores,
// migrates, pauses services, changes credentials or sends notifications.
// node scripts/backup-master-release.mjs --check   (local readiness only)
// node scripts/backup-master-release.mjs --backup (fresh logical backup)
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const bin=resolve(root,'../.performance-tools/postgresql-17.11/pgsql/bin');
const localFile=join(root,'.env.release.local');
const values={};
for(const line of (existsSync(localFile)?readFileSync(localFile,'utf8'):'').split(/\r?\n/)) {
  const match=line.match(/^(PGHOST|PGPORT|PGDATABASE|PGUSER|PGPASSWORD)=(.*)$/);
  if(match)values[match[1]]=match[2];
}
const expected={PGHOST:'aws-1-sa-east-1.pooler.supabase.com',PGPORT:'5432',
  PGDATABASE:'postgres',PGUSER:'postgres.pmihklgtbyuurpkrxtoz'};
const tools=['pg_dump','pg_dumpall','pg_restore'];
const ready=Object.entries(expected).every(([k,v])=>values[k]===v)
  && Boolean(values.PGPASSWORD) && tools.every(name=>existsSync(join(bin,name+'.exe')));
if(process.argv[2]==='--check') {
  console.log(JSON.stringify({project:'pmihklgtbyuurpkrxtoz',readOnly:true,
    connectionParametersMatch:Object.entries(expected).every(([k,v])=>values[k]===v),
    passwordAvailable:Boolean(values.PGPASSWORD),toolsAvailable:tools.every(name=>existsSync(join(bin,name+'.exe'))),ready}));
} else if(process.argv[2]==='--backup') {
  if(!ready)throw new Error('Backup prerequisites missing; use --check. Never paste credentials into chat.');
  const outputRoot=join(root,'.release-backups');mkdirSync(outputRoot,{recursive:true,mode:0o700});
  const directory=join(outputRoot,new Date().toISOString().replaceAll(':','-'));
  mkdirSync(directory,{mode:0o700});
  const environment={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PG/i.test(key))),
    ...values,PGSSLMODE:'require',PGCONNECT_TIMEOUT:'15',PGAPPNAME:'master-release-readonly-backup',
    PGOPTIONS:'-c default_transaction_read_only=on -c lock_timeout=5000 -c statement_timeout=900000'};
  // Credentials are child environment only, never CLI arguments or reports.
  function run(name,args) {
    return new Promise((done,fail)=>{
      let stdout='',stderr='';
      const child=spawn(join(bin,name+'.exe'),args,{env:environment,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
      const timeout=setTimeout(()=>{child.kill();fail(new Error(name+' exceeded 20-minute backup limit'));},1200000);
      child.stdout.on('data',chunk=>{stdout+=chunk;});
      child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4000);});
      child.on('error',error=>{clearTimeout(timeout);fail(error);});
      child.on('exit',code=>{clearTimeout(timeout);code===0?done(stdout):fail(new Error(name+' failed: '+stderr.replaceAll(values.PGPASSWORD,'[redacted]')));});
    });
  }
  async function digest(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
  const partial=join(directory,'database.partial');
  const archive=join(directory,'database.dump');
  const roles=join(directory,'roles.sql');
  const report={project:'pmihklgtbyuurpkrxtoz',startedAt:new Date().toISOString(),readOnly:true,
    complete:false,restoreVerified:false,storageObjectFilesIncluded:false,
    limitation:'Logical database archive includes platform internals. Restore only to a separate compatible Supabase environment first. Never overwrite live production to reverse this migration. Storage file contents and external environment secrets are separate.'};
  try {
    await run('pg_dump',['--no-password','--format=custom','--lock-wait-timeout=5s','--file',partial]);
    assertSize(partial);
    const toc=await run('pg_restore',['--list',partial]);
    for(const table of ['orders','order_master','order_events','shipments','stores'])
      if(!toc.includes('TABLE DATA public '+table+' '))throw new Error('Backup is missing application table '+table);
    await run('pg_dumpall',['--no-password','--roles-only','--no-role-passwords','--file',roles]);
    assertSize(roles);
    writeFileSync(join(directory,'contents.txt'),toc,{mode:0o600});renameSync(partial,archive);
    report.files=await Promise.all([archive,roles].map(async file=>({name:file.split(/[\\/]/).at(-1),bytes:statSync(file).size,sha256:await digest(file)})));
    report.complete=true;
  } catch(error){report.error=String(error.message).replaceAll(values.PGPASSWORD,'[redacted]').slice(0,1600);process.exitCode=1;}
  report.completedAt=new Date().toISOString();writeFileSync(join(directory,'manifest.json'),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify({directory,...report}));
} else {throw new Error('Choose --check or --backup; no other operation is supported.');}
function assertSize(file){if(statSync(file).size<512)throw new Error('Backup output is unexpectedly small');}
