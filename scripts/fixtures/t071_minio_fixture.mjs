#!/usr/bin/env node
import { constants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const fail = (message) => { process.stderr.write(`FAIL: ${message}\n`); process.exit(1); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

try {
  const configPath = await realpath(process.env.T071_MINIO_FIXTURE_CONFIG ?? '');
  const configStat = await stat(configPath);
  if (!configStat.isFile() || configStat.uid !== process.getuid() || (configStat.mode & 0o077) !== 0) fail('fixture config must be an owner-only regular file');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) fail('MinIO endpoint must be an exact loopback HTTP origin with a port');
  if (!uuid.test(config.tenantId) || !Array.isArray(config.submissionIds) || config.submissionIds.length !== 5 || new Set(config.submissionIds).size !== 5 || !config.submissionIds.every((id) => uuid.test(id))) fail('fixture requires one tenant UUID and five unique submission UUIDs');
  if (typeof config.accessKey !== 'string' || !config.accessKey || typeof config.secretKey !== 'string' || !config.secretKey) fail('fixture storage credentials are missing');
  const proofPath = await realpath(config.proofPath);
  const proofStat = await stat(proofPath);
  if (!proofStat.isFile() || proofStat.uid !== process.getuid() || proofStat.size < 5) fail('fixture proof is not an owner-controlled nonempty file');
  await access(proofPath, constants.R_OK);
  const proof = await readFile(proofPath);
  if (proof.subarray(0, 5).toString() !== '%PDF-') fail('fixture proof is not a PDF');
  const requireFromApi = createRequire(path.join(process.cwd(), 'package.json'));
  if (requireFromApi('minio/package.json').version !== '8.0.7') fail('fixture requires repository-pinned minio 8.0.7');
  const { Client } = requireFromApi('minio');
  if (process.argv.includes('--validate-only')) {
    process.stdout.write('PASS: T071 MinIO fixture configuration is valid.\n');
    process.exit(0);
  }
  const client = new Client({ endPoint: endpoint.hostname, port: Number(endpoint.port), useSSL: false, accessKey: config.accessKey, secretKey: config.secretKey });
  const bucket = `kemfai-tenant-${config.tenantId}`;
  if (await client.bucketExists(bucket)) fail('owned fixture bucket unexpectedly already exists');
  await client.makeBucket(bucket, 'us-east-1');
  for (const id of config.submissionIds) {
    await client.putObject(bucket, `payment-submissions/${id}/proof.pdf`, proof, proof.length, { 'Content-Type': 'application/pdf' });
  }
  process.stdout.write('PASS: T071 owned MinIO bucket and five proof objects created.\n');
} catch (error) {
  fail(error instanceof Error ? error.message : 'MinIO fixture failed');
}
