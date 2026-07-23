import { getContext } from '@netlify/functions';

export const accessCookieName = 'clearline_access_session';
export const accessCookieMaxAgeSeconds = 1800;
export const thankYouCookieName = 'clearline_submission_received';
export const thankYouCookieMaxAgeSeconds = 600;

export const productionUsedCodesStoreName = 'used-codes';
export const previewUsedCodesStoreName = 'used-codes-preview';

const textEncoder = new TextEncoder();

export async function sha256(value) {
  const bytes = textEncoder.encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64UrlEncode(value) {
  return btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlDecode(value) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return JSON.parse(atob(padded));
}

export function readCookie(req, name) {
  const header = req.headers.get('cookie') || '';
  return header
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1) || '';
}

export function isExplicitLocalDevelopmentFallbackAllowed() {
  const explicit = process.env.CLEARLINE_ALLOW_LOCAL_MEMORY_FALLBACK === 'true';
  const runningInsideNetlify = process.env.NETLIFY === 'true';
  return explicit && !runningInsideNetlify;
}

function activeRequestContext(handlerContext) {
  if (handlerContext?.deploy) return handlerContext;
  try {
    return getContext();
  } catch {
    return null;
  }
}

function deployMetadata(context) {
  return {
    deploy_id: context?.deploy?.id || '',
    deploy_published: typeof context?.deploy?.published === 'boolean' ? context.deploy.published : null,
  };
}

export function resolveUsedCodesRuntime(handlerContext) {
  if (globalThis.__clearlineMockUsedCodesRuntime) return globalThis.__clearlineMockUsedCodesRuntime;

  const requestContext = activeRequestContext(handlerContext);
  const context = requestContext?.deploy?.context || '';

  if (isExplicitLocalDevelopmentFallbackAllowed()) {
    return {
      valid: true,
      deploy_context: 'local-qa',
      deploy_id: 'local-qa',
      deploy_published: false,
      used_codes_store_name: 'explicit-local-memory',
      local_memory: true,
    };
  }

  if (!context) {
    return { valid: false, status: 'missing_deploy_context' };
  }

  if (context === 'production') {
    return {
      valid: true,
      deploy_context: context,
      ...deployMetadata(requestContext),
      used_codes_store_name: productionUsedCodesStoreName,
      local_memory: false,
    };
  }

  if (context === 'deploy-preview' || context === 'branch-deploy') {
    return {
      valid: true,
      deploy_context: context,
      ...deployMetadata(requestContext),
      used_codes_store_name: previewUsedCodesStoreName,
      local_memory: false,
    };
  }

  return { valid: false, status: 'unknown_deploy_context' };
}

export function requireSessionSecret() {
  const deployedSecret = (process.env.ACCESS_SESSION_SECRET || '').trim();
  if (deployedSecret) return { valid: true, value: deployedSecret, source: 'access_session_secret' };

  if (isExplicitLocalDevelopmentFallbackAllowed()) {
    const localSecret = (process.env.CLEARLINE_LOCAL_QA_SESSION_SECRET || '').trim();
    if (localSecret) return { valid: true, value: localSecret, source: 'explicit_local_qa_session_secret' };
  }

  return { valid: false, status: 'missing_access_session_secret' };
}

export function normalizeInviteCodes() {
  return (process.env.INVITE_CODES || '')
    .split(',')
    .map((code) => code.trim().toLowerCase())
    .filter(Boolean);
}

export async function validInviteCodeHashes() {
  return await Promise.all(normalizeInviteCodes().map((code) => sha256(code)));
}

export function revokedInviteCodeHashes() {
  return (process.env.REVOKED_INVITE_CODE_HASHES || '')
    .split(',')
    .map((codeHash) => codeHash.trim().toLowerCase())
    .filter(Boolean);
}

export async function signPayload(payload) {
  const secret = requireSessionSecret();
  if (!secret.valid) throw new Error(secret.status);
  return sha256(`${payload}.${secret.value}`);
}

export async function makeSessionCookie(codeHash, nowMs = Date.now()) {
  const payload = base64UrlEncode({
    sid: crypto.randomUUID(),
    code_hash: codeHash,
    iat: nowMs,
    exp: nowMs + accessCookieMaxAgeSeconds * 1000,
  });
  const signature = await signPayload(payload);
  return `${payload}.${signature}`;
}

export async function verifySessionCookie(value, nowMs = Date.now()) {
  const secret = requireSessionSecret();
  if (!secret.valid) return { valid: false, status: secret.status };

  if (!value) return { valid: false, status: 'missing' };
  if (typeof value !== 'string' || !value.includes('.')) return { valid: false, status: 'malformed' };

  const parts = value.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { valid: false, status: 'malformed' };

  const [payload, signature] = parts;
  const expected = await signPayload(payload);
  if (signature !== expected) return { valid: false, status: 'invalid_signature' };

  let parsed;
  try {
    parsed = base64UrlDecode(payload);
  } catch {
    return { valid: false, status: 'malformed' };
  }

  if (!parsed || typeof parsed !== 'object' || !parsed.sid || !parsed.code_hash || !Number.isFinite(parsed.exp)) {
    return { valid: false, status: 'malformed' };
  }

  if (parsed.exp <= nowMs) return { valid: false, status: 'expired' };

  const activeHashes = await validInviteCodeHashes();
  if (!activeHashes.includes(parsed.code_hash)) return { valid: false, status: 'invalid_invitation_state' };

  if (revokedInviteCodeHashes().includes(parsed.code_hash)) return { valid: false, status: 'revoked_invitation_state' };

  return { valid: true, status: 'valid', session: parsed };
}

export function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}
