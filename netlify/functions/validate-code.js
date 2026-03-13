import { getStore } from '@netlify/blobs';

export default async (req) => {
  const { code } = await req.json();
  const normalized = (code || '').trim().toLowerCase();

  const validCodes = (process.env.INVITE_CODES || '')
    .split(',')
    .map(c => c.trim().toLowerCase());

  // Check if code exists in the valid list
  if (!validCodes.includes(normalized)) {
    return new Response(JSON.stringify({ valid: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Check if code has already been used
  const store = getStore('used-codes');
  const alreadyUsed = await store.get(normalized);

  if (alreadyUsed) {
    return new Response(JSON.stringify({ valid: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Mark code as used
  await store.set(normalized, 'used');

  return new Response(JSON.stringify({ valid: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const config = { path: '/api/validate-code' };
