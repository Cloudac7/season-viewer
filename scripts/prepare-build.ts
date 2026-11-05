import {spawnSync} from 'node:child_process';

/** Run a repository script in a child process and propagate its exit code. */
function run(script:string):void {
  const result=spawnSync(process.execPath,['--import','tsx',script],{stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status??1);
}

// Cloudflare Workers Builds checks out the repository, and the committed weather
// snapshots only change when someone refreshes them. Seed the live snapshots
// before precomputing so a code-only build cannot roll back the daily
// Open-Meteo refresh performed by the scheduled GitHub workflow.
const workersBuild=Boolean(process.env.WORKERS_CI||process.env.WORKERS_CI_BRANCH||process.env.WORKERS_CI_COMMIT_SHA);
if(workersBuild){
  console.log('Cloudflare Workers Build: seeding current live weather snapshots before precompute');
  run('scripts/seed-production-weather.ts');
}
run('scripts/precompute-spatial.ts');
