import type Database from 'better-sqlite3';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Worker } from 'node:worker_threads';
import { requireUpgrade, UpgradeError } from './upgrade-trust';

// This fixed worker runs only the API's own SQLite module and read-only SQL.
// Whole-database scans must not hold the short migration writer transaction or
// block the Coordinator's HTTP/fence-renewal event loop.
const SOURCE = `
const {parentPort,workerData}=require('node:worker_threads');
const fs=require('node:fs');
let db;
try {
  const stat=fs.lstatSync(workerData.filename);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.dev!==workerData.dev||stat.ino!==workerData.ino)throw Error('identity');
  const D=require(workerData.modulePath);
  db=new D(workerData.filename,{readonly:true,fileMustExist:true});
  db.pragma('query_only = ON');
  if(!db.readonly||db.pragma('query_only',{simple:true})!==1)throw Error('readonly');
  let valid=false;
  db.transaction(()=>{
    const integrity=db.pragma('quick_check',{simple:true})==='ok';
    let foreignKeys=true;
    for(const _ of db.prepare('PRAGMA foreign_key_check').iterate()){foreignKeys=false;break;}
    valid=integrity&&foreignKeys;
  })();
  const after=fs.lstatSync(workerData.filename);
  if(!after.isFile()||after.isSymbolicLink()||after.dev!==workerData.dev||after.ino!==workerData.ino)throw Error('identity');
  db.close();db=undefined;
  parentPort.postMessage({valid});
} catch {
  if(db){try{db.close()}catch{}}
  parentPort.postMessage({unavailable:true});
}
`;

/** Request termination after 20 seconds and settle only once the independent
 * worker has exited. Native SQLite code can defer that exit; the main event
 * loop stays responsive throughout. No writer handle is passed to the worker.
 */
export async function verifyMigrationDatabaseIntegrity(sqlite: Database.Database): Promise<void> {
  try {
    await verify(sqlite);
  } catch (error) {
    if (error instanceof UpgradeError) throw error;
    throw new UpgradeError('GLOBAL_SCHEMA_INTEGRITY_UNAVAILABLE');
  }
}
async function verify(sqlite: Database.Database): Promise<void> {
  requireUpgrade(isAbsolute(sqlite.name), 'GLOBAL_SCHEMA_DATABASE_FILE_REQUIRED');
  const filename = await realpath(sqlite.name);
  const before = await lstat(filename);
  requireUpgrade(before.isFile() && !before.isSymbolicLink(), 'GLOBAL_SCHEMA_DATABASE_CHANGED');
  const worker = new Worker(SOURCE, {
    eval: true,
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 32 },
    workerData: {
      filename,
      dev: before.dev,
      ino: before.ino,
      modulePath: require.resolve('better-sqlite3'),
    },
  });
  await new Promise<void>((resolve, reject) => {
    let outcome: 'valid' | 'invalid' | 'unavailable' | 'timeout' = 'unavailable';
    const timeout = setTimeout(() => {
      outcome = 'timeout';
      // This requests termination; a native SQLite call may finish before the
      // worker can exit and release its read snapshot. Wait for that real exit.
      void worker.terminate();
    }, 20_000);
    worker.on('message', (message: unknown) => {
      if (outcome === 'timeout') return;
      const result = message as { valid?: unknown; unavailable?: unknown } | null;
      outcome =
        result?.valid === true ? 'valid' : result?.valid === false ? 'invalid' : 'unavailable';
    });
    worker.on('error', () => {
      if (outcome !== 'timeout') outcome = 'unavailable';
    });
    worker.on('exit', (code) => {
      clearTimeout(timeout);
      if (outcome === 'valid' && code === 0) resolve();
      else
        reject(
          new UpgradeError(
            outcome === 'timeout'
              ? 'GLOBAL_SCHEMA_INTEGRITY_TIMEOUT'
              : outcome === 'invalid'
                ? 'GLOBAL_SCHEMA_INTEGRITY_FAILED'
                : 'GLOBAL_SCHEMA_INTEGRITY_UNAVAILABLE',
          ),
        );
    });
  });
  const after = await lstat(filename);
  requireUpgrade(
    (await realpath(sqlite.name)) === filename &&
      after.isFile() &&
      !after.isSymbolicLink() &&
      after.dev === before.dev &&
      after.ino === before.ino,
    'GLOBAL_SCHEMA_DATABASE_CHANGED',
  );
}
