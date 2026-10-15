// b4-bounds.mjs — >1 MiB typed error, never-terminated frame bounded, malformed NDJSON
// kills only the offending child (plan §4 B4).

import { fileURLToPath } from 'node:url';
import { connectPair, HARD_FRAME } from '../supervisor.mjs';
import { delay } from '../measure.mjs';

function child(name) {
  return fileURLToPath(new URL(`../children/${name}.mjs`, import.meta.url));
}

const echoPath = child('echo');

async function roundTrip(stub, credential) {
  const res = await stub.call({
    pluginId: credential.pluginId,
    credential,
    correlationId: 1,
    port: 'db',
    method: 'get',
    payload: { ok: true },
  });
  return res.payload?.ok === true && res.pluginId === credential.pluginId;
}

export async function b4() {
  const detail = {};
  // High-water pause disabled so the framer's hard cap is what rejects the stream.
  const pair = await connectPair({
    sweeper: false,
    partialHighWater: Number.POSITIVE_INFINITY,
  });
  try {
    const good = pair.sup.spawn({ pluginId: 'good', script: echoPath });
    pair.sup.spawn({ pluginId: 'bad', script: child('malformed') });
    const malformedDeadline = Date.now() + 2_000;
    while (!pair.sup.faults.some((f) => f.pluginId === 'bad') && Date.now() < malformedDeadline) {
      await delay(10);
    }
    const badFault = pair.sup.faults.find((f) => f.pluginId === 'bad');
    detail.malformed = {
      code: badFault?.code ?? null,
      siblingAlive: pair.sup.children.get('good').exitCode == null,
      siblingRoundTrip: await roundTrip(pair.stub, good.credential),
    };

    pair.sup.spawn({ pluginId: 'nt', script: child('never-terminating') });
    const ntDeadline = Date.now() + 15_000;
    while (!pair.sup.faults.some((f) => f.pluginId === 'nt') && Date.now() < ntDeadline) {
      await delay(20);
    }
    const ntFault = pair.sup.faults.find((f) => f.pluginId === 'nt');
    detail.neverTerminated = {
      code: ntFault?.code ?? null,
      pendingBytes: ntFault?.pendingBytes ?? null,
      bounded: Boolean(ntFault) && ntFault.pendingBytes < HARD_FRAME * 2,
      siblingRoundTrip: await roundTrip(pair.stub, good.credential),
    };

    const len = Buffer.alloc(4);
    len.writeUInt32BE(HARD_FRAME + 8, 0);
    pair.stub.socket.write(len);
    const muxDeadline = Date.now() + 2_000;
    while (!pair.sup.framingFault && Date.now() < muxDeadline) await delay(10);
    detail.oversize = {
      code: pair.sup.framingFault,
      limit: HARD_FRAME,
      siblingAlive: pair.sup.children.get('good').exitCode == null,
    };

    const pass = detail.malformed.code === 'NdjsonFramingError'
      && detail.malformed.siblingAlive
      && detail.malformed.siblingRoundTrip
      && detail.neverTerminated.code === 'NdjsonOversizeError'
      && detail.neverTerminated.bounded
      && detail.neverTerminated.siblingRoundTrip
      && detail.oversize.code === 'MuxOversizeError'
      && detail.oversize.siblingAlive;
    return { pass, detail };
  } finally {
    await pair.close();
  }
}
