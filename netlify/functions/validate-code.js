export default async (req) => {
  const { code } = await req.json();
  const validCodes = (process.env.INVITE_CODES || '')
    .split(',')
    .map(c => c.trim().toLowerCase());

  const isValid = validCodes.includes((code || '').trim().toLowerCase());

  return new Response(JSON.stringify({ valid: isValid }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const config = { path: '/api/validate-code' };
