import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { signedQuery, send } from '../src/client.js';
import { approval, event, push, waitingRoom, dataString, defaultDetails } from '../src/commands.js';
import { run } from '../src/main.js';
import { setWriter } from '../src/core.js';

const SECRET = 'shh';

// verify checks a request the way the server does.
function verify(method, url, body) {
  const u = new URL(url, 'http://x');
  const params = Object.fromEntries(u.searchParams);
  const sig = params.auth_signature;
  delete params.auth_signature;
  if (body) assert.equal(params.body_md5, createHash('md5').update(body).digest('hex'));
  const sorted = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  const want = createHmac('sha256', SECRET).update(`${method}\n${u.pathname}\n${sorted}`).digest('hex');
  assert.equal(sig, want, 'signature');
  assert.equal(params.auth_key, 'k');
  return params;
}

async function serve(handler) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body, headers: req.headers });
      const [status, json] = handler(req, body, calls.length);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const host = `http://127.0.0.1:${server.address().port}`;
  return { host, calls, close: () => new Promise((r) => server.close(r)) };
}

function envFor(host, inputs) {
  const dir = mkdtempSync(join(tmpdir(), 'hibira-action-'));
  const env = {
    GITHUB_OUTPUT: join(dir, 'out'),
    GITHUB_STEP_SUMMARY: join(dir, 'summary'),
    GITHUB_REPOSITORY: 'acme/shop',
    GITHUB_RUN_ID: '42',
    GITHUB_SHA: 'abcdef1234567890',
    GITHUB_REF_NAME: 'main',
    GITHUB_ACTOR: 'mei',
    'INPUT_APP-ID': '7',
    INPUT_KEY: 'k',
    INPUT_SECRET: SECRET,
    INPUT_HOST: host,
  };
  writeFileSync(env.GITHUB_OUTPUT, '');
  writeFileSync(env.GITHUB_STEP_SUMMARY, '');
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase()}`] = v;
  return env;
}

function outputs(env) {
  const out = {};
  const lines = readFileSync(env.GITHUB_OUTPUT, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([\w-]+)<<(.+)$/);
    if (m) {
      const val = [];
      for (i++; lines[i] !== m[2]; i++) val.push(lines[i]);
      out[m[1]] = val.join('\n');
    }
  }
  return out;
}

const quietly = async (fn) => {
  const logged = [];
  const prev = setWriter((s) => logged.push(String(s)));
  try {
    return { result: await fn(), logged: logged.join('') };
  } finally {
    setWriter(prev);
  }
};

test('signedQuery matches the Go client', () => {
  // Same inputs as approvals.SignedQuery in github.com/hibira-io/go.
  const qs = signedQuery({ key: 'k', secret: 's', method: 'POST', path: '/apps/1/approvals', body: '{"title":"x"}', now: 1700000000000 });
  const p = new URLSearchParams(qs);
  assert.equal(p.get('body_md5'), createHash('md5').update('{"title":"x"}').digest('hex'));
  assert.equal(p.get('auth_signature'), 'aea334e984a8067f2ea3807203096a4f3ca8d600ffcef16ad973e2019eb1733c');
});

test('approval waits through a question and outputs the decision', async () => {
  const srv = await serve((req, body, n) => {
    verify(req.method, req.url, body || undefined);
    if (req.method === 'POST') {
      const b = JSON.parse(body);
      assert.equal(b.title, 'Deploy v1.2 to production?');
      assert.deepEqual(b.options, ['Ship it', 'Hold']);
      assert.deepEqual(b.push_interests, ['oncall']);
      assert.equal(b.expires_in_minutes, 30);
      assert.match(b.details, /Repository: acme\/shop/);
      assert.match(b.details, /actions\/runs\/42/);
      return [201, { approval_id: 'apr_1', status: 'pending', url: 'https://hibira.io/a/apr_1', options: b.options }];
    }
    assert.match(req.url, /^\/apps\/7\/approvals\/apr_1\?/);
    assert.equal(new URL(req.url, 'http://x').searchParams.get('wait'), '25');
    if (n === 2) {
      return [200, { approval_id: 'apr_1', status: 'pending', awaiting_reply: true, url: 'u', discussion: [{ id: 'm1', from: 'approver', name: 'Bo', text: 'Which region?' }] }];
    }
    return [200, { approval_id: 'apr_1', status: 'approved', url: 'https://hibira.io/a/apr_1', choice: 'Ship it', comment: 'go', answered_by: { email: 'bo@acme.test', name: 'Bo' } }];
  });
  const env = envFor(srv.host, { TITLE: 'Deploy v1.2 to production?', OPTIONS: 'Ship it\nHold', 'PUSH-INTERESTS': 'oncall', 'TIMEOUT-MINUTES': '30' });
  const slept = [];
  const { logged } = await quietly(() => approval({ env, sleep: async (ms) => slept.push(ms) }));
  await srv.close();
  assert.equal(srv.calls.length, 3);
  assert.deepEqual(slept, [5000]);
  assert.match(logged, /Bo asked: Which region\?/);
  const out = outputs(env);
  assert.equal(out.status, 'approved');
  assert.equal(out.choice, 'Ship it');
  assert.equal(out['answered-by'], 'bo@acme.test');
  assert.equal(out['approval-id'], 'apr_1');
  assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /Answer it here\]\(https:\/\/hibira.io\/a\/apr_1\)/);
});

test('a rejected approval fails the step unless fail-on-reject is false', async () => {
  const handler = (req) => [req.method === 'POST' ? 201 : 200, { approval_id: 'apr_2', status: 'rejected', choice: 'Reject', url: 'u' }];
  let srv = await serve(handler);
  await assert.rejects(quietly(() => approval({ env: envFor(srv.host, { TITLE: 'Deploy?' }) })), /Not approved: rejected \(Reject\)/);
  await srv.close();
  srv = await serve(handler);
  const env = envFor(srv.host, { TITLE: 'Deploy?', 'FAIL-ON-REJECT': 'false' });
  await quietly(() => approval({ env }));
  await srv.close();
  assert.equal(outputs(env).status, 'rejected');
});

test('wait: false only opens the request', async () => {
  const srv = await serve(() => [201, { approval_id: 'apr_3', status: 'pending', url: 'https://hibira.io/a/apr_3' }]);
  const env = envFor(srv.host, { TITLE: 'Deploy?', WAIT: 'false' });
  await quietly(() => approval({ env }));
  await srv.close();
  assert.equal(srv.calls.length, 1);
  assert.equal(outputs(env).url, 'https://hibira.io/a/apr_3');
});

test('approval-id waits for an earlier request until it expires', async () => {
  let t = 1_700_000_000_000;
  const srv = await serve((req) => {
    assert.equal(req.method, 'GET');
    assert.match(req.url, /^\/apps\/7\/approvals\/apr_9\?/);
    t += 30_000;
    return [200, { approval_id: 'apr_9', title: 'Deploy?', status: 'pending', url: 'u', expires_at: new Date(1_700_000_000_000 + 60_000).toISOString() }];
  });
  const env = envFor(srv.host, { 'APPROVAL-ID': 'apr_9', 'FAIL-ON-REJECT': 'false' });
  await quietly(() => approval({ env, now: () => t, sleep: async () => {} }));
  await srv.close();
  assert.ok(srv.calls.length >= 3 && srv.calls.length <= 4, `calls: ${srv.calls.length}`);
  assert.equal(outputs(env).status, 'pending');
});

test('approval gives up at the timeout', async () => {
  let t = 0;
  const srv = await serve((req) => {
    t += 31 * 60_000;
    return [req.method === 'POST' ? 201 : 200, { approval_id: 'apr_4', status: 'pending', url: 'u' }];
  });
  const env = envFor(srv.host, { TITLE: 'Deploy?', 'TIMEOUT-MINUTES': '30' });
  await assert.rejects(quietly(() => approval({ env, now: () => t, sleep: async () => {} })), /No answer in time/);
  await srv.close();
});

test('event publishes JSON as is and text as a JSON string', async () => {
  assert.equal(dataString('{"ok":true}'), '{"ok":true}');
  assert.equal(dataString('deployed'), '"deployed"');
  assert.equal(dataString(''), '{}');
  const srv = await serve((req, body) => {
    verify(req.method, req.url, body);
    assert.match(req.url, /^\/apps\/7\/events\?/);
    return [200, {}];
  });
  await quietly(() => event({ env: envFor(srv.host, { CHANNEL: 'deploys, ops', EVENT: 'deploy.finished', DATA: '{"version":"1.2"}' }) }));
  await srv.close();
  assert.deepEqual(JSON.parse(srv.calls[0].body), { name: 'deploy.finished', channels: ['deploys', 'ops'], data: '{"version":"1.2"}' });
});

test('push publishes to interests with the bearer secret key', async () => {
  const srv = await serve(() => [200, { publishId: 'pub_1' }]);
  const env = envFor(srv.host, { COMMAND: 'push', 'INSTANCE-ID': 'inst', 'PUSH-SECRET-KEY': 'psk', 'PUSH-INTERESTS': 'team', TITLE: 'Deployed', BODY: 'v1.2 is live', URL: 'https://shop.test/' });
  await quietly(() => push({ env }));
  await srv.close();
  const c = srv.calls[0];
  assert.equal(c.url, '/publish_api/v1/instances/inst/publishes/interests');
  assert.equal(c.headers.authorization, 'Bearer psk');
  const b = JSON.parse(c.body);
  assert.deepEqual(b.interests, ['team']);
  assert.deepEqual(b.web.notification, { title: 'Deployed', body: 'v1.2 is live', deep_link: 'https://shop.test/' });
  assert.deepEqual(b.apns.aps.alert, { title: 'Deployed', body: 'v1.2 is live' });
  assert.equal(outputs(env)['publish-id'], 'pub_1');
});

test('push needs interests or users, not both', async () => {
  await assert.rejects(push({ env: envFor('http://unused', { 'PUSH-INTERESTS': 'a', 'PUSH-USERS': 'b', TITLE: 't' }) }), /one of them/);
});

test('waiting-room changes the state, then admits', async () => {
  const srv = await serve((req, body) => {
    verify(req.method, req.url, body);
    if (req.url.startsWith('/apps/7/waiting_rooms/drop/admit?')) return [200, { state: 'open', waiting: 10, admitted: 50 }];
    assert.match(req.url, /^\/apps\/7\/waiting_rooms\/drop\?/);
    return [200, { state: 'open', waiting: 60, admitted: 0 }];
  });
  const env = envFor(srv.host, { ROOM: 'drop', STATE: 'Open', ADMIT: '50' });
  await quietly(() => waitingRoom({ env }));
  await srv.close();
  assert.deepEqual(JSON.parse(srv.calls[0].body), { state: 'open' });
  assert.deepEqual(JSON.parse(srv.calls[1].body), { count: 50 });
  const out = outputs(env);
  assert.equal(out.status, 'open');
  assert.equal(out.waiting, '10');
});

test('API errors fail the step with the server message', async () => {
  const srv = await serve(() => [403, { error: 'this plan has no waiting rooms' }]);
  const env = envFor(srv.host, { COMMAND: 'waiting-room', ROOM: 'drop', STATE: 'open' });
  const { logged } = await quietly(() => run(env));
  await srv.close();
  assert.match(logged, /::error::Hibira API 403: this plan has no waiting rooms/);
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
});

test('a 522 from the edge is sent again; a 500 is not', async () => {
  let srv = await serve((req, body, n) => (n < 3 ? [522, { error: 'origin unreachable' }] : [200, { ok: true }]));
  assert.deepEqual(await send(`${srv.host}/x`, { method: 'POST', body: '{}' }, 5000, { delayMs: 1 }), { ok: true });
  assert.equal(srv.calls.length, 3);
  await srv.close();
  srv = await serve(() => [500, { error: 'boom' }]);
  await assert.rejects(send(`${srv.host}/x`, { method: 'POST', body: '{}' }, 5000, { delayMs: 1 }), /500: boom/);
  assert.equal(srv.calls.length, 1);
  await srv.close();
});

test('an unknown command fails', async () => {
  const { logged } = await quietly(() => run({ INPUT_COMMAND: 'deploy' }));
  assert.match(logged, /command must be one of: approval, event, push, waiting-room/);
  process.exitCode = 0;
});

test('defaultDetails describes the run', () => {
  assert.equal(
    defaultDetails({ GITHUB_REPOSITORY: 'a/b', GITHUB_SHA: '0123456789abcdef', GITHUB_RUN_ID: '9', GITHUB_ACTOR: 'mei' }),
    'Repository: a/b\nCommit: 0123456789ab\nStarted by: mei\nRun: https://github.com/a/b/actions/runs/9',
  );
});
