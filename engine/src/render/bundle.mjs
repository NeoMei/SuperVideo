import {build} from 'esbuild';
import {cp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {VERSION} from 'remotion/version';
const vendorDir=fileURLToPath(new URL('../../vendor/remotion/',import.meta.url));
const packageRoot=fileURLToPath(new URL('../../',import.meta.url));
// Maintainer-reviewed anchor: updating vendor provenance requires an explicit code review.
const provenanceSha256='89fe6203102e133122d5ad33f5da8f1295c4527cf86fcf8796cc1cd368037717';
const json=value=>JSON.stringify(value).replace(/</g,'\\u003c');

/** Compile only the renderer entry and the approved project component closure. */
export async function bundle({entryPoint,publicDir,outDir,rootDir=packageRoot}) {
  const provenanceBytes=await readFile(join(vendorDir,'provenance.json'));
  if(createHash('sha256').update(provenanceBytes).digest('hex')!==provenanceSha256)throw Error('Vendored Remotion provenance integrity mismatch');
  const provenance=JSON.parse(provenanceBytes.toString('utf8'));
  if(VERSION!==provenance.version)throw Error(`Headless entry requires Remotion ${provenance.version}; found ${VERSION}`);
  for(const [file,expected]of Object.entries(provenance.files)) {
    const actual=createHash('sha256').update(await readFile(join(vendorDir,file))).digest('hex');
    if(actual!==expected)throw Error(`Vendored Remotion integrity mismatch: ${file}`);
  }
  await mkdir(outDir,{recursive:true});
  const result=await build({
    stdin:{contents:`import 'supervideo:react-global';import ${json(join(vendorDir,'render-entry.mjs'))};import ${json(resolve(entryPoint))};import {initializePreview} from ${json(join(packageRoot,'src/render/preview.tsx'))};initializePreview();`,resolveDir:rootDir,sourcefile:'supervideo-render-entry.tsx',loader:'tsx'},
    outfile:join(outDir,'bundle.js'),bundle:true,platform:'browser',format:'iife',target:'chrome100',
    jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},minify:true,metafile:true,logLevel:'silent',
    assetNames:'assets/[name]-[hash]',loader:{'.png':'file','.jpg':'file','.jpeg':'file','.gif':'file','.svg':'file','.webp':'file','.avif':'file','.mp4':'file','.webm':'file','.mp3':'file','.wav':'file','.woff':'file','.woff2':'file'},
    nodePaths:[join(rootDir,'node_modules')],
    plugins:[{name:'single-react-remotion-context',setup(builder){
      builder.onResolve({filter:/^supervideo:react-global$/},()=>({path:'react-global',namespace:'supervideo'}));
      builder.onLoad({filter:/.*/,namespace:'supervideo'},()=>({contents:"import React from 'react';globalThis.React=React;",resolveDir:rootDir,loader:'js'}));
      builder.onResolve({filter:/^(react|react-dom|remotion)(\/.*)?$/},async args=>{
        if(args.pluginData?.deduplicated)return;
        return builder.resolve(args.path,{resolveDir:rootDir,kind:args.kind,pluginData:{deduplicated:true}});
      });
    }}],
  });
  if(publicDir)await cp(publicDir,join(outDir,'public'),{recursive:true});
  await writeFile(join(outDir,'bundle-meta.json'),JSON.stringify(result.metafile));
  const css=Object.keys(result.metafile.outputs).some(path=>path.endsWith('.css'))?'<link rel="stylesheet" href="./bundle.css">':'';
  await writeFile(join(outDir,'index.html'),`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${css}<link rel="icon" href="data:,"><title>SuperVideo renderer</title></head><body>
<script>
window.siteVersion='11';window.remotion_version=${json(VERSION)};
window.remotion_staticBase=new URL('./public',window.location.href).pathname;
window.remotion_staticFiles=[];window.remotion_publicFolderExists=window.remotion_staticBase;
window.remotion_publicPath='./';window.remotion_numberOfAudioTags=0;
window.remotion_audioLatencyHint='playback';window.remotion_experimentalKeepAudioContextAlive=false;
window.remotion_previewSampleRate=window.remotion_sampleRate??48000;
window.remotion_audioEnabled??=true;window.remotion_videoEnabled??=true;
window.process??={};window.process.env??={};window.process.env.NODE_ENV='production';
</script><div id="video-container"></div><div id="__remotion-studio-container"></div><script src="./bundle.js"></script></body></html>`);
  return outDir;
}
