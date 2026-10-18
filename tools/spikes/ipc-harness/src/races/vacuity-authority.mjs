// vacuity-authority (plan T5c): the recovery race with the status='ACTIVE'
// predicate removed. The same barrier, the same two orderings, and the same
// oracle score both the production authority and this variant. The variant's
// pass flag is that score. It is not a constant.

import { vacuousCommit, vacuousSweep } from './control.mjs';
import { productionRecoveryAuthority, runRecoveryRace } from './recovery-vs-live-commit.mjs';
import { insertEffect } from './support.mjs';

function vacuousRecoveryAuthority() {
  return {
    name: 'vacuous',
    commit(id, token, note) {
      return vacuousCommit(id, token, async (client) => {
        await insertEffect(client, id, note);
      });
    },
    sweep(id) {
      return vacuousSweep(id);
    },
  };
}

export async function vacuityAuthority() {
  const real = await runRecoveryRace(productionRecoveryAuthority());
  const open = await runRecoveryRace(vacuousRecoveryAuthority());
  return { real, open };
}
