import { getStore } from '@netlify/blobs';
import { accessCookieMaxAgeSeconds, accessCookieName, json, makeSessionCookie, normalizeInviteCodes, requireSessionSecret, resolveUsedCodesRuntime, sha256 } from './session-utils.js';

function usedCodeStore(runtime) {
  if (globalThis.__clearlineMockUsedCodeStores) return globalThis.__clearlineMockUsedCodeStores[runtime.used_codes_store_name];
  if (runtime.local_memory) return null;
  return getStore(runtime.used_codes_store_name);
}

async function alreadyUsed(store, codeHash, runtime) {
  if (runtime.local_memory) {
    globalThis.__clearlineLocalUsedCodes ||= new Map();
    return globalThis.__clearlineLocalUsedCodes.has(codeHash);
  }

  try {
    return Boolean(await store.get(codeHash));
  } catch {
    throw new Error('used-code store unavailable');
  }
}

async function markUsed(store, codeHash, runtime) {
  if (runtime.local_memory) {
    globalThis.__clearlineLocalUsedCodes ||= new Map();
    globalThis.__clearlineLocalUsedCodes.set(codeHash, 'used');
    return;
  }

  try {
    await store.set(codeHash, 'used');
  } catch {
    throw new Error('used-code store unavailable');
  }
}

export default async (req, context) => {
  if (req.method !== 'POST') return json({ valid: false }, 405);

  const runtime = resolveUsedCodesRuntime(context);
  if (!runtime.valid) {
    return json({ valid: false, error: 'Access temporarily unavailable.' }, 503);
  }

  if (!requireSessionSecret().valid) {
    return json({ valid: false, error: 'Access temporarily unavailable.' }, 503);
  }

  let payload = {};
  try {
    payload = await req.json();
  } catch {
    return json({ valid: false });
  }

  const normalized = (payload.code || '').trim().toLowerCase();
  const validCodes = normalizeInviteCodes();

  if (!normalized || !validCodes.includes(normalized)) {
    return json({ valid: false });
  }

  const codeHash = await sha256(normalized);
  const store = usedCodeStore(runtime);
  try {
    if (await alreadyUsed(store, codeHash, runtime)) {
      return json({ valid: false });
    }

    await markUsed(store, codeHash, runtime);
  } catch {
    return json({ valid: false, error: 'Access temporarily unavailable.' }, 503);
  }

  let sessionCookie;
  try {
    sessionCookie = await makeSessionCookie(codeHash);
  } catch {
    return json({ valid: false, error: 'Access temporarily unavailable.' }, 503);
  }

  return json(
    { valid: true, redirect: '/contact' },
    200,
    {
      'Set-Cookie': `${accessCookieName}=${sessionCookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${accessCookieMaxAgeSeconds}`,
    }
  );
};

export const config = { path: '/api/validate-code' };
