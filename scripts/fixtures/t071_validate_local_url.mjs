#!/usr/bin/env node
const raw = process.argv[2];
let url;
try { url = new URL(raw); } catch { process.exit(1); }
if (!['http:', 'https:'].includes(url.protocol)) process.exit(1);
if (!['127.0.0.1', 'localhost'].includes(url.hostname)) process.exit(1);
if (!url.port || url.username || url.password) process.exit(1);
if (url.pathname !== '/' || url.search || url.hash) process.exit(1);
process.stdout.write(url.origin);
