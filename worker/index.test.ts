import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './index';

test('every configured Cron event dispatches the production workflow', async (t) => {
  let receivedUrl = '';
  let receivedInit: RequestInit | undefined;

  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    receivedUrl = String(input);
    receivedInit = init;
    return new Response(null, {status: 204});
  });
  t.mock.method(console, 'log', () => undefined);

  await worker.scheduled(
    {cron: '23 7 29 10 *', scheduledTime: 1_790_000_000_000},
    {
      ASSETS: {fetch: async () => new Response(null, {status: 404})},
      GITHUB_DISPATCH_TOKEN: 'test-token',
    },
  );

  assert.equal(
    receivedUrl,
    'https://api.github.com/repos/Cloudac7/season-viewer/actions/workflows/daily-weather.yml/dispatches',
  );
  assert.equal(receivedInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(receivedInit?.body)), {ref: 'main'});
  assert.equal(new Headers(receivedInit?.headers).get('authorization'), 'Bearer test-token');
});
