#!/usr/bin/env node
/**
 * lunarisd entrypoint: build the server, listen on 127.0.0.1:7340, and start
 * the periodic scheduler/dispatcher loop (cron schedules + goal queue drain).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from './server.js';
import { startSchedulerLoop } from './scheduler-loop.js';
import { buildVersionReport, globalStorePaths, leasesDbPath } from './phase4.js';
import { defaultIdentityDbPath, resolveAuthMode } from './auth.js';

const port = Number(process.env.LUNARISD_PORT ?? '7340');

// ---- Startup migration/version report (Phase 4) ----
// Run core doctor() over the known global db paths and log a version + schema
// report. We do NOT auto-migrate destructively in v1 — just report so an
// operator sees a 'behind'/'ahead' store before anything runs.
try {
  const eventsDbPath = join(homedir(), '.lunaris', 'events.db');
  const { version, doctor } = buildVersionReport(
    globalStorePaths(eventsDbPath, defaultIdentityDbPath(), leasesDbPath()),
  );
  const summary = doctor.stores
    .map((s) => `${s.store}@v${s.version ?? '?'}/${s.expected ?? '?'} ${s.status}`)
    .join(', ');
  // eslint-disable-next-line no-console
  console.log(
    `lunaris v${version.harness} · auth=${resolveAuthMode()} · stores: ${summary || '(none yet)'}`,
  );
} catch (err) {
  // eslint-disable-next-line no-console
  console.warn('lunarisd: version/doctor report failed (continuing)', err);
}

const app = await buildServer({ logger: true });
const address = await app.listen({ port, host: '127.0.0.1' });

// One ~30s tick loop drives all projects' schedules + queue draining. Webhook
// intake binds 127.0.0.1 only — real external webhooks need a tunnel.
const scheduler = startSchedulerLoop({
  events: app.lunaris.events,
  registry: app.lunaris.registry,
  log: app.log,
});

// eslint-disable-next-line no-console
console.log(`lunarisd listening on ${address} (loopback only)`);

let shuttingDown = false;
process.on('SIGINT', () => {
  if (shuttingDown) {
    process.exit(1);
  }
  shuttingDown = true;
  // eslint-disable-next-line no-console
  console.log('lunarisd: SIGINT received, shutting down gracefully...');
  scheduler.stop();
  app.close().then(
    () => process.exit(0),
    (err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('lunarisd: error during shutdown', err);
      process.exit(1);
    },
  );
});
