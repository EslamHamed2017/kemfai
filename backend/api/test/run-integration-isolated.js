#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Client } = require('pg');

const CONFIG = 'test/jest-integration.json';
const JEST = require.resolve('jest/bin/jest');
const SAFE_NAME = /^[a-z][a-z0-9_]{0,62}$/;

function makeDatabaseName(suitePath, nonce = crypto.randomBytes(6).toString('hex'), index = 0) {
  const stem = path
    .basename(suitePath)
    .replace(/\.integration-spec\.ts$/, '')
    .replace(/[^a-z0-9]+/gi, '_')
    .toLowerCase();
  const suffix = `${nonce}_${index}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const name = `kemfai_it_${stem.slice(0, Math.max(1, 62 - suffix.length - 11))}_${suffix}`;
  if (!SAFE_NAME.test(name)) throw new Error(`Unsafe generated database name: ${name}`);
  return name;
}

function discoverSuites(extraArgs, cwd = process.cwd(), spawnImpl = spawnSync) {
  const args = extraArgs.filter((arg) => arg !== '--runInBand');
  const result = spawnImpl(
    process.execPath,
    [JEST, '--config', CONFIG, '--runInBand', '--listTests', '--json', ...args],
    {
      cwd,
      encoding: 'utf8',
      env: process.env,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Jest test discovery failed (${result.status})\n${result.stderr || ''}`);

  let suites;
  try {
    suites = JSON.parse(result.stdout || '[]');
  } catch (error) {
    throw new Error(`Jest returned invalid discovery JSON: ${error.message}`);
  }
  if (!Array.isArray(suites) || suites.length === 0)
    throw new Error('Jest discovered zero integration suites');
  const normalized = suites.map((suite) => path.resolve(cwd, suite));
  if (new Set(normalized).size !== normalized.length)
    throw new Error('Jest discovered duplicate integration suite paths');
  return normalized;
}

function parseRedisUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'redis:')
    throw new Error('REDIS_URL must use redis:// for the CI integration runner');
  const database = url.pathname === '' || url.pathname === '/' ? 0 : Number(url.pathname.slice(1));
  if (!Number.isInteger(database) || database < 0)
    throw new Error('REDIS_URL contains an invalid database number');
  return { host: url.hostname, port: Number(url.port || 6379), password: url.password, database };
}

function redisCommand(parts) {
  return `*${parts.length}\r\n${parts.map((part) => `$${Buffer.byteLength(String(part))}\r\n${part}\r\n`).join('')}`;
}

async function flushRedis(value = process.env.REDIS_URL) {
  if (!value) throw new Error('REDIS_URL is required');
  const options = parseRedisUrl(value);
  const commands = [];
  if (options.password) commands.push(['AUTH', decodeURIComponent(options.password)]);
  if (options.database !== 0) commands.push(['SELECT', String(options.database)]);
  commands.push(['FLUSHDB']);

  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: options.host, port: options.port });
    let response = '';
    let replies = 0;
    const fail = (error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(5000, () => fail(new Error('Redis flush timed out')));
    socket.on('error', fail);
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
      const lines = response.split('\r\n').filter(Boolean);
      if (lines.some((line) => line.startsWith('-')))
        return fail(new Error(`Redis flush failed: ${lines.find((line) => line.startsWith('-'))}`));
      replies = lines.filter((line) => line.startsWith('+')).length;
      if (replies === commands.length) {
        socket.end();
        resolve();
      }
    });
    socket.on('connect', () => socket.write(commands.map(redisCommand).join('')));
  });
}

function adminConfig(env = process.env) {
  const required = ['CONTROL_DB_HOST', 'CONTROL_DB_USER', 'CONTROL_DB_PASSWORD', 'CONTROL_DB_NAME'];
  for (const key of required)
    if (!env[key]) throw new Error(`${key} is required; production credentials are not inferred`);
  return {
    host: env.CONTROL_DB_HOST,
    port: Number(env.CONTROL_DB_PORT || 5432),
    user: env.CONTROL_DB_USER,
    password: env.CONTROL_DB_PASSWORD,
    database: env.CONTROL_DB_NAME,
  };
}

async function cleanupDatabase(admin, database) {
  await admin.query(
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
    [database],
  );
  await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
  const leaked = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
  if (leaked.rowCount !== 0) throw new Error(`Leaked integration database: ${database}`);
}

function assertNoIncompleteTests(results, suite) {
  const incomplete = [];
  for (const file of results.testResults || []) {
    for (const assertion of file.assertionResults || []) {
      if (['pending', 'todo', 'disabled'].includes(assertion.status)) {
        incomplete.push(`${assertion.status}: ${assertion.fullName || assertion.title}`);
      }
    }
    if ((file.numPendingTests || 0) > 0 && (file.assertionResults || []).length === 0) {
      incomplete.push(`pending: ${file.testFilePath || suite}`);
    }
  }
  if ((results.numPendingTests || 0) > 0 && incomplete.length === 0) {
    incomplete.push(`pending: ${suite}`);
  }
  if (incomplete.length > 0) {
    throw new Error(
      `Selected integration suite contains skipped/pending/todo tests:\n${incomplete.join('\n')}`,
    );
  }
}

function runJestSuite(suite, database, extraArgs, cwd = process.cwd()) {
  const passthrough = extraArgs.filter(
    (arg) => arg.startsWith('-') && arg !== '--runInBand' && arg !== '--runTestsByPath',
  );
  const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kemfai-jest-result-'));
  const resultFile = path.join(resultDir, 'result.json');
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        JEST,
        '--config',
        CONFIG,
        '--runInBand',
        '--runTestsByPath',
        suite,
        '--json',
        `--outputFile=${resultFile}`,
        ...passthrough,
      ],
      {
        cwd,
        env: { ...process.env, CONTROL_DB_NAME: database },
        stdio: 'inherit',
      },
    );
    activeChild = child;
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      activeChild = undefined;
      try {
        if (code !== 0) throw new Error(`Suite failed (${signal || code}): ${suite}`);
        if (!fs.existsSync(resultFile)) throw new Error(`Jest JSON result missing: ${suite}`);
        assertNoIncompleteTests(JSON.parse(fs.readFileSync(resultFile, 'utf8')), suite);
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        fs.rmSync(resultDir, { recursive: true, force: true });
      }
    });
  });
}

let activeChild;
let interrupted;

async function run(options = {}) {
  const cwd = options.cwd || process.cwd();
  const extraArgs = options.args || process.argv.slice(2);
  const suites = (options.discover || discoverSuites)(extraArgs, cwd);
  const admin = options.admin || new Client(adminConfig(options.env || process.env));
  const nonce = (options.nonce || crypto.randomBytes(6).toString('hex')).toLowerCase();
  const created = new Set();
  let failures = 0;

  let connected = false;
  try {
    await admin.connect();
    connected = true;
    for (const [index, suite] of suites.entries()) {
      if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
      const database = makeDatabaseName(suite, nonce, index);
      if (created.has(database)) throw new Error(`Duplicate generated database name: ${database}`);
      created.add(database);
      let createdDatabase = false;
      try {
        await admin.query(`CREATE DATABASE "${database}"`);
        createdDatabase = true;
        await (options.flush || flushRedis)();
        await (options.runSuite || runJestSuite)(suite, database, extraArgs, cwd);
      } catch (error) {
        failures += 1;
        console.error(error.message || error);
      } finally {
        if (createdDatabase) {
          try {
            await cleanupDatabase(admin, database);
          } catch (error) {
            failures += 1;
            console.error(error.message || error);
          }
        }
      }
    }
  } finally {
    if (connected) await admin.end();
  }
  if (failures !== 0)
    throw new Error(`${failures} integration suite or cleanup operation(s) failed`);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    interrupted = signal;
    if (activeChild && !activeChild.killed) activeChild.kill(signal);
  });
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}

module.exports = {
  assertNoIncompleteTests,
  cleanupDatabase,
  discoverSuites,
  makeDatabaseName,
  parseRedisUrl,
  run,
};
