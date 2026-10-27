import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readTestDatabase} from './test-database.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const database=readTestDatabase(process.env,{required:true});
const child=spawn(process.execPath,['--import','./scripts/runtime/test-environment.mjs','--import','tsx','--test','packages/knowledge/test/*.test.ts',
  'packages/adapters/knowledge/test/*.test.ts','packages/analysis/test/knowledge-events.test.ts','apps/api/src/modules/knowledge/*.test.ts',
  'apps/shared/test/knowledge*.test.ts','apps/api/test/knowledge*.test.ts','apps/worker/src/handlers/knowledge/*.test.ts',
  'apps/web/test/knowledge-*.test.ts','apps/web/test/knowledge-*.test.tsx'],
  {cwd:root,env:{...process.env,TEST_DATABASE_URL:database},stdio:'inherit'});
child.on('error',()=>{console.error('Could not start knowledge tests');process.exitCode=1;});
child.on('exit',code=>process.exitCode=code??1);
