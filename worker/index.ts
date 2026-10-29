import {dispatchGitHubWorkflow} from './github-dispatch';

interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  ASSETS: AssetFetcher;
  GITHUB_DISPATCH_TOKEN?: string;
}

interface ScheduledController {
  cron: string;
  scheduledTime: number;
}

const DAILY_REFRESH_CRON = '0 1 * * *';

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return env.ASSETS.fetch(request);
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
  ): Promise<void> {
    if (controller.cron !== DAILY_REFRESH_CRON) {
      console.warn(`Ignoring unexpected Cloudflare cron: ${controller.cron}`);
      return;
    }

    await dispatchGitHubWorkflow({token: env.GITHUB_DISPATCH_TOKEN});
    console.log(JSON.stringify({
      event: 'github_workflow_dispatched',
      repository: 'Cloudac7/season-viewer',
      workflow: 'daily-weather.yml',
      ref: 'main',
      scheduledTime: controller.scheduledTime,
    }));
  },
};
