// b5-crash.mjs — child exit mid-call is a typed error. The fencing token held at
// crash is not usable by the respawned child (plan §4 B5).

import { fileURLToPath } from 'node:url';
import { FencedError, commitExecution, createExecution, dispatch, getStatus } from '../authority.mjs';
import { connectPair, dbConfigured, useDirectFromEnv } from '../supervisor.mjs';

const crashPath = fileURLToPath(new URL('../children/crash-mid-call.mjs', import.meta.url));

export async function b5({ requireDb = true } = {}) {
  const useDirect = useDirectFromEnv();
  const pair = await connectPair({ sweeper: false, useDirect });
  try {
    const spawned = pair.sup.spawn({ pluginId: 'crash', script: crashPath });
    const err = await pair.stub.call({
      pluginId: 'crash',
      credential: spawned.credential,
      correlationId: 1,
      port: 'db',
      method: 'run',
      payload: { n: 1 },
    }).catch((e) => e);
    const crash = { code: err.code ?? null, exitCode: pair.sup.children.get('crash')?.exitCode ?? null };
    const crashOk = crash.code === 'child-exited' && crash.exitCode === 1;
    if (!dbConfigured()) {
      const token = 'no harness database';
      if (requireDb) return { pass: false, detail: { crash, token } };
      return { pass: crashOk, detail: { crash, token: 'not-run' } };
    }
    const id = await createExecution('b5', spawned.token, useDirect);
    await dispatch(id, useDirect);
    const next = await pair.sup.respawn('crash');
    let refused = false;
    try {
      await pair.sup.commitIfLive(id, spawned.token, async () => {});
    } catch (e) {
      refused = e instanceof FencedError;
    }
    let newTokenFenced = false;
    try {
      await commitExecution(id, next.token, async () => {}, useDirect);
    } catch (e) {
      newTokenFenced = e instanceof FencedError;
    }
    const status = await getStatus(id, useDirect);
    const token = {
      refused,
      newTokenFenced,
      status: status?.status ?? null,
      distinct: next.token !== spawned.token,
    };
    const pass = crashOk && refused && newTokenFenced && token.status === 'ACTIVE' && token.distinct;
    return { pass, detail: { crash, token } };
  } finally {
    await pair.close();
  }
}
