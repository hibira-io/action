import * as core from './core.js';
import { App, publishPush } from './client.js';

const MAX_WAIT_SECONDS = 25;

function appFrom(env, now) {
  return new App({
    appId: core.input('app-id', env),
    key: core.input('key', env),
    secret: core.input('secret', env),
    host: core.input('host', env),
    now,
  });
}

function runUrl(env) {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env;
  if (!GITHUB_REPOSITORY || !GITHUB_RUN_ID) return '';
  return `${GITHUB_SERVER_URL || 'https://github.com'}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

// defaultDetails describes the run for the approver.
export function defaultDetails(env) {
  const lines = [];
  if (env.GITHUB_REPOSITORY) lines.push(`Repository: ${env.GITHUB_REPOSITORY}`);
  if (env.GITHUB_WORKFLOW) lines.push(`Workflow: ${env.GITHUB_WORKFLOW}${env.GITHUB_JOB ? ` / ${env.GITHUB_JOB}` : ''}`);
  if (env.GITHUB_REF_NAME) lines.push(`Ref: ${env.GITHUB_REF_NAME}`);
  if (env.GITHUB_SHA) lines.push(`Commit: ${env.GITHUB_SHA.slice(0, 12)}`);
  if (env.GITHUB_ACTOR) lines.push(`Started by: ${env.GITHUB_ACTOR}`);
  const run = runUrl(env);
  if (run) lines.push(`Run: ${run}`);
  return lines.join('\n');
}

function setApprovalOutputs(a, env) {
  core.setOutput('approval-id', a.approval_id, env);
  core.setOutput('url', a.url, env);
  core.setOutput('status', a.status, env);
  core.setOutput('choice', a.choice || '', env);
  core.setOutput('comment', a.comment || '', env);
  core.setOutput('answered-by', (a.answered_by && a.answered_by.email) || '', env);
}

export async function approval({ env = process.env, now, sleep = defaultSleep } = {}) {
  const minutes = core.int('timeout-minutes', { min: 1, max: 10080 }, env) ?? 60;
  const app = appFrom(env, now);
  const existing = core.input('approval-id', env);
  let a;
  if (existing) {
    a = await app.call('GET', `/approvals/${encodeURIComponent(existing)}`);
    setApprovalOutputs(a, env);
    core.info(`Waiting for the answer to "${a.title}": ${a.url}`);
  } else {
    const request = newRequest(env, minutes);
    a = await app.call('POST', '/approvals', { json: request });
    setApprovalOutputs(a, env);
    core.notice(`Waiting for an answer: ${a.url}`, request.title);
    if (a.push_error) core.warning(`The push notification was not sent: ${a.push_error}`);
    core.summary(`### Approval requested\n\n**${escapeMd(request.title)}**\n\n[Answer it here](${a.url})\n`, env);
  }

  if (!core.bool('wait', true, env)) return a;

  const clock = now || Date.now;
  const expires = a.expires_at ? Date.parse(a.expires_at) : NaN;
  const deadline = (Number.isNaN(expires) ? clock() + minutes * 60_000 : expires) + 30_000;
  const seen = new Set();
  while (a.status === 'pending') {
    const left = Math.floor((deadline - clock()) / 1000);
    if (left <= 0) break;
    const wait = Math.min(MAX_WAIT_SECONDS, left);
    const started = clock();
    try {
      a = await app.call('GET', `/approvals/${encodeURIComponent(a.approval_id)}`, {
        query: { wait: String(wait) },
        timeoutMs: (wait + 15) * 1000,
      });
    } catch (err) {
      if (err.status && err.status < 500 && err.status !== 429) throw err;
      core.warning(`Checking the approval failed, trying again: ${err.message}`);
      await sleep(5000);
      continue;
    }
    for (const m of a.discussion || []) {
      if (m.from === 'approver' && !seen.has(m.id)) {
        seen.add(m.id);
        core.notice(`${m.name || 'The approver'} asked: ${m.text}. Answer on the approval page or with the Hibira MCP reply_approval tool.`, 'Question from the approver');
      }
    }
    // An open question returns at once; don't spin while it waits.
    if (a.status === 'pending' && clock() - started < 2000) await sleep(5000);
  }

  setApprovalOutputs(a, env);
  const who = a.answered_by ? ` by ${a.answered_by.name || a.answered_by.email}` : '';
  const line = a.status === 'pending' ? 'No answer in time.' : `${a.status}${a.choice ? ` (${a.choice})` : ''}${who}${a.comment ? `: ${a.comment}` : ''}`;
  core.info(`Approval ${a.approval_id}: ${line}`);
  core.summary(`**Result:** ${escapeMd(line)}\n`, env);
  if (a.status !== 'approved' && core.bool('fail-on-reject', true, env)) {
    throw new Error(`Not approved: ${line}`);
  }
  return a;
}

function newRequest(env, minutes) {
  const title = core.input('title', env);
  if (!title) throw new Error('title is required for approval (or approval-id, to wait for an earlier request)');
  const options = core.list('options', env);
  const request = {
    title,
    details: core.input('details', env) || defaultDetails(env),
    options: options.length ? options : ['Approve', 'Reject'],
    expires_in_minutes: minutes,
    agent: 'GitHub Actions',
  };
  const channel = core.list('channel', env)[0];
  if (channel) request.channel = channel;
  const interests = core.list('push-interests', env);
  if (interests.length) request.push_interests = interests;
  const users = core.list('push-users', env);
  if (users.length) request.push_users = users;
  const approvers = core.list('approvers', env);
  if (approvers.length) request.approvers = approvers;
  const quorum = core.int('quorum', { min: 1, max: 100 }, env);
  if (quorum) request.quorum = quorum;
  return request;
}

export async function event({ env = process.env, now } = {}) {
  const channels = core.list('channel', env);
  const name = core.input('event', env);
  if (!channels.length || !name) throw new Error('channel and event are required for event');
  if (channels.length > 100) throw new Error('at most 100 channels per event');
  const raw = env['INPUT_DATA'] === undefined ? '' : env['INPUT_DATA'];
  const app = appFrom(env, now);
  await app.call('POST', '/events', { json: { name, channels, data: dataString(raw) } });
  core.info(`Sent "${name}" to ${channels.join(', ')}`);
}

// dataString keeps valid JSON as it is and sends anything else as a JSON
// string, so subscribers always get parseable data.
export function dataString(raw) {
  const t = raw.trim();
  if (t === '') return '{}';
  try {
    JSON.parse(t);
    return t;
  } catch {
    return JSON.stringify(raw);
  }
}

export async function push({ env = process.env } = {}) {
  const interests = core.list('push-interests', env);
  const users = core.list('push-users', env);
  if ((interests.length === 0) === (users.length === 0)) throw new Error('give push-interests or push-users (one of them) for push');
  const title = core.input('title', env);
  const body = core.input('body', env);
  if (!title && !body) throw new Error('title or body is required for push');
  const link = core.input('url', env);
  if (link && !link.startsWith('https://')) throw new Error('url must be an https link');
  const payload = users.length ? { users } : { interests };
  const alert = { title, body };
  payload.apns = { aps: { alert } };
  payload.fcm = { notification: { title, body } };
  payload.web = { notification: { title, body, ...(link ? { deep_link: link } : {}) } };
  if (link) {
    payload.apns.data = { url: link };
    payload.fcm.data = { url: link };
  }
  const sendAt = core.input('send-at', env);
  if (sendAt) payload.send_at = sendAt;
  const out = await publishPush({
    host: core.input('host', env),
    instanceId: core.input('instance-id', env),
    secretKey: core.input('push-secret-key', env),
    payload,
  });
  core.setOutput('publish-id', out.publishId || out.publish_id || '', env);
  core.info(`Push sent to ${users.length ? `${users.length} user(s)` : interests.join(', ')}${sendAt ? ` at ${sendAt}` : ''}`);
}

export async function waitingRoom({ env = process.env, now } = {}) {
  const room = core.input('room', env);
  if (!room) throw new Error('room is required for waiting-room');
  const state = core.input('state', env).toLowerCase();
  if (state && !['open', 'paused', 'closed'].includes(state)) throw new Error('state must be open, paused or closed');
  const change = {};
  if (state) change.state = state;
  const rate = core.int('admit-per-minute', { min: 0, max: 10_000_000 }, env);
  if (rate !== undefined) change.admit_per_minute = rate;
  for (const [inputName, field] of [['starts-at', 'starts_at'], ['title', 'title'], ['notice', 'notice']]) {
    const v = core.input(inputName, env);
    if (v) change[field] = v;
  }
  const admit = core.int('admit', { min: 1, max: 10_000_000 }, env);
  if (!Object.keys(change).length && admit === undefined) {
    throw new Error('give state, admit, admit-per-minute, starts-at, title or notice for waiting-room');
  }
  const app = appFrom(env, now);
  const path = `/waiting_rooms/${encodeURIComponent(room)}`;
  let view;
  if (Object.keys(change).length) view = await app.call('POST', path, { json: change });
  if (admit !== undefined) view = await app.call('POST', `${path}/admit`, { json: { count: admit } });
  core.setOutput('status', view.state, env);
  core.setOutput('waiting', view.waiting ?? 0, env);
  core.setOutput('admitted', view.admitted ?? 0, env);
  core.info(`Waiting room ${room}: ${view.state}, ${view.waiting ?? 0} waiting, admitted up to ${view.admitted ?? 0}`);
}

function escapeMd(s) {
  return String(s).replace(/([\\`*_[\]<>|])/g, '\\$1');
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export const commands = { approval, event, push, 'waiting-room': waitingRoom };
