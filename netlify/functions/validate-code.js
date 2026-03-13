import { getStore } from '@netlify/blobs';

export default async (req) => {
  const { code } = await req.json();
  const normalized = (code || '').trim().toLowerCase();

  const validCodes = (process.env.INVITE_CODES || '')
    .split(',')
    .map(c => c.trim().toLowerCase());

  if (!validCodes.includes(normalized)) {
    return new Response(JSON.stringify({ valid: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Check if code has already been used
  const usedStore = getStore('used-codes');
  const alreadyUsed = await usedStore.get(normalized);

  if (alreadyUsed) {
    return new Response(JSON.stringify({ valid: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Mark code as used
  await usedStore.set(normalized, 'used');

  // Generate a single-use access token
  const token = crypto.randomUUID();
  const tokenStore = getStore('access-tokens');
  await tokenStore.set(token, 'valid');

  return new Response(JSON.stringify({ valid: true, token }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const config = { path: '/api/validate-code' };
