import { getStore } from '@netlify/blobs';
import { accessCookieMaxAgeSeconds, accessCookieName, json, makeSessionCookie, normalizeInviteCodes, sha256 } from './session-utils.js';

async function alreadyUsed(codeHash) {
  try {
    return Boolean(await getStore('used-codes').get(codeHash));
  } catch {
    return false;
  }
}

async function markUsed(codeHash) {
  try {
    await getStore('used-codes').set(codeHash, 'used');
  } catch {
    // Used-code durability is helpful but not release-critical for local routing QA.
    // Access submission is still enforced by the signed access-session cookie.
  }
}

export default async (req) => {
  if (req.method !== 'POST') return json({ valid: false }, 405);

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
  if (await alreadyUsed(codeHash)) {
    return json({ valid: false });
  }

  await markUsed(codeHash);
  const sessionCookie = await makeSessionCookie(codeHash);

  return json(
    { valid: true, redirect: '/contact' },
    200,
    {
      'Set-Cookie': `${accessCookieName}=${sessionCookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${accessCookieMaxAgeSeconds}`,
    }
  );
};

export const config = { path: '/api/validate-code' };
