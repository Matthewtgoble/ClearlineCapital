import { thankYouCookieMaxAgeSeconds, thankYouCookieName } from './session-utils.js';

function hasCookie(req, name) {
  const header = req.headers.get('cookie') || '';
  return header.split(';').map((part) => part.trim()).some((part) => part.startsWith(`${name}=`));
}

function page() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Introduction Received | Clearline Capital</title>
  <meta name="description" content="Clearline Capital has received your introduction request." />
  <meta name="robots" content="noindex, nofollow, noarchive, nosnippet" />
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0} :root{--gold:#c9a96e;--dark:#0c0c0c;--charcoal:#2e2b28;--serif:Georgia,'Times New Roman',serif;--sans:Inter,system-ui,sans-serif} html,body{height:100%;-webkit-font-smoothing:antialiased}.page{min-height:100vh;background:var(--charcoal);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:4rem 2rem;text-align:center}.content{max-width:600px;width:100%}.logo{display:inline-block;margin-bottom:3rem;text-decoration:none;line-height:1}.logo-img{height:80px;width:auto;display:block}.divider{width:40px;height:1px;background:var(--gold);margin-inline:auto;margin-bottom:2.5rem}.eyebrow{font-family:var(--sans);font-size:.875rem;letter-spacing:.3em;text-transform:uppercase;color:var(--gold);margin-bottom:1.5rem}h1{font-family:var(--serif);font-size:clamp(1.8rem,4vw,2.8rem);font-weight:300;line-height:1.25;color:#d4d0cb;margin-bottom:2.5rem}.body{font-size:.875rem;font-weight:300;color:#9e9a95;line-height:1.9;margin-bottom:2.5rem}.back-link{display:inline-block;font-family:var(--sans);font-size:.7rem;letter-spacing:.25em;text-transform:uppercase;text-decoration:none;color:var(--gold);background:transparent;border:1px solid var(--gold);padding:.65rem 2rem}footer{margin-top:4rem}footer p{font-size:.68rem;letter-spacing:.12em;color:var(--gold)}
  </style>
</head>
<body>
  <div class="page">
    <main class="content">
      <a href="/" aria-label="Clearline Capital home" class="logo"><img src="/logo-champagne-132.webp" srcset="/logo-champagne-132.webp 132w, /logo-champagne-264.webp 264w, /logo-champagne-528.webp 528w" sizes="132px" width="132" height="83" alt="Clearline Capital" class="logo-img" /></a>
      <div class="divider"></div>
      <p class="eyebrow">Introduction received</p>
      <h1>Thank you for introducing yourself.</h1>
      <p class="body">If there is a clear reason to continue, the firm will respond directly.</p>
      <a href="/" class="back-link">Return to site</a>
    </main>
    <footer><p>Copyright &copy; 2026 Clearline Capital, LLC</p></footer>
  </div>
</body>
</html>`;
}

export default async (req) => {
  if (!hasCookie(req, thankYouCookieName)) {
    return new Response('', { status: 303, headers: { Location: '/', 'Cache-Control': 'no-store' } });
  }

  return new Response(page(), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Set-Cookie': `${thankYouCookieName}=; Path=/thank-you; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    },
  });
};

export const config = { path: '/thank-you' };
