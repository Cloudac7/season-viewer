import {readFile,readdir,rm} from 'node:fs/promises';
const directory=new URL('../dist/data/precomputed/',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('manifest.json',directory),'utf8')) as {revision:string};
if(!/^[a-f0-9]{20}$/.test(manifest.revision))throw new Error('无效的发布版本，拒绝清理构建缓存');
const entries=await readdir(directory,{withFileTypes:true});
await Promise.all(entries.filter(entry=>entry.isDirectory()&&/^[a-f0-9]{20}$/.test(entry.name)&&entry.name!==manifest.revision).map(entry=>rm(new URL(entry.name+'/',directory),{recursive:true,force:true})));
console.log('Production map assets: '+manifest.revision+' (local precompute caches preserved)');
