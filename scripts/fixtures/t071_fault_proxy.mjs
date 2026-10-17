#!/usr/bin/env node
import http from 'node:http';

const upstream = new URL(process.env.T071_PROXY_UPSTREAM);
const submission = process.env.T071_FAULT_SUBMISSION_ID;
const countFile = process.env.T071_FAULT_COUNT_FILE;
const emailSinkFile = process.env.T071_EMAIL_SINK_FILE;
const port = Number(process.env.T071_PROXY_PORT);
if (upstream.hostname !== '127.0.0.1' || !upstream.port || !submission || !countFile || !port) process.exit(2);
let injected = false;
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/emails' && emailSinkFile) {
    req.resume();
    req.on('end', () => {
      import('node:fs').then(({ appendFileSync }) => appendFileSync(emailSinkFile, 'delivery\n', { mode: 0o600 }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":"t071-local-sink"}');
    });
    return;
  }
  const target = new URL(req.url, upstream);
  const proxy = http.request(target, { method: req.method, headers: { ...req.headers, host: upstream.host } }, upstreamRes => {
    const chunks = [];
    upstreamRes.on('data', chunk => chunks.push(chunk));
    upstreamRes.on('end', () => {
      const shouldInject = !injected && req.method === 'POST' &&
        target.pathname === `/internal/billing/payment-submissions/${submission}/reject` &&
        upstreamRes.statusCode >= 200 && upstreamRes.statusCode < 300;
      if (shouldInject) {
        injected = true;
        import('node:fs').then(({ writeFileSync }) => writeFileSync(countFile, '1\n', { mode: 0o600 }));
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '2' });
        res.end('{}');
        return;
      }
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      res.end(Buffer.concat(chunks));
    });
  });
  proxy.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(proxy);
});
server.listen(port, '127.0.0.1');
