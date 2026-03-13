import { getStore } from '@netlify/blobs';

export default async (req) => {
  const { token } = await req.json();

  if (!token) {
    return new Response(JSON.stringify({ valid: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const store = getStore('access-tokens');
  const entry = await store.get(token);

  if (!entry) {
    return new Response(JSON.stringify({ valid: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Token is single-use — delete it immediately
  await store.delete(token);

  return new Response(JSON.stringify({ valid: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const config = { path: '/api/validate-token' };
