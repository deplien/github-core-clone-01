// Entry point: the harness lifecycle for one trial.
//
// The trial harness runs this process beside its suite. The suite cannot
// start until it knows where my server lives, and it tells me when it is
// finished, so the whole life of the process is:
//
//   1. Read the suite's origin from MAKEFUN_ENV_URL. With no origin there
//      is no trial to serve, so exit 1 immediately.
//   2. Build the forge's HTTP server and listen on port 0, letting the
//      kernel pick a free port (never 8080: that is the suite's own).
//   3. POST {"port": <port>} to <origin>/register so the suite can dial
//      the address this request came from at that port.
//   4. Poll GET <origin>/done until it answers {"done": true}.
//   5. Close the server and exit 0.
//
// Both network steps retry with a capped exponential backoff: the suite
// may still be starting when this process boots, and a slow poll says
// nothing about whether the trial is over. The process never exits
// before the suite says done.

import { createForgeServer } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set; no suite to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const FIRST_RETRY_MS = 200;
const MAX_RETRY_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Backoff after `failures` failed attempts: doubles from 200 ms, capped at 2 s. */
function backoff(failures: number): number {
  return Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.min(failures, 8));
}

/**
 * Tell the suite which port the forge bound. 200 means it took the
 * registration; 409 means an earlier registration already won and this
 * process simply waits like any other. Any other answer or a network
 * error is retried, except a 400 or 405, which means the request itself
 * broke the contract and retrying cannot help.
 */
async function announce(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register refused with HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) throw err;
    }
    await pause(backoff(failures));
  }
}

/** Poll the suite's /done until it reports the trial finished. */
async function awaitDone(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const res = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
        failures = 0;
      }
    } catch {
      // Unreachable or timed out: not done. Keep polling.
    }
    await pause(backoff(failures));
  }
}

const server = createForgeServer();
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, () => resolve());
});
const bound = server.address();
if (bound === null || typeof bound === 'string') {
  process.stderr.write('[forge] server did not bind a TCP port\n');
  process.exit(1);
}
process.stdout.write(`[forge] listening on ${bound.port}\n`);
// A harness stop signal ends the process the same way a finished suite
// does: close the listener and exit 0 rather than dying mid-request.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.close();
    process.exit(0);
  });
}
await announce(bound.port);
process.stdout.write('[forge] registered with the suite\n');
await awaitDone();
server.close();
process.stdout.write('[forge] suite done; exiting\n');
process.exit(0);
