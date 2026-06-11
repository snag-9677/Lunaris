#!/usr/bin/env node
/**
 * lunarisd entrypoint: build the server and listen on 127.0.0.1:7340.
 */
import { buildServer } from './server.js';

const port = Number(process.env.LUNARISD_PORT ?? '7340');

const app = await buildServer({ logger: true });
const address = await app.listen({ port, host: '127.0.0.1' });

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
  app.close().then(
    () => process.exit(0),
    (err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('lunarisd: error during shutdown', err);
      process.exit(1);
    },
  );
});
