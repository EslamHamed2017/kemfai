// T103/T104 e2e — stand-in control-plane for /accounts/me/locale ONLY.
// Deterministic: module-level state + explicit control endpoints (seed/reset).
const http = require('http');
const { createClient } = require('redis');

const preferredLocales = new Map();
const tokenAccounts = new Map();
const moduleSelections = new Map();
const revokedModuleTokens = new Set();
const supportAccessGrants = new Map();

const client = createClient({ url: process.env.REDIS_URL || 'redis://127.0.0.1:6379' });
client.on('error', () => undefined);

async function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => resolve(b));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:4100');
  if (url.pathname === '/__e2e/seed') {
    const { sessionId, token = 'e2e-access-token', locale = null, accountKey = token } = JSON.parse(await readBody(req));
    tokenAccounts.set(token, accountKey);
    if (locale !== null && locale !== undefined) preferredLocales.set(accountKey, locale);
    try {
      if (!client.isOpen) await client.connect();
      await client.set(`kemfai:session:${sessionId}`, JSON.stringify({
        accessToken: token,
        refreshToken: 'e2e-refresh-token',
        accessExpiresAt: Date.now() + 3600000,
        refreshExpiresAt: Date.now() + 7200000,
      }), { EX: 3600 });
      res.writeHead(204);
    } catch {
      res.writeHead(500);
    }
    return res.end();
  }
  if (url.pathname === '/__e2e/state') {
    const accountKey = url.searchParams.get('accountKey') || 'e2e-access-token';
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ locale: preferredLocales.get(accountKey) || null }));
  }
  if (url.pathname === '/__e2e/modules') {
    const { token, featureKeys, revoked = false } = JSON.parse(await readBody(req));
    moduleSelections.set(token, featureKeys);
    if (revoked) revokedModuleTokens.add(token); else revokedModuleTokens.delete(token);
    res.writeHead(204);
    return res.end();
  }
  if (url.pathname === '/__e2e/support-access') {
    const { token, grants } = JSON.parse(await readBody(req));
    if (typeof token !== 'string' || !Array.isArray(grants)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ message: 'token and grants are required' }));
    }
    supportAccessGrants.set(token, grants);
    res.writeHead(204);
    return res.end();
  }
  if (url.pathname === '/__e2e/reset') {
    const accountKey = url.searchParams.get('accountKey');
    if (accountKey) preferredLocales.delete(accountKey);
    else preferredLocales.clear();
    res.writeHead(204);
    return res.end();
  }
  // T094 frontend-only fixture: this read happens during SSR, before
  // Playwright browser routes can stimulate hydrated support-history states.
  if (url.pathname === '/support-access/grants' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('[]');
  }
  if (url.pathname === '/modules') {
    if (req.headers.authorization === 'Bearer t074-flagoff-token') {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ statusCode: 404, message: 'This feature is not available' }));
    }
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const selected = moduleSelections.get(token) || ['module.sales', 'module.accounting', 'module.inventory'];
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify([
      { key: 'module.sales', name: 'Sales', nameAr: 'المبيعات', includedInCurrentPlan: true, selected: selected.includes('module.sales'), requiredPlanTier: null, requiredPlanTierAr: null },
      { key: 'module.accounting', name: 'Accounting', nameAr: 'المحاسبة', includedInCurrentPlan: true, selected: selected.includes('module.accounting'), requiredPlanTier: null, requiredPlanTierAr: null },
      { key: 'module.inventory', name: 'Inventory', nameAr: 'المخزون', includedInCurrentPlan: !revokedModuleTokens.has(token), selected: selected.includes('module.inventory'), requiredPlanTier: revokedModuleTokens.has(token) ? 'Growth' : null, requiredPlanTierAr: revokedModuleTokens.has(token) ? 'النمو' : null },
      { key: 'module.projects', name: 'Projects', nameAr: 'المشاريع', includedInCurrentPlan: false, selected: false, requiredPlanTier: 'Growth', requiredPlanTierAr: 'النمو' },
    ]));
  }
  if (url.pathname === '/modules/selection' && req.method === 'PUT') {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    let featureKeys = null;
    try { featureKeys = JSON.parse(await readBody(req)).featureKeys; } catch { featureKeys = null; }
    if (!Array.isArray(featureKeys) || featureKeys.some((key) => typeof key !== 'string')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ message: 'featureKeys must be an array of strings' }));
    }
    moduleSelections.set(token, featureKeys);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ featureKeys }));
  }
  if (url.pathname === '/onboarding/checklist') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ customerAdded: false, bankAdded: false, productAdded: false, firstInvoiceReady: false, gatedOnSubscriptionActivation: true }));
  }
  if (url.pathname === '/support-access/grants' && req.method === 'GET') {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!supportAccessGrants.has(token)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ message: 'No synthetic support-access fixture' }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(supportAccessGrants.get(token)));
  }
  if (url.pathname !== '/accounts/me/locale') {
    res.writeHead(404);
    return res.end('{}');
  }
  if (req.method === 'PATCH') {
    let locale = null;
    try { locale = JSON.parse(await readBody(req)).locale; } catch { locale = null; }
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    preferredLocales.set(tokenAccounts.get(token) || token, locale);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{}');
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  res.end(JSON.stringify({ locale: preferredLocales.get(tokenAccounts.get(token) || token) || null }));
});

server.listen(4100, '127.0.0.1', () => console.log('stub-api on 4100'));
