import { accessCookieName, json, readCookie, verifySessionCookie } from './session-utils.js';

export default async (req) => {
  if (req.method !== 'POST') return json({ valid: false }, 405);

  const sessionCookie = readCookie(req, accessCookieName);
  const verification = await verifySessionCookie(sessionCookie);

  return json({ valid: verification.valid });
};

export const config = { path: '/api/validate-token' };
