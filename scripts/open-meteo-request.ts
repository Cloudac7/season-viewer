import {mkdir, readFile, rename, unlink, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {OpenMeteoHttpError, OpenMeteoNetworkError} from '../src/lib/open-meteo';

export type WeatherRequestKind = 'county'|'grid';
export interface UsageEntry { key:string; at:number; cost:number; session?:string }
type Clock = () => number;
type Sleep = (milliseconds:number) => Promise<void>;
interface Options { directory?:URL; dataDirectory?:URL; now?:Clock; sleep?:Sleep; log?:(message:string)=>void; session?:string|null }
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const RATE_LIMIT_RETRY_LIMIT = 2 * MINUTE;
const SNAPSHOT_RECOVERY_WINDOW = 6 * HOUR;
const defaultSleep:Sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const OPEN_METEO_BATCH_SIZE=100;

/** Conservative Open-Meteo call equivalents for multi-location daily requests. */
export function weatherBatchCost(locations:number, pastDays:number, forecastDays=7):number {
  if (!Number.isInteger(locations) || locations < 0 || !Number.isFinite(pastDays) || pastDays < 0 || !Number.isFinite(forecastDays) || forecastDays < 0) throw new Error('Invalid weather batch cost');
  return locations * Math.max(1, (pastDays + forecastDays) / 14);
}

/** Parse Retry-After seconds or HTTP date; missing or invalid hints use one hour. */
export function rateLimitUntil(retryAfter:string|null, now:number):number {
  const delay = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) * 1000 : retryAfter ? Date.parse(retryAfter) - now : HOUR;
  return now + Math.max(MINUTE, Number.isFinite(delay) ? delay : HOUR);
}

export class OpenMeteoQuota {
  private readonly directory:URL;
  private readonly dataDirectory:URL;
  private readonly now:Clock;
  private readonly sleep:Sleep;
  private readonly log:(message:string)=>void;
  private readonly session:string|null;
  private readonly usageFile:URL;
  private readonly backoffFile:URL;

  constructor(options:Options={}) {
    this.directory=options.directory??new URL('../data-sources/',import.meta.url);
    this.dataDirectory=options.dataDirectory??new URL('../public/data/',import.meta.url);
    this.now=options.now??Date.now; this.sleep=options.sleep??defaultSleep; this.log=options.log??console.log;
    const configuredSession=options.session===undefined?process.env.OPEN_METEO_QUOTA_SESSION:options.session;
    this.session=configuredSession?.trim()||null;
    this.usageFile=new URL('weather-grid-usage.json',this.directory);
    this.backoffFile=new URL('weather-grid-backoff.json',this.directory);
  }
  private async atomicJson(file:URL,value:unknown):Promise<void> {
    await mkdir(this.directory,{recursive:true});
    const temporary=new URL(`${file.pathname.split('/').at(-1)}.${randomUUID()}.tmp`,this.directory);
    try { await writeFile(temporary,JSON.stringify(value)); await rename(temporary,file); }
    finally { await unlink(temporary).catch(()=>{}); }
  }
  private async readJson(file:URL):Promise<unknown> {
    try { return JSON.parse(await readFile(file,'utf8')); }
    catch(error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  private async usage():Promise<UsageEntry[]> {
    const now=this.now(), saved=await this.readJson(this.usageFile);
    if(saved!==null&&!Array.isArray(saved))throw new Error('Invalid Open-Meteo usage ledger');
    const usage=new Map<string,UsageEntry>();
    for(const entry of saved??[]) {
      if(!entry||typeof entry.key!=='string'||!Number.isFinite(entry.at)||!Number.isFinite(entry.cost)||entry.cost<=0||entry.session!==undefined&&typeof entry.session!=='string')throw new Error('Invalid Open-Meteo usage ledger entry');
      // A CI session represents a fresh runner and therefore a potentially
      // different Open-Meteo egress IP. Entries from other runs must not be
      // charged to it. Local runs without a session still enforce every recent
      // entry, including scoped entries left by a previous process.
      if(this.session!==null&&entry.session!==this.session)continue;
      if(entry.at>now-DAY)usage.set(entry.key,entry);
    }
    // Scoped CI runs cannot infer calls from restored snapshots: those requests
    // may have originated from another runner/IP, while the county and grid
    // stages within this run already share the scoped ledger file.
    if(this.session!==null)return [...usage.values()];
    // Recover recent successful batches when a runner starts without its cache.
    // Legacy ledgers have per-county and recovered-grid entries; retain them.
    const countyRequests:{at:number;remaining:number}[]=[],gridRequests:{at:number;remaining:number}[]=[];
    for(const entry of usage.values()) {
      const match=entry.key.match(/:n(\d+):/);
      // New entries encode the exact number of requested locations. Older
      // ledgers have only call-equivalents, so assume the 1.5x bootstrap cost.
      const request={at:entry.at,remaining:match?Number(match[1]):Math.floor(entry.cost/1.5)};
      if(entry.key.startsWith('request:county:'))countyRequests.push(request);
      else if(entry.key.startsWith('request:'))gridRequests.push(request);
    }
    for(const [kind,file] of [['county','county-weather.json'],['grid','weather-grid-weather.json']] as const) {
      const snapshot=await this.readJson(new URL(file,this.dataDirectory)) as {records?:Record<string,{updatedAt?:string;lon?:number;lat?:number}>}|null;
      if(!snapshot?.records)continue;
      for(const [id,series] of Object.entries(snapshot.records)) {
        const at=Date.parse(series.updatedAt??'');
        if(!Number.isFinite(at)||at<=now-SNAPSHOT_RECOVERY_WINDOW||at>now)continue;
        const legacy=kind==='county'?`county:${id}:${series.updatedAt}`:`recovered-grid:${series.lon}:${series.lat}:${series.updatedAt}`;
        if(usage.has(legacy))continue;
        const covered=(kind==='county'?countyRequests:gridRequests).find(request=>request.remaining>0&&Math.abs(request.at-at)<120000);
        if(covered)covered.remaining--;
        // A restored successful snapshot cannot reveal whether its request was
        // a 21-day bootstrap. Reserve the conservative 1.5 equivalents per point.
        if(!covered)usage.set(legacy,{key:legacy,at,cost:1.5});
      }
    }
    return [...usage.values()];
  }
  async checkBackoff():Promise<void> {
    const saved=await this.readJson(this.backoffFile) as {until?:unknown;session?:unknown}|null;
    if(saved!==null&&(typeof saved.until!=='number'||!Number.isFinite(saved.until)||saved.session!==undefined&&typeof saved.session!=='string'))throw new Error('Invalid Open-Meteo backoff ledger');
    const applies=this.session===null||saved?.session===this.session;
    if(applies&&saved&&typeof saved.until==='number'&&saved.until>this.now())throw new Error(`Open-Meteo rate-limit cooldown active until ${new Date(saved.until).toISOString()}`);
  }
  async recordRateLimit(retryAfter:string|null):Promise<number> {
    const existing=await this.readJson(this.backoffFile) as {until?:unknown;session?:unknown}|null;
    const now=this.now();
    const previous=this.session===null||existing?.session===this.session;
    const until=Math.max(rateLimitUntil(retryAfter,now),previous&&typeof existing?.until==='number'?existing.until:0);
    await this.atomicJson(this.backoffFile,{until,reason:'Open-Meteo HTTP 429',...(this.session===null?{}:{session:this.session})});
    return Math.max(0,until-now);
  }
  async reserve(kind:WeatherRequestKind,cost:number,locations?:number):Promise<void> {
    if(!Number.isFinite(cost)||cost<=0||cost>570||locations!==undefined&&(!Number.isInteger(locations)||locations<=0||locations>cost))throw new Error('Invalid Open-Meteo batch cost');
    for(;;) {
      await this.checkBackoff();
      const entries=await this.usage(),now=this.now();
      const daily=entries.reduce((sum,entry)=>sum+entry.cost,0);
      const hourly=entries.filter(entry=>entry.at>now-HOUR).reduce((sum,entry)=>sum+entry.cost,0);
      const minutely=entries.filter(entry=>entry.at>now-MINUTE).reduce((sum,entry)=>sum+entry.cost,0);
      if(daily+cost>9900)throw new Error(`Open-Meteo daily budget reserved (${daily.toFixed(1)} + ${cost.toFixed(1)} > 9900); checkpoint retained`);
      if(hourly+cost<=4900&&minutely+cost<=570) {
        entries.push({key:`request:${kind}:${process.pid}:${now}:n${locations??Math.floor(cost/1.5)}:${randomUUID()}`,at:now,cost,...(this.session===null?{}:{session:this.session})});
        await this.atomicJson(this.usageFile,entries); return;
      }
      const window=hourly+cost>4900?HOUR:MINUTE;
      const oldest=entries.filter(entry=>entry.at>now-window).sort((a,b)=>a.at-b.at)[0];
      const delay=Math.min(MINUTE,Math.max(1000,(oldest?.at??now)+window-now+1000));
      this.log(`Open-Meteo quota wait ${Math.ceil(delay/1000)}s (${hourly.toFixed(0)}/hour, ${daily.toFixed(0)}/day)`);
      await this.sleep(delay);
    }
  }
  /** Account for an operator-audited request that is outside this run's hourly window. */
  async reserveExternal(cost:number,key:string):Promise<void> {
    if(!Number.isFinite(cost)||cost<=0||cost>9900||!key.startsWith('external-reserve:'))throw new Error('Invalid external Open-Meteo reservation');
    const entries=await this.usage();
    if(entries.some(entry=>entry.key===key))return;
    entries.push({key,at:this.now()-HOUR-1,cost,...(this.session===null?{}:{session:this.session})});
    await this.atomicJson(this.usageFile,entries);
  }
}

function diagnostic(error:unknown):string {
  if(error instanceof OpenMeteoHttpError)return `HTTP ${error.status}`;
  const cause=error instanceof Error?error.cause:undefined;
  const code=cause&&typeof cause==='object'&&'code' in cause?String((cause as {code:unknown}).code):'';
  const safe=/^[A-Z0-9_]{1,40}$/.test(code)?` ${code}`:'';
  return `${error instanceof Error?error.name:'Error'}${safe}`;
}
export async function runOpenMeteoBatch<T>(options:{quota:OpenMeteoQuota;kind:WeatherRequestKind;cost:number;locations?:number;task:()=>Promise<T>;sleep?:Sleep;log?:(message:string)=>void}):Promise<T> {
  const sleep=options.sleep??defaultSleep,log=options.log??console.log;
  let rateLimitRetried=false;
  for(let attempt=1;attempt<=3;attempt++) {
    await options.quota.reserve(options.kind,options.cost,options.locations);
    try { return await options.task(); }
    catch(error) {
      if(error instanceof OpenMeteoHttpError&&error.status===429) {
        const wait=await options.quota.recordRateLimit(error.retryAfter);
        if(!rateLimitRetried&&attempt<3&&wait<=RATE_LIMIT_RETRY_LIMIT) {
          rateLimitRetried=true;
          const seconds=Math.ceil((wait+1000)/1000);
          log(`Open-Meteo ${options.kind} rate limit; retry once in ${seconds}s`);
          await sleep(wait+1000);
          continue;
        }
        throw error;
      }
      const retryable=error instanceof OpenMeteoNetworkError||error instanceof OpenMeteoHttpError&&error.status>=500&&error.status<=599;
      if(!retryable||attempt===3)throw error;
      const base=attempt===1?10000:30000;
      const delay=base+Math.floor(Math.random()*base*.2);
      log(`Open-Meteo ${options.kind} request ${attempt}/3 failed (${diagnostic(error)}); retry in ${delay/1000}s`);
      await sleep(delay);
    }
  }
  throw new Error('Unreachable retry state');
}
