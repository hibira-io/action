// Calls to the Hibira HTTP API, signed with the app's key and secret the
// way the Pusher HTTP API is (auth_key, auth_timestamp, auth_version,
// body_md5, auth_signature).
import { createHash, createHmac } from 'node:crypto';

export const USER_AGENT = 'hibira-github-action/1';

export class ApiError extends Error {
  constructor(status, message, body) {
    super(`Hibira API ${status}: ${message}`);
    this.status = status;
    this.body = body;
  }
}

export function signedQuery({ key, secret, method, path, query = {}, body, now = Date.now() }) {
  const params = { ...query, auth_key: key, auth_timestamp: String(Math.floor(now / 1000)), auth_version: '1.0' };
  if (body !== undefined) params.body_md5 = createHash('md5').update(body).digest('hex');
  const sorted = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  const signature = createHmac('sha256', secret).update(`${method}\n${path}\n${sorted}`).digest('hex');
  return new URLSearchParams({ ...params, auth_signature: signature }).toString();
}

export function normalizeHost(host) {
  let h = (host || 'https://ws.hibira.io').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(h)) h = `https://${h}`;
  return h;
}

// Answers that mean the request never reached Hibira (a proxy or the edge
// could not reach it), so sending it again cannot do it twice.
const NOT_REACHED = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526]);

export async function send(url, init, timeoutMs, { retries = 2, delayMs = 2000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await sendOnce(url, init, timeoutMs);
    } catch (err) {
      const retryable = err instanceof ApiError ? NOT_REACHED.has(err.status) : init.method === 'GET';
      if (!retryable || attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
}

async function sendOnce(url, init, timeoutMs) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const msg = (json && (json.error || json.message || json.description)) || text.trim() || res.statusText;
    throw new ApiError(res.status, msg, text);
  }
  if (json === undefined) throw new Error(`Hibira API answered something other than JSON: ${text.slice(0, 200)}`);
  return json;
}

// App is one Hibira app's signed HTTP API.
export class App {
  constructor({ appId, key, secret, host, now }) {
    if (!appId || !key || !secret) throw new Error('app-id, key and secret are required for this command');
    this.appId = appId;
    this.key = key;
    this.secret = secret;
    this.host = normalizeHost(host);
    this.now = now || Date.now;
  }

  async call(method, resource, { query = {}, json, timeoutMs = 20000 } = {}) {
    const path = `/apps/${encodeURIComponent(this.appId)}${resource}`;
    const body = json === undefined ? undefined : JSON.stringify(json);
    const qs = signedQuery({ key: this.key, secret: this.secret, method, path, query, body, now: this.now() });
    const headers = { 'User-Agent': USER_AGENT };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return send(`${this.host}${path}?${qs}`, { method, headers, body }, timeoutMs);
  }
}

// publishPush sends through the Beams-compatible push publish API.
export async function publishPush({ host, instanceId, secretKey, payload }) {
  if (!instanceId || !secretKey) throw new Error('instance-id and push-secret-key are required for push');
  const route = payload.users ? 'users' : 'interests';
  const url = `${normalizeHost(host)}/publish_api/v1/instances/${encodeURIComponent(instanceId)}/publishes/${route}`;
  return send(
    url,
    {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json', Authorization: `Bearer ${secretKey}` },
      body: JSON.stringify(payload),
    },
    20000,
  );
}

// TokenApp is one Hibira app through the account API with an API token
// (https://hibira.io/api/v1), so a workflow needs no app key, secret or
// push key. Its call takes the same resources as App's.
export class TokenApp {
  constructor({ appId, token, apiUrl }) {
    if (!appId) throw new Error('app-id is required with api-token');
    this.appId = appId;
    this.token = token;
    this.base = `${normalizeHost(apiUrl || 'https://hibira.io')}/api/v1/apps/${encodeURIComponent(appId)}`;
  }

  async call(method, resource, { query = {}, json, timeoutMs = 20000 } = {}) {
    // The app-signed API's event body and room upsert, as the account API takes them.
    if (method === 'POST' && resource === '/events') {
      return this.request('POST', '/events', { json: { event: json.name, channels: json.channels, data: json.data }, timeoutMs });
    }
    const room = method === 'POST' && resource.match(/^\/waiting_rooms\/([^/]+)$/);
    if (room) {
      try {
        return await this.request('PATCH', resource, { json, timeoutMs });
      } catch (err) {
        if (err.status !== 404) throw err;
        if (json.admit_per_minute === undefined) throw new Error(`Waiting room ${decodeURIComponent(room[1])} does not exist yet: give admit-per-minute to create it`);
        return this.request('POST', '/waiting_rooms', { json: { id: decodeURIComponent(room[1]), ...json }, timeoutMs });
      }
    }
    return this.request(method, resource, { query, json, timeoutMs });
  }

  async request(method, resource, { query = {}, json, timeoutMs = 20000 } = {}) {
    const qs = new URLSearchParams(query).toString();
    const headers = { 'User-Agent': USER_AGENT, Authorization: `Bearer ${this.token}` };
    const body = json === undefined ? undefined : JSON.stringify(json);
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return send(`${this.base}${resource}${qs ? `?${qs}` : ''}`, { method, headers, body }, timeoutMs);
  }
}
