import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';
import { connectPair, pluginEnvBlock, wrapperLaunchEnv } from './supervisor.mjs';
import { FLOW_READ_BYTES } from './flow_budget.mjs';
import { encodeMux } from './framing.mjs';
import {
  dumpable,
  fionread,
  measureFlowReserve,
  processGroup,
  rcvbuf,
  sndbuf,
  spawnSleeper,
} from './flow_socket.mjs';
import { waitUntil } from './measure.mjs';

const probePath = fileURLToPath(new URL('./children/confine-probe.mjs', import.meta.url));
const echoPath = fileURLToPath(new URL('./children/echo.mjs', import.meta.url));
const stderrPath = fileURLToPath(new URL('./children/stderr-flood.mjs', import.meta.url));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

test('a forbidden syscall is rejected and a process in the plugin group is killed', async () => {
  const pair = await connectPair({ sweeper: false });
  let sleeper = null;
  try {
    const sibling = pair.sup.spawn({ pluginId: 'sibling', script: echoPath });
    const kid = pair.sup.spawn({
      pluginId: 'probe',
      script: probePath,
      env: { MEM_PID: String(sibling.pid) },
    });
    const grouped = await waitUntil(() => processGroup(kid.pid) === kid.pid, 2_000);
    assert.equal(grouped, true, String(processGroup(kid.pid)));
    const reported = await pair.stub.call({
      pluginId: 'probe',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { probe: true },
    }, 2_000);
    const got = reported.payload?.confinement;
    assert.equal(got?.confined, 1, JSON.stringify(reported));
    assert.equal(got.clone3, constants.errno.ENOSYS);
    assert.equal(got.fork, constants.errno.EPERM);
    assert.equal(got.vfork, constants.errno.EPERM);
    assert.equal(got.clone, constants.errno.EPERM);
    assert.equal(got.splice, constants.errno.EPERM);
    assert.equal(got.vmsplice, constants.errno.EPERM);
    assert.equal(got.tee, constants.errno.EPERM);
    assert.equal(got.sendfile, constants.errno.EPERM);
    assert.equal(got.io_uring_setup, constants.errno.EPERM);
    assert.equal(got.io_uring_enter, constants.errno.EPERM);
    assert.equal(got.io_uring_register, constants.errno.EPERM);
    assert.equal(got.cloneThread, 0);
    assert.equal(got.pidfd_open, constants.errno.EPERM);
    assert.equal(got.pidfd_getfd, constants.errno.EPERM);
    assert.equal(got.ptrace, constants.errno.EPERM);
    assert.equal(got.process_vm_readv, constants.errno.EPERM);
    assert.equal(got.process_vm_writev, constants.errno.EPERM);
    assert.equal(got.kcmp, constants.errno.EPERM);
    if (process.arch === 'x64') {
      assert.equal(got.x32Fork, constants.errno.EPERM);
      assert.equal(got.x32Splice, constants.errno.EPERM);
      assert.notEqual(got.x32Fork, constants.errno.ENOSYS);
      assert.notEqual(got.x32Splice, constants.errno.ENOSYS);
    }
    assert.equal(got.reverse, 'EPIPE');
    assert.equal(got.dumpable, 0);
    assert.equal(got.setDumpable, constants.errno.EPERM);
    assert.equal(got.dumpableAfter, 0);
    assert.ok(got.mem === 'EACCES' || got.mem === 'EPERM', String(got.mem));
    const rec = pair.sup.children.get('probe');
    assert.equal(fionread(rec.stdinFd), 0);
    assert.equal(dumpable(), 0);
    sleeper = spawnSleeper(kid.pid);
    assert.equal(typeof sleeper, 'number');
    const joined = await waitUntil(() => processGroup(sleeper) === kid.pid, 2_000);
    assert.equal(joined, true);
    assert.equal(alive(sleeper), true);
    const done = await pair.stub.call({
      pluginId: 'probe',
      credential: kid.credential,
      correlationId: 2,
      port: 'db',
      method: 'get',
      payload: { exit: true },
    }, 2_000);
    assert.equal(done.payload?.ok, true);
    const killed = await waitUntil(() => alive(sleeper) === false, 2_000);
    assert.equal(killed, true);
    sleeper = null;
  } finally {
    if (sleeper != null && alive(sleeper)) {
      try { process.kill(sleeper, 'SIGKILL'); } catch { /* already gone */ }
    }
    await pair.close();
  }
});

test('loader variables reach the plugin only after the wrapper has confined it', async () => {
  const block = pluginEnvBlock({
    LD_AUDIT: '/no/such/audit.so',
    LD_LIBRARY_PATH: '/no/lib',
    LD_PRELOAD: '/no/preload.so',
    PLUGIN_MARKER: 'kept',
  }, 'probe');
  const text = block.toString('utf8');
  assert.equal(text.includes('LD_'), false);
  assert.equal(text.includes('PLUGIN_MARKER=kept'), true);
  assert.equal(Object.hasOwn(wrapperLaunchEnv(), 'LD_PRELOAD'), false);
  assert.equal(Object.hasOwn(wrapperLaunchEnv(), 'LD_AUDIT'), false);
  const pair = await connectPair({ sweeper: false });
  try {
    const kid = pair.sup.spawn({
      pluginId: 'probe',
      script: probePath,
      env: {
        LD_AUDIT: '/no/such/audit.so',
        LD_LIBRARY_PATH: '/no/lib',
        LD_PRELOAD: '/no/preload.so',
        PLUGIN_MARKER: 'kept',
      },
    });
    const reported = await pair.stub.call({
      pluginId: 'probe',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { probe: true },
    }, 2_000);
    const got = reported.payload?.confinement;
    assert.equal(got?.confined, 1, JSON.stringify(got));
    assert.equal(got.marker, 'kept');
    assert.equal(got.ldAudit, 0);
    assert.equal(got.ldLibraryPath, 0);
    assert.equal(got.ldPreload, '/proc/self/fd/4');
    assert.equal(got.dumpable, 0);
  } finally {
    await pair.close();
  }
});

test('stderr is /dev/null and a flood is not in the process sum', async () => {
  const pair = await connectPair({ sweeper: false });
  try {
    const kid = pair.sup.spawn({ pluginId: 'err', script: stderrPath });
    const rec = pair.sup.children.get('err');
    assert.equal(rec.child.stderr, null);
    assert.equal(rec.child.stdio[2], null);
    const before = pair.sup.bufferedBytes();
    const reported = await pair.stub.call({
      pluginId: 'err',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { n: 1 },
    }, 2_000);
    assert.equal(reported.payload?.stderr, '/dev/null');
    const grew = pair.sup.bufferedBytes() - before;
    assert.ok(grew < 64 * 1024, String(grew));
    assert.ok(pair.sup.bufferedBytes() < 256 * 1024, String(pair.sup.bufferedBytes()));
  } finally {
    await pair.close();
  }
});

test('mux buffers are pinned, reserved, and read in C-byte chunks', async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  assert.ok(reserved.kMuxIn > 0);
  assert.ok(reserved.kMuxOut > 0);
  assert.equal(reserved.muxReserve, reserved.kMuxIn + reserved.kMuxOut + FLOW_READ_BYTES);
  const tight = reserved.perChild + reserved.muxReserve;
  const low = await connectPair({
    sweeper: false,
    caps: { partial: 1024 * 1024, total: 1024 * 1024, totalGlobal: tight - 1 },
  });
  try {
    assert.throws(
      () => low.sup.spawn({ pluginId: 'echo', script: echoPath, total: 1024 * 1024 }),
      (err) => err.code === 'unsatisfiable',
    );
  } finally {
    await low.close();
  }

  const pair = await connectPair({
    sweeper: false,
    caps: { partial: 1024 * 1024, total: 1024 * 1024, totalGlobal: tight + FLOW_READ_BYTES },
  });
  try {
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath, total: 1024 * 1024 });
    assert.ok(kid.pid);
    assert.ok(pair.sup.kMuxIn > 0);
    assert.ok(pair.sup.kMuxOut > 0);
    const liveSnd = sndbuf(pair.sup.muxFd);
    const liveRcv = rcvbuf(pair.sup.muxFd);
    assert.ok(liveSnd > 0 && liveSnd <= pair.sup.muxSndbuf, `${liveSnd} > ${pair.sup.muxSndbuf}`);
    assert.ok(liveRcv > 0 && liveRcv <= pair.sup.muxRcvbuf, `${liveRcv} > ${pair.sup.muxRcvbuf}`);
    const frames = [];
    for (let i = 0; i < 8; i++) {
      frames.push(encodeMux({ kind: 'noop', n: i, pad: 'x'.repeat(1000) }));
    }
    pair.stub.socket.write(Buffer.concat(frames));
    const read = await waitUntil(() => pair.sup.muxReadHigh > 0, 2_000);
    assert.equal(read, true);
    assert.ok(pair.sup.muxReadHigh <= FLOW_READ_BYTES, String(pair.sup.muxReadHigh));
  } finally {
    await pair.close();
  }
});
