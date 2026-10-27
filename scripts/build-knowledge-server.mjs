/** Build one server-side knowledge workspace without the root web/video build. */
import {existsSync, rmSync, readdirSync, readFileSync, writeFileSync, statSync} from 'node:fs';
import {resolve, relative, join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {build} from 'esbuild';
const packageRoot=process.cwd();
const repositoryRoot=resolve(import.meta.dirname,'..');
const manifest=JSON.parse(readFileSync(join(packageRoot,'package.json'),'utf8'));
const entryNames=manifest.knowledgeBuildEntries??['index'];
if(!Array.isArray(entryNames)||!entryNames.length||entryNames.some(name=>typeof name!=='string'||!/^[a-z][a-z0-9-]*$/.test(name)))
  throw new Error('Invalid knowledgeBuildEntries manifest list');
const entries=Object.fromEntries(entryNames.map(name=>[name,join(packageRoot,`src/${name}.ts`)]));
for(const source of Object.values(entries))if(!existsSync(source))throw new Error(`Missing package entry: ${source}`);
const output=join(packageRoot,'dist');
rmSync(output,{recursive:true,force:true});
const result=spawnSync(process.execPath,[join(repositoryRoot,'node_modules/typescript/bin/tsc'),'--project',join(packageRoot,'tsconfig.build.json')],{cwd:packageRoot,stdio:'inherit'});
if(result.status!==0)process.exit(result.status??1);
function rewriteDeclarations(directory){
  for(const entry of readdirSync(directory)){
    const path=join(directory,entry);
    if(statSync(path).isDirectory())rewriteDeclarations(path);
    else if(path.endsWith('.d.ts')){
      const text=readFileSync(path,'utf8').replace(/(?<=['"])(\.{1,2}\/[^'"]+)\.ts(?=['"])/g,'$1.js');
      writeFileSync(path,text);
    }
  }
}
rewriteDeclarations(join(output,'types'));
const bundle=await build({entryPoints:entries,outdir:output,entryNames:'[name]',chunkNames:'_chunks/[name]-[hash]',splitting:entryNames.length>1,
  bundle:true,platform:'node',format:'esm',target:'node24',packages:'external',sourcemap:true,metafile:true,logLevel:'warning'});
const bundlePaths=[...Object.keys(bundle.metafile.inputs),...Object.values(bundle.metafile.outputs).flatMap(output=>output.imports.map(item=>item.path))];
const forbidden=bundlePaths.filter(path=>/(?:^|\/)(?:video-analysis|analysis|creation|discovery)(?:\/|$)|@openai\/agents/.test(path));
if(forbidden.length)throw new Error(`Server bundle crossed unrelated business boundaries: ${forbidden.join(', ')}`);
for(const [name,source] of Object.entries(entries)){
  const typeEntry=join(output,'types',relative(repositoryRoot,source)).replace(/\.ts$/,'.d.ts');
  if(!existsSync(typeEntry)||!existsSync(join(output,`${name}.js`)))throw new Error(`Missing build output for ${name}`);
}
process.stdout.write(`Built ${relative(repositoryRoot,packageRoot)} JS and declarations\n`);
