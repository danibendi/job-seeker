import { spawn } from 'node:child_process';
import nextWebSocket from 'next/dist/compiled/ws/index.js';

const [transportPath] = process.argv.slice(2);
if (!transportPath) throw new Error('usage: verify-linkedin-blocking-race.mjs TRANSPORT');

const { WebSocketServer } = nextWebSocket;

async function scenario(
  fetchError,
  expected,
  runtimeError = null,
  timedOutBlockAttempts = 0,
  operation = { op: 'probe' },
  navigationTimeout = false,
) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve, reject) => server.once('listening', resolve).once('error', reject));
  const address = server.address();
  const sessionId = 'fixture-session';
  let blockAttempts = 0;
  server.on('connection', socket => {
    const pauseImage = () => socket.send(JSON.stringify({
      method: 'Fetch.requestPaused', sessionId,
      params: { requestId: 'already-cancelled-image', resourceType: 'Image' },
    }));
    socket.on('message', payload => {
      const message = JSON.parse(payload.toString());
      if (message.method === 'Page.navigate' && navigationTimeout) {
        setTimeout(pauseImage, 0);
        return;
      }
      if (message.method === 'Runtime.evaluate' && runtimeError) {
        socket.send(JSON.stringify({ id: message.id, error: runtimeError }));
        return;
      }
      const result = (() => {
        if (message.method === 'Target.createTarget') return { targetId: 'fixture-target' };
        if (message.method === 'Target.attachToTarget') return { sessionId };
        if (message.method === 'Runtime.evaluate') return { result: { value: {
          authenticated: false, challenge: true, identities: [], pathname: '/checkpoint/',
          title: 'Fixture challenge', needsAccountMenu: false,
        } } };
        return {};
      })();
      if (message.method === 'Fetch.failRequest') {
        blockAttempts += 1;
        if (blockAttempts <= timedOutBlockAttempts) return;
        socket.send(JSON.stringify({ id: message.id, error: fetchError }));
        return;
      }
      socket.send(JSON.stringify({ id: message.id, result }));
      if (message.method === 'Fetch.enable' && !navigationTimeout) setTimeout(pauseImage, 0);
    });
  });

  const transport = spawn('node', [transportPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test', COMPASS_TEST_CDP_TIMEOUT_MS: '50' },
  });
  let buffered = '';
  const replies = [];
  transport.stdout.setEncoding('utf8');
  transport.stdout.on('data', chunk => {
    buffered += chunk;
    while (buffered.includes('\n')) {
      const boundary = buffered.indexOf('\n');
      replies.push(JSON.parse(buffered.slice(0, boundary)));
      buffered = buffered.slice(boundary + 1);
    }
  });
  const command = async value => {
    transport.stdin.write(JSON.stringify(value) + '\n');
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (replies.length) return replies.shift();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('transport_timeout');
  };
  try {
    const connected = await command({
      op: 'connect', endpoint: `ws://127.0.0.1:${address.port}`, blockMedia: !runtimeError,
    });
    if (!connected.ok) throw new Error(`connect_${connected.error}`);
    const probe = await command(operation);
    if (probe.ok !== expected.ok || probe.error !== expected.error) {
      throw new Error(`unexpected_probe_${JSON.stringify(probe)}`);
    }
    if (expected.blockAttempts !== undefined && blockAttempts !== expected.blockAttempts) {
      throw new Error(`unexpected_block_attempts_${blockAttempts}`);
    }
    if (expected.ok) {
      const stats = probe.result?._resourceBlocking;
      if (stats?.staleRequests !== expected.staleRequests || stats.total !== expected.total ||
          stats.recoveredTimeouts !== expected.recoveredTimeouts) {
        throw new Error(`stale_race_not_accounted_${JSON.stringify(stats)}`);
      }
    } else {
      const serialized = JSON.stringify(probe);
      const rawMessages = [fetchError?.message, runtimeError?.message].filter(Boolean);
      if (rawMessages.some(message => serialized.includes(message)) ||
          JSON.stringify(probe.diagnostic) !== JSON.stringify(expected.diagnostic) ||
          JSON.stringify(probe.browserDiagnostic) !== JSON.stringify(expected.browserDiagnostic)) {
        throw new Error(`unsafe_or_missing_failure_diagnostic_${JSON.stringify(probe)}`);
      }
    }
  } finally {
    transport.stdin.end();
    if (transport.exitCode === null) transport.kill('SIGTERM');
    await new Promise(resolve => server.close(resolve));
  }
}

await scenario(
  { code: -32602, message: 'Invalid InterceptionId.' },
  { ok: true, error: undefined, staleRequests: 1, total: 0, recoveredTimeouts: 0 },
);
await scenario(
  null,
  { ok: true, error: undefined, staleRequests: 0, total: 1, recoveredTimeouts: 1 },
  null,
  1,
);
await scenario(
  { code: -32602, message: 'Invalid InterceptionId.' },
  { ok: true, error: undefined, staleRequests: 1, total: 0, recoveredTimeouts: 1 },
  null,
  1,
);
await scenario(
  null,
  { ok: false, error: 'resource_blocking_failed', diagnostic: {
    category: 'timeout', cdpCode: null, method: 'Fetch.failRequest',
  } },
  null,
  2,
);
await scenario(
  null,
  { ok: false, error: 'resource_blocking_failed', blockAttempts: 2, diagnostic: {
    category: 'timeout', cdpCode: null, method: 'Fetch.failRequest',
  } },
  null,
  2,
  { op: 'details', jobId: '4459889607' },
  true,
);
await scenario(
  { code: -32000, message: 'Access denied' },
  { ok: false, error: 'resource_blocking_failed', diagnostic: {
    category: 'cdp_error', cdpCode: -32000, method: 'Fetch.failRequest',
  } },
);
await scenario(
  null,
  { ok: false, error: 'browser_command_failed', browserDiagnostic: {
    method: 'Runtime.evaluate', category: 'command_failed',
  } },
  { code: -32000, message: 'Provider failure at https://private.invalid/?token=synthetic-secret' },
);
