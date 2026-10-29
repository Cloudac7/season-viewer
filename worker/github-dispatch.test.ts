import assert from 'node:assert/strict';
import test from 'node:test';
import {dispatchGitHubWorkflow} from './github-dispatch';

test('Cloudflare cron dispatches the production workflow with a repository token', async () => {
  let receivedUrl = '';
  let receivedInit: RequestInit | undefined;

  await dispatchGitHubWorkflow({
    token: 'test-token',
    fetcher: async (input, init) => {
      receivedUrl = String(input);
      receivedInit = init;
      return new Response(null, {status: 204});
    },
  });

  assert.equal(
    receivedUrl,
    'https://api.github.com/repos/Cloudac7/season-viewer/actions/workflows/daily-weather.yml/dispatches',
  );
  assert.equal(receivedInit?.method, 'POST');
  assert.equal(receivedInit?.body, JSON.stringify({ref: 'main'}));
  const headers = new Headers(receivedInit?.headers);
  assert.equal(headers.get('authorization'), 'Bearer test-token');
  assert.equal(headers.get('accept'), 'application/vnd.github+json');
  assert.equal(headers.get('x-github-api-version'), '2022-11-28');
});

test('Cloudflare cron refuses to call GitHub without its dispatch secret', async () => {
  let called = false;
  await assert.rejects(
    dispatchGitHubWorkflow({
      token: ' ',
      fetcher: async () => {
        called = true;
        return new Response(null, {status: 204});
      },
    }),
    /GITHUB_DISPATCH_TOKEN is not configured/,
  );
  assert.equal(called, false);
});

test('Cloudflare cron treats a missing dispatch secret binding like an empty secret', async () => {
  await assert.rejects(
    dispatchGitHubWorkflow({
      fetcher: async () => new Response(null, {status: 204}),
    }),
    /GITHUB_DISPATCH_TOKEN is not configured/,
  );
});

test('Cloudflare cron reports GitHub authorization and API errors', async () => {
  await assert.rejects(
    dispatchGitHubWorkflow({
      token: 'expired-token',
      fetcher: async () => new Response(
        JSON.stringify({message: 'Bad credentials'}),
        {status: 401, headers: {'Content-Type': 'application/json'}},
      ),
    }),
    /GitHub workflow dispatch failed: HTTP 401: Bad credentials/,
  );
});
