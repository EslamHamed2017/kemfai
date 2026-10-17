#!/usr/bin/env node
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const fail = (message) => {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exit(1);
};

try {
  const requireFromFrontend = createRequire(path.join(process.cwd(), 'package.json'));
  const { chromium } = requireFromFrontend('@playwright/test');
  const executable = await realpath(chromium.executablePath());
  const marker = `${path.sep}ms-playwright${path.sep}`;
  const markerIndex = executable.indexOf(marker);
  if (!path.isAbsolute(executable) || markerIndex < 1) fail('browser is outside an ms-playwright cache');
  const cache = await realpath(executable.slice(0, markerIndex + marker.length - 1));
  if (executable !== cache && !executable.startsWith(`${cache}${path.sep}`)) fail('browser escaped its cache root');
  const [cacheStat, executableStat] = await Promise.all([stat(cache), stat(executable)]);
  if (!cacheStat.isDirectory() || cacheStat.uid !== process.getuid()) fail('browser cache is not an owner-controlled directory');
  if ((cacheStat.mode & 0o002) !== 0) fail('browser cache is world writable');
  if (!executableStat.isFile() || executableStat.uid !== process.getuid()) fail('browser executable is not owner-controlled');
  await access(executable, constants.X_OK);
  process.stdout.write(cache);
} catch (error) {
  fail(error instanceof Error ? error.message : 'unable to resolve Playwright Chromium');
}
