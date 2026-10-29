const GITHUB_API_VERSION = '2022-11-28';
const DEFAULT_REPOSITORY = 'Cloudac7/season-viewer';
const DEFAULT_WORKFLOW = 'daily-weather.yml';
const DEFAULT_REF = 'main';

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface DispatchGitHubWorkflowOptions {
  token?: string;
  repository?: string;
  workflow?: string;
  ref?: string;
  fetcher?: FetchLike;
}

function githubErrorMessage(value: string): string {
  try {
    const body = JSON.parse(value) as {message?: unknown};
    if (typeof body.message === 'string' && body.message.trim()) return body.message.trim();
  } catch {
    // Fall back to a bounded plain-text response below.
  }
  return value.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** Dispatch the production refresh workflow using a repository-scoped token. */
export async function dispatchGitHubWorkflow(
  options: DispatchGitHubWorkflowOptions,
): Promise<void> {
  const token = options.token?.trim();
  if (!token) throw new Error('GITHUB_DISPATCH_TOKEN is not configured');

  const repository = options.repository ?? DEFAULT_REPOSITORY;
  const workflow = options.workflow ?? DEFAULT_WORKFLOW;
  const ref = options.ref ?? DEFAULT_REF;
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(
    `https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'season-atlas-cloudflare-cron',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      },
      body: JSON.stringify({ref}),
    },
  );

  if (!response.ok) {
    const detail = githubErrorMessage(await response.text());
    throw new Error(
      `GitHub workflow dispatch failed: HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
    );
  }
}
