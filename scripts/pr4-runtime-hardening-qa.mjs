import validateCode from '../netlify/functions/validate-code.js';
import {
  makeSessionCookie,
  revokedInviteCodeHashes,
  sha256,
  verifySessionCookie,
} from '../netlify/functions/session-utils.js';

const results = [];
const sensitiveValues = ['preview-alpha', 'prod-bravo', 'branch-charlie', 'secret-placeholder', 'clearline-local-session-secret'];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeStore(name) {
  const map = new Map();
  const writes = [];
  return {
    name,
    map,
    writes,
    async get(key) {
      return map.get(key) || null;
    },
    async set(key, value) {
      writes.push({ key, value });
      map.set(key, value);
    },
  };
}

function resetEnv() {
  delete process.env.ACCESS_SESSION_SECRET;
  delete process.env.CLEARLINE_ALLOW_LOCAL_MEMORY_FALLBACK;
  delete process.env.CLEARLINE_LOCAL_QA_SESSION_SECRET;
  delete process.env.INVITE_CODES;
  delete process.env.REVOKED_INVITE_CODE_HASHES;
  process.env.NETLIFY = 'true';
  delete globalThis.__clearlineMockUsedCodesRuntime;
  delete globalThis.__clearlineMockUsedCodeStores;
  delete globalThis.__clearlineLocalUsedCodes;
}

function context(name) {
  if (!name) return {};
  return { deploy: { context: name, id: `mock-${name}-deploy`, published: name === 'production' } };
}

async function postCode(code, ctx) {
  const req = new Request('https://example.test/api/validate-code', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const response = await validateCode(req, ctx);
  const body = await response.json();
  return { status: response.status, body, setCookie: response.headers.get('set-cookie') || '' };
}

async function withStores(fn) {
  const prod = makeStore('used-codes');
  const preview = makeStore('used-codes-preview');
  globalThis.__clearlineMockUsedCodeStores = {
    'used-codes': prod,
    'used-codes-preview': preview,
  };
  await fn({ prod, preview });
}

async function run(name, fn) {
  resetEnv();
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await fn(logs);
    const leaked = logs.join('\n');
    assert(!sensitiveValues.some((value) => leaked.includes(value)), `${name}: sensitive value appeared in logs`);
    results.push({ name, status: 'PASS' });
  } catch (error) {
    results.push({ name, status: 'FAIL', error: error.message });
    throw error;
  } finally {
    console.log = originalLog;
    resetEnv();
  }
}

await run('deploy-preview writes only to used-codes-preview', async () => {
  process.env.ACCESS_SESSION_SECRET = 'secret-placeholder-preview';
  process.env.INVITE_CODES = ' preview-alpha ';
  await withStores(async ({ prod, preview }) => {
    const response = await postCode(' PREVIEW-ALPHA ', context('deploy-preview'));
    assert(response.status === 200 && response.body.valid === true, 'preview validation did not pass');
    assert(preview.writes.length === 1, 'preview store write count mismatch');
    assert(prod.writes.length === 0 && prod.map.size === 0, 'production store was touched');
    assert(response.setCookie.includes('clearline_access_session='), 'session cookie missing');
    assert(!response.setCookie.includes('preview-alpha'), 'raw code leaked in cookie');
  });
});

await run('deploy-preview duplicate preserves one-time-use behavior', async () => {
  process.env.ACCESS_SESSION_SECRET = 'secret-placeholder-preview-duplicate';
  process.env.INVITE_CODES = 'preview-alpha';
  await withStores(async ({ prod, preview }) => {
    const first = await postCode('preview-alpha', context('deploy-preview'));
    const second = await postCode('preview-alpha', context('deploy-preview'));
    assert(first.status === 200 && first.body.valid === true, 'first preview validation failed');
    assert(second.status === 200 && second.body.valid === false, 'duplicate did not fail closed as invalid');
    assert(preview.writes.length === 1, 'duplicate wrote more than once');
    assert(prod.writes.length === 0, 'duplicate touched production store');
  });
});

await run('production writes only to used-codes', async () => {
  process.env.ACCESS_SESSION_SECRET = 'secret-placeholder-production';
  process.env.INVITE_CODES = 'prod-bravo';
  await withStores(async ({ prod, preview }) => {
    const response = await postCode('prod-bravo', context('production'));
    assert(response.status === 200 && response.body.valid === true, 'production validation failed');
    assert(prod.writes.length === 1, 'production store write count mismatch');
    assert(preview.writes.length === 0 && preview.map.size === 0, 'preview store was touched');
  });
});

await run('branch-deploy writes only to used-codes-preview', async () => {
  process.env.ACCESS_SESSION_SECRET = 'secret-placeholder-branch';
  process.env.INVITE_CODES = 'branch-charlie';
  await withStores(async ({ prod, preview }) => {
    const response = await postCode('branch-charlie', context('branch-deploy'));
    assert(response.status === 200 && response.body.valid === true, 'branch-deploy validation failed');
    assert(preview.writes.length === 1, 'branch deploy preview-store write count mismatch');
    assert(prod.writes.length === 0 && prod.map.size === 0, 'production store was touched');
  });
});

await run('missing deploy context fails closed with zero writes', async () => {
  process.env.ACCESS_SESSION_SECRET = 'secret-placeholder-missing-context';
  process.env.INVITE_CODES = 'preview-alpha';
  await withStores(async ({ prod, preview }) => {
    const response = await postCode('preview-alpha', context(''));
    assert(response.status === 503 && response.body.valid === false, 'missing context did not fail closed');
    assert(prod.writes.length === 0 && preview.writes.length === 0, 'write occurred with missing context');
  });
});

await run('unknown deploy context fails closed with zero writes', async () => {
  process.env.ACCESS_SESSION_SECRET = 'secret-placeholder-unknown-context';
  process.env.INVITE_CODES = 'preview-alpha';
  await withStores(async ({ prod, preview }) => {
    const response = await postCode('preview-alpha', context('staging-but-not-trusted'));
    assert(response.status === 503 && response.body.valid === false, 'unknown context did not fail closed');
    assert(prod.writes.length === 0 && preview.writes.length === 0, 'write occurred with unknown context');
  });
});

for (const deployContext of ['production', 'deploy-preview', 'branch-deploy']) {
  await run(`missing ACCESS_SESSION_SECRET in ${deployContext} fails closed with zero writes`, async () => {
    process.env.INVITE_CODES = deployContext === 'production' ? 'prod-bravo' : 'preview-alpha';
    await withStores(async ({ prod, preview }) => {
      const response = await postCode(process.env.INVITE_CODES, context(deployContext));
      assert(response.status === 503 && response.body.valid === false, 'missing secret did not fail closed');
      assert(!response.setCookie, 'session cookie was created without ACCESS_SESSION_SECRET');
      assert(prod.writes.length === 0 && preview.writes.length === 0, 'write occurred without ACCESS_SESSION_SECRET');
    });
  });
}

await run('deployed context does not fall back to INVITE_CODES or hard-coded default', async () => {
  process.env.INVITE_CODES = 'preview-alpha';
  await withStores(async ({ prod, preview }) => {
    const response = await postCode('preview-alpha', context('deploy-preview'));
    assert(response.status === 503, 'deployed context accepted fallback signing material');
    assert(prod.writes.length === 0 && preview.writes.length === 0, 'fallback path wrote to a store');
  });
});

await run('explicit local QA uses local memory only and requires local QA secret', async () => {
  process.env.NETLIFY = 'false';
  process.env.CLEARLINE_ALLOW_LOCAL_MEMORY_FALLBACK = 'true';
  process.env.CLEARLINE_LOCAL_QA_SESSION_SECRET = 'secret-placeholder-local-qa';
  process.env.INVITE_CODES = 'preview-alpha';
  await withStores(async ({ prod, preview }) => {
    const response = await postCode('preview-alpha', context(''));
    assert(response.status === 200 && response.body.valid === true, 'explicit local QA validation failed');
    assert(prod.writes.length === 0 && preview.writes.length === 0, 'explicit local QA touched Netlify stores');
    assert(globalThis.__clearlineLocalUsedCodes?.size === 1, 'explicit local QA did not use local memory');
  });
});

await run('normalization hashing revocation expiration and signature validation remain intact', async () => {
  process.env.ACCESS_SESSION_SECRET = 'secret-placeholder-session-utils';
  process.env.INVITE_CODES = ' Mixed-Code ';
  const normalizedHash = await sha256('mixed-code');
  const cookie = await makeSessionCookie(normalizedHash, 1000);
  let result = await verifySessionCookie(cookie, 2000);
  assert(result.valid === true && result.status === 'valid', 'valid session failed');
  result = await verifySessionCookie(cookie, 1800 * 1000 + 1001);
  assert(result.valid === false && result.status === 'expired', 'expiration check failed');
  result = await verifySessionCookie(`${cookie.slice(0, -1)}0`, 2000);
  assert(result.valid === false && result.status === 'invalid_signature', 'signature tamper check failed');
  process.env.REVOKED_INVITE_CODE_HASHES = normalizedHash;
  assert(revokedInviteCodeHashes().includes(normalizedHash), 'revocation hash normalization failed');
  result = await verifySessionCookie(cookie, 2000);
  assert(result.valid === false && result.status === 'revoked_invitation_state', 'revocation check failed');
});

await run('response bodies and logs contain no raw codes tokens cookies or signing secrets', async (logs) => {
  process.env.ACCESS_SESSION_SECRET = 'secret-placeholder-redaction';
  process.env.INVITE_CODES = 'preview-alpha';
  await withStores(async () => {
    const response = await postCode('preview-alpha', context('deploy-preview'));
    const serialized = JSON.stringify(response.body);
    assert(!serialized.includes('preview-alpha'), 'raw code appeared in response body');
    assert(!serialized.includes('secret-placeholder'), 'secret appeared in response body');
    assert(!logs.join('\n').includes('secret-placeholder'), 'secret appeared in logs');
  });
});

console.log(JSON.stringify({ status: 'PASS', results }, null, 2));
