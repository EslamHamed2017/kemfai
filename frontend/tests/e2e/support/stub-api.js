// T103/T104 e2e — stand-in control-plane for /accounts/me/locale ONLY.
// Deterministic: module-level state + explicit control endpoints (seed/reset).
const http = require('http');
const { createClient } = require('redis');

let persisted = null; // ONE shared account: same user across both login sessions (T103's scenario)
const moduleSelections = new Map();
const revokedModuleTokens = new Set();

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
    const { sessionId, token = 'e2e-access-token', locale = null } = JSON.parse(await readBody(req));
    if (locale !== null && locale !== undefined) persisted = locale;
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
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ locale: persisted }));
  }
  if (url.pathname === '/__e2e/modules') {
    const { token, featureKeys, revoked = false } = JSON.parse(await readBody(req));
    moduleSelections.set(token, featureKeys);
    if (revoked) revokedModuleTokens.add(token); else revokedModuleTokens.delete(token);
    res.writeHead(204);
    return res.end();
  }
  if (url.pathname === '/__e2e/reset') {
    persisted = null;
    res.writeHead(204);
    return res.end();
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
  if (url.pathname === '/onboarding/checklist') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ customerAdded: false, bankAdded: false, productAdded: false, firstInvoiceReady: false, gatedOnSubscriptionActivation: true }));
  }
  if (url.pathname !== '/accounts/me/locale') {
    res.writeHead(404);
    return res.end('{}');
  }
  if (req.method === 'PATCH') {
    let locale = null;
    try { locale = JSON.parse(await readBody(req)).locale; } catch { locale = null; }
    persisted = locale;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{}');
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ locale: persisted }));
});

server.listen(4100, '127.0.0.1', () => console.log('stub-api on 4100'));
