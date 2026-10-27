import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readTestDatabase} from './test-database.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const database=readTestDatabase(process.env,{required:true});
const child=spawn(process.execPath,['scripts/runtime/test-core.mjs'],
  {cwd:root,env:{...process.env,TEST_DATABASE_URL:database},stdio:'inherit'});
child.on('error',()=>{console.error('Could not start knowledge tests');process.exitCode=1;});
child.on('exit',code=>process.exitCode=code??1);
