import { createT109SurfaceApp } from './t109-surface-harness';

const FIXTURE_LABEL = 'kemfai.phase12.operation=t109-parent-gates-continuation-20261025T153344Z';

async function main(): Promise<void> {
  if (process.env.T109_FIXTURE_LABEL !== FIXTURE_LABEL) {
    throw new Error(`T109_FIXTURE_LABEL must equal ${FIXTURE_LABEL}`);
  }
  const port = Number(process.env.T109_API_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('T109_API_PORT must be an unprivileged TCP port');
  }

  const frontendOrigin = process.env.T109_FRONTEND_ORIGIN;
  if (!frontendOrigin) throw new Error('T109_FRONTEND_ORIGIN is required');
  const parsedOrigin = new URL(frontendOrigin);
  if (
    parsedOrigin.protocol !== 'http:' ||
    parsedOrigin.hostname !== 'localhost' ||
    parsedOrigin.origin !== frontendOrigin
  ) {
    throw new Error('T109_FRONTEND_ORIGIN must be an exact http://localhost loopback origin');
  }

  const fixture = await createT109SurfaceApp({
    listen: true,
    port,
    corsOrigin: frontendOrigin,
  });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await fixture.close();
    process.exitCode = 0;
  };
  process.once('SIGTERM', () => void close());
  process.once('SIGINT', () => void close());
  process.stdout.write(`T109 fixture ready on http://127.0.0.1:${port}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
