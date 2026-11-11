// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import { bootstrapInstallation } from '../src/identity/bootstrap.ts';
import type { IdentityContext } from '../src/identity/context.ts';
import { disableUser } from '../src/identity/disable.ts';
import {
  AccountDisabledError,
  BootstrapClosedError,
  BootstrapRejectedError,
  FreshnessExpiredError,
  IdentityForbiddenError,
  IdentityValidationError,
  LoginRejectedError,
  SessionRejectedError,
  ThrottledError,
} from '../src/identity/errors.ts';
import { createIdentityLog } from '../src/identity/log.ts';
import { login } from '../src/identity/login.ts';
import { hashPassword, verifyPassword } from '../src/identity/password.ts';
import { confirmPasswordReset, recoverWithRescueCode, requestPasswordReset } from '../src/identity/recovery.ts';
import { RESCUE_CODE_COUNT } from '../src/identity/rescue.ts';
import { authenticate, logout, refreshSession } from '../src/identity/session.ts';
import { createUser, setStrictDisable } from '../src/identity/users.ts';
import { blankEvidence, type HygieneEvidence } from '../src/tenancy/hygiene.ts';
import { MAX_RETRY } from '../src/tenancy/constants.ts';
import { DIRECT, POOLED, ROOT, appDb, ready, terminate } from './support.ts';

const here = dirname(fileURLToPath(import.meta.url));

function secret(): string {
  return randomBytes(18).toString('hex');
}

function email(label: string): string {
  return `${label}.${randomBytes(3).toString('hex')}@example.com`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

class Sink {
  readonly lines: string[] = [];
  readonly log = createIdentityLog((line) => {
    this.lines.push(line);
  });

  text(): string {
    return this.lines.join('\n');
  }
}

function context(sink: Sink): { evidence: HygieneEvidence; ctx: IdentityContext } {
  const evidence = blankEvidence();
  return { evidence, ctx: { evidence, terminate, log: sink.log } };
}

async function withCredential<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.PLERNI_BOOTSTRAP_CREDENTIAL;
  process.env.PLERNI_BOOTSTRAP_CREDENTIAL = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.PLERNI_BOOTSTRAP_CREDENTIAL;
    else process.env.PLERNI_BOOTSTRAP_CREDENTIAL = previous;
  }
}

async function withRoot<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: ROOT });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function resetIdentity(): Promise<void> {
  await withRoot(async (client) => {
    await client.query('DELETE FROM kernel.password_reset');
    await client.query('DELETE FROM kernel.rescue_code');
    await client.query('DELETE FROM kernel.session');
    await client.query('DELETE FROM kernel.login_throttle');
    await client.query('DELETE FROM kernel.auth_audit');
    await client.query('DELETE FROM kernel.user_auth_state');
    await client.query('DELETE FROM kernel.user_account');
    await client.query('DELETE FROM kernel.tenant_auth_policy');
    await client.query('DELETE FROM kernel.tenant_idempotency');
    await client.query('DELETE FROM kernel.audit_record');
    await client.query('DELETE FROM kernel.outbox');
    await client.query('DELETE FROM kernel.tenants');
    await client.query('UPDATE kernel.bootstrap_state SET consumed_at = NULL');
  });
}

async function counts(): Promise<{ tenants: number; users: number; consumed: boolean }> {
  return withRoot(async (client) => {
    const result = await client.query<{ tenants: string; users: string; consumed: boolean }>(
      `SELECT
         (SELECT count(*) FROM kernel.tenants)::text AS tenants,
         (SELECT count(*) FROM kernel.user_account)::text AS users,
         (consumed_at IS NOT NULL) AS consumed
       FROM kernel.bootstrap_state`,
    );
    const row = result.rows[0];
    if (!row) throw new Error('bootstrap state missing');
    return { tenants: Number(row.tenants), users: Number(row.users), consumed: row.consumed };
  });
}

function hides(haystack: string, values: readonly string[]): void {
  for (const value of values) {
    assert.equal(haystack.includes(value), false);
  }
}

function spyConsole(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const orig = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
  };
  const push = (...args: unknown[]): void => {
    lines.push(args.map((item) => String(item)).join(' '));
  };
  console.log = push;
  console.error = push;
  console.warn = push;
  console.info = push;
  return {
    text: () => lines.join('\n'),
    restore: () => {
      console.log = orig.log;
      console.error = orig.error;
      console.warn = orig.warn;
      console.info = orig.info;
    },
  };
}

test('argon2id phc does not contain the password', async () => {
  const password = `pw-${randomBytes(8).toString('hex')}`;
  const encoded = await hashPassword(password);
  assert.equal(encoded.startsWith('$argon2id$v=19$m=19456,t=2,p=1$'), true);
  assert.equal(encoded.includes(password), false);
  assert.equal(await verifyPassword(encoded, password), true);
  assert.equal(await verifyPassword(encoded, `${password}x`), false);
  assert.equal(await verifyPassword(encoded.replace('m=19456', 'm=19457'), password), false);
});

test('the identity log drops secrets and keeps ids', () => {
  const sink = new Sink();
  const password = secret();
  const token = secret();
  sink.log.event('login.rejected', {
    userId: token,
    outcome: password,
    action: 'login',
    tenantId: '11111111-1111-4111-8111-111111111111',
  });
  sink.log.event('not a safe name', { action: 'login' });
  const text = sink.text();
  hides(text, [password, token]);
  assert.match(text, /"event":"login.rejected"/);
  assert.match(text, /11111111-1111-4111-8111-111111111111/);
  assert.equal(text.includes('not a safe name'), false);
});

test('identity sources take no advisory lock and do not call the console', () => {
  const dir = join(here, '../src/identity');
  const bodies = readdirSync(dir).filter((name) => name.endsWith('.ts')).map((name) => readFileSync(join(dir, name), 'utf8'));
  bodies.push(readFileSync(join(here, '../sql/0004_local_identity.sql'), 'utf8'));
  for (const body of bodies) {
    assert.equal(/pg_advisory/i.test(body), false);
    assert.equal(body.includes('console.'), false);
  }
});

let chain: Promise<void> = Promise.resolve();

function serial(name: string, fn: () => Promise<void>): void {
  test(name, async () => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    await run;
  });
}

serial('catalog: identity tables are forced rls and runtime roles have no bypass', async () => {
  await ready();
  await withRoot(async (client) => {
    const tables = await client.query<{ relname: string; relforcerowsecurity: boolean; policies: string }>(
      `SELECT c.relname, c.relforcerowsecurity, count(pol.polname)::text AS policies
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_policy pol ON pol.polrelid = c.oid
       WHERE n.nspname = 'kernel'
         AND c.relname IN ('user_account', 'user_auth_state', 'session', 'rescue_code', 'auth_audit')
       GROUP BY c.relname, c.relforcerowsecurity
       ORDER BY c.relname`,
    );
    assert.equal(tables.rows.length, 5);
    assert.equal(tables.rows.every((row) => row.relforcerowsecurity && row.policies === '1'), true);
    const marker = await client.query<{ relrowsecurity: boolean }>(
      `SELECT c.relrowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'kernel' AND c.relname = 'bootstrap_state'`,
    );
    assert.equal(marker.rows[0]?.relrowsecurity, false);
    const roles = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'plerni\\_%' ESCAPE '\\'`,
    );
    assert.equal(roles.rows.every((role) => role.rolsuper === false && role.rolbypassrls === false), true);
  });
});

serial('a wrong bootstrap credential writes nothing and is not logged', async () => {
  await ready();
  await resetIdentity();
  const credential = secret();
  const wrong = secret();
  const password = secret();
  const sink = new Sink();
  const spy = spyConsole();
  try {
    await withCredential(credential, async () => {
      const { ctx } = context(sink);
      await assert.rejects(
        () => bootstrapInstallation(appDb(POOLED, 1), {
          credential: wrong,
          operatorEmail: email('operator'),
          operatorPassword: password,
          customerEmail: email('customer'),
          customerPassword: password,
        }, ctx),
        (error: unknown) => error instanceof BootstrapRejectedError && !String(error).includes(wrong),
      );
    });
    assert.deepEqual(await counts(), { tenants: 0, users: 0, consumed: false });
    hides(`${sink.text()}\n${spy.text()}`, [credential, wrong, password]);
  } finally {
    spy.restore();
  }
});

async function core(connection: string): Promise<void> {
  await ready();
  await resetIdentity();
  const credential = secret();
  const operatorPassword = secret();
  const customerPassword = secret();
  const memberPassword = secret();
  const sink = new Sink();
  const db = appDb(connection, 1);
  const secrets = [credential, operatorPassword, customerPassword, memberPassword];
  try {
    const installed = await withCredential(credential, () => {
      const { ctx } = context(sink);
      return bootstrapInstallation(db, {
        credential,
        operatorEmail: email('operator'),
        operatorPassword,
        customerEmail: email('customer'),
        customerPassword,
      }, ctx);
    });
    secrets.push(...installed.operator.rescueCodes, ...installed.customer.rescueCodes);
    assert.equal(installed.operator.rescueCodes.length, RESCUE_CODE_COUNT);
    assert.notEqual(installed.operator.tenantId, installed.customer.tenantId);
    const after = await counts();
    assert.equal(after.tenants, 2);
    assert.equal(after.users, 2);
    assert.equal(after.consumed, true);
    await withCredential(credential, async () => {
      const { ctx } = context(sink);
      await assert.rejects(
        () => bootstrapInstallation(db, {
          credential,
          operatorEmail: email('operator'),
          operatorPassword,
          customerEmail: email('customer'),
          customerPassword,
        }, ctx),
        (error: unknown) => error instanceof BootstrapClosedError,
      );
    });
    assert.deepEqual(await counts(), after);

    const stored = await withRoot(async (client) => client.query<{ password_hash: string; code_hash: string }>(
      `SELECT u.password_hash, r.code_hash
       FROM kernel.user_account u
       JOIN kernel.rescue_code r ON r.tenant_id = u.tenant_id AND r.user_id = u.id
       WHERE u.id = $1`,
      [installed.customer.userId],
    ));
    for (const row of stored.rows) {
      assert.equal(row.password_hash.startsWith('$argon2id$'), true);
      assert.equal(row.code_hash.startsWith('$argon2id$'), true);
      hides(row.password_hash, [customerPassword, ...installed.customer.rescueCodes]);
      hides(row.code_hash, [customerPassword, ...installed.customer.rescueCodes]);
    }

    const { ctx: customerCtx } = context(sink);
    const customer = await login(db, {
      tenantId: installed.customer.tenantId,
      email: (await withRoot(async (client) => {
        const result = await client.query<{ email: string }>(
          'SELECT email FROM kernel.user_account WHERE id = $1',
          [installed.customer.userId],
        );
        return result.rows[0]?.email ?? '';
      })),
      password: customerPassword,
    }, customerCtx);
    secrets.push(customer.token);
    const memberEmail = email('member');
    const created = await createUser(db, {
      tenantId: installed.customer.tenantId,
      token: customer.token,
    }, { email: memberEmail, password: memberPassword }, context(sink).ctx);
    secrets.push(...created.rescueCodes);
    const member = await login(db, {
      tenantId: installed.customer.tenantId,
      email: memberEmail,
      password: memberPassword,
    }, context(sink).ctx);
    secrets.push(member.token);
    const seen = await authenticate(db, {
      tenantId: installed.customer.tenantId,
      token: member.token,
      routeClass: 'read',
    }, context(sink).ctx);
    assert.equal(seen.validation, 'lease');
    assert.equal(seen.userId, created.userId);

    const { ctx: failCtx } = context(sink);
    await disableUser(db, {
      tenantId: installed.customer.tenantId,
      token: customer.token,
    }, created.userId, failCtx, {
      afterWrite: async () => {
        throw new Error('stop');
      },
    }).catch((error: unknown) => {
      assert.equal(error instanceof Error && error.message === 'stop', true);
    });
    const still = await authenticate(db, {
      tenantId: installed.customer.tenantId,
      token: member.token,
      routeClass: 'read',
    }, context(sink).ctx);
    assert.equal(still.userId, created.userId);
    const epochDuring = await withRoot(async (client) => client.query<{ epoch: string; revoked: boolean }>(
      `SELECT s.revocation_epoch::text AS epoch, (sess.revoked_at IS NOT NULL) AS revoked
       FROM kernel.user_auth_state s
       JOIN kernel.session sess ON sess.tenant_id = s.tenant_id AND sess.user_id = s.id
       WHERE s.id = $1 AND sess.token_hash = $2`,
      [created.userId, sha256(member.token)],
    ));
    assert.equal(epochDuring.rows[0]?.epoch, '0');
    assert.equal(epochDuring.rows[0]?.revoked, false);

    const listener = new pg.Client({ connectionString: DIRECT });
    await listener.connect();
    try {
      await listener.query('LISTEN plerni_identity');
      const notice = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('identity notify timed out')), 5_000);
        listener.once('notification', (msg) => {
          clearTimeout(timer);
          resolve(msg.payload);
        });
      });
      const disabled = await disableUser(db, {
        tenantId: installed.customer.tenantId,
        token: customer.token,
      }, created.userId, context(sink).ctx);
      assert.equal(disabled.epochBefore, 0);
      assert.equal(disabled.epochAfter, 1);
      assert.equal(await notice, '');
    } finally {
      await listener.end();
    }
    await assert.rejects(
      () => authenticate(db, {
        tenantId: installed.customer.tenantId,
        token: member.token,
        routeClass: 'read',
      }, context(sink).ctx),
      (error: unknown) => error instanceof SessionRejectedError && !String(error).includes(member.token),
    );
    const epochAfter = await withRoot(async (client) => client.query<{
      epoch: string;
      revoked: boolean;
      audits: string;
      records: string;
    }>(
      `SELECT s.revocation_epoch::text AS epoch,
              bool_or(sess.revoked_at IS NOT NULL)::text AS revoked,
              (SELECT count(*) FROM kernel.auth_audit a
                WHERE a.target_user_id = $1 AND a.action = 'disable')::text AS audits,
              (SELECT count(*) FROM kernel.audit_record r
                WHERE r.action = 'kernel.identity.disabled')::text AS records
       FROM kernel.user_auth_state s
       JOIN kernel.session sess ON sess.tenant_id = s.tenant_id AND sess.user_id = s.id
       WHERE s.id = $1
       GROUP BY s.revocation_epoch`,
      [created.userId],
    ));
    assert.equal(epochAfter.rows[0]?.epoch, '1');
    assert.equal(epochAfter.rows[0]?.revoked, 'true');
    assert.equal(Number(epochAfter.rows[0]?.audits) >= 1, true);
    assert.equal(Number(epochAfter.rows[0]?.records) >= 1, true);
    hides(sink.text(), secrets);
  } finally {
    await db.destroy();
  }
}

serial('pooled: bootstrap, epoch bump, revoke, and no secret in the log', async () => {
  await core(POOLED);
});

serial('direct: bootstrap, epoch bump, revoke, and no secret in the log', async () => {
  await core(DIRECT);
});

serial('pooled: freshness, epoch mismatch, rescue, reset, throttle, and lease miss', async () => {
  await ready();
  await resetIdentity();
  const credential = secret();
  const operatorPassword = secret();
  const customerPassword = secret();
  const memberPassword = secret();
  const nextPassword = secret();
  const resetPassword = secret();
  const sink = new Sink();
  const db = appDb(POOLED, 1);
  const secrets = [credential, operatorPassword, customerPassword, memberPassword, nextPassword, resetPassword];
  try {
    const installed = await withCredential(credential, () => bootstrapInstallation(db, {
      credential,
      operatorEmail: email('operator'),
      operatorPassword,
      customerEmail: email('customer'),
      customerPassword,
    }, context(sink).ctx));
    secrets.push(...installed.customer.rescueCodes);
    const customerEmail = await withRoot(async (client) => {
      const result = await client.query<{ email: string }>(
        'SELECT email FROM kernel.user_account WHERE id = $1',
        [installed.customer.userId],
      );
      return result.rows[0]?.email ?? '';
    });
    const customer = await login(db, {
      tenantId: installed.customer.tenantId,
      email: customerEmail,
      password: customerPassword,
    }, context(sink).ctx);
    secrets.push(customer.token);
    assert.equal((await authenticate(db, {
      tenantId: installed.customer.tenantId,
      token: customer.token,
      routeClass: 'sensitive',
    }, context(sink).ctx)).validation, 'per_request');
    const memberEmail = email('member');
    const created = await createUser(db, {
      tenantId: installed.customer.tenantId,
      token: customer.token,
    }, { email: memberEmail, password: memberPassword }, context(sink).ctx);
    const member = await login(db, {
      tenantId: installed.customer.tenantId,
      email: memberEmail,
      password: memberPassword,
    }, context(sink).ctx);
    secrets.push(member.token);
    await withRoot(async (client) => {
      await client.query(
        `UPDATE kernel.session SET fresh_until = clock_timestamp() - interval '1 minute'
         WHERE token_hash = $1`,
        [sha256(member.token)],
      );
    });
    await assert.rejects(
      () => authenticate(db, {
        tenantId: installed.customer.tenantId,
        token: member.token,
        routeClass: 'read',
      }, context(sink).ctx),
      (error: unknown) => error instanceof FreshnessExpiredError,
    );
    await refreshSession(db, { tenantId: installed.customer.tenantId, token: member.token }, context(sink).ctx);
    assert.equal((await authenticate(db, {
      tenantId: installed.customer.tenantId,
      token: member.token,
      routeClass: 'read',
    }, context(sink).ctx)).validation, 'lease');
    await withRoot(async (client) => {
      await client.query(
        'UPDATE kernel.user_auth_state SET revocation_epoch = revocation_epoch + 1 WHERE id = $1',
        [created.userId],
      );
    });
    await assert.rejects(
      () => authenticate(db, {
        tenantId: installed.customer.tenantId,
        token: member.token,
        routeClass: 'read',
      }, context(sink).ctx),
      (error: unknown) => error instanceof SessionRejectedError,
    );
    const again = await login(db, {
      tenantId: installed.customer.tenantId,
      email: memberEmail,
      password: memberPassword,
    }, context(sink).ctx);
    secrets.push(again.token);
    const staleLease = {
      read: () => ({ epoch: '0', freshUntilMs: Date.now() + 60_000 }),
    };
    const staleCtx = context(sink).ctx;
    await assert.rejects(
      () => authenticate(db, {
        tenantId: installed.customer.tenantId,
        token: again.token,
        routeClass: 'read',
      }, { ...staleCtx, lease: staleLease }),
      (error: unknown) => error instanceof SessionRejectedError,
    );
    const code = installed.customer.rescueCodes[0];
    if (!code) throw new Error('rescue code missing');
    await recoverWithRescueCode(db, {
      tenantId: installed.customer.tenantId,
      email: customerEmail,
      code,
      password: nextPassword,
    }, context(sink).ctx);
    await assert.rejects(
      () => authenticate(db, {
        tenantId: installed.customer.tenantId,
        token: customer.token,
        routeClass: 'sensitive',
      }, context(sink).ctx),
      (error: unknown) => error instanceof SessionRejectedError,
    );
    await assert.rejects(
      () => recoverWithRescueCode(db, {
        tenantId: installed.customer.tenantId,
        email: customerEmail,
        code,
        password: nextPassword,
      }, context(sink).ctx),
      (error: unknown) => error instanceof LoginRejectedError,
    );
    const replaced = await login(db, {
      tenantId: installed.customer.tenantId,
      email: customerEmail,
      password: nextPassword,
    }, context(sink).ctx);
    secrets.push(replaced.token);
    const reset = await requestPasswordReset(db, {
      tenantId: installed.customer.tenantId,
      email: customerEmail,
    }, context(sink).ctx);
    if (!reset.token) throw new Error('reset token missing');
    secrets.push(reset.token);
    await confirmPasswordReset(db, {
      tenantId: installed.customer.tenantId,
      token: reset.token,
      password: resetPassword,
    }, context(sink).ctx);
    await assert.rejects(
      () => authenticate(db, {
        tenantId: installed.customer.tenantId,
        token: replaced.token,
        routeClass: 'read',
      }, context(sink).ctx),
      (error: unknown) => error instanceof SessionRejectedError,
    );
    const badEmail = email('absent');
    const badPassword = secret();
    secrets.push(badPassword);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await assert.rejects(
        () => login(db, {
          tenantId: installed.customer.tenantId,
          email: badEmail,
          password: badPassword,
        }, context(sink).ctx),
        (error: unknown) => error instanceof LoginRejectedError,
      );
    }
    await assert.rejects(
      () => login(db, {
        tenantId: installed.customer.tenantId,
        email: badEmail,
        password: badPassword,
      }, context(sink).ctx),
      (error: unknown) => error instanceof ThrottledError,
    );
    await setStrictDisable(db, {
      tenantId: installed.customer.tenantId,
      token: (await login(db, {
        tenantId: installed.customer.tenantId,
        email: customerEmail,
        password: resetPassword,
      }, context(sink).ctx)).token,
    }, true, context(sink).ctx);
    const strictMember = await login(db, {
      tenantId: installed.customer.tenantId,
      email: memberEmail,
      password: memberPassword,
    }, context(sink).ctx);
    secrets.push(strictMember.token);
    assert.equal((await authenticate(db, {
      tenantId: installed.customer.tenantId,
      token: strictMember.token,
      routeClass: 'read',
    }, context(sink).ctx)).validation, 'per_request');
    await assert.rejects(
      () => authenticate(db, {
        tenantId: installed.operator.tenantId,
        token: strictMember.token,
        routeClass: 'read',
      }, context(sink).ctx),
      (error: unknown) => error instanceof SessionRejectedError,
    );
    await assert.rejects(
      () => disableUser(db, {
        tenantId: installed.customer.tenantId,
        token: strictMember.token,
      }, installed.customer.userId, context(sink).ctx),
      (error: unknown) => error instanceof IdentityForbiddenError,
    );
    const loggedOut = await login(db, {
      tenantId: installed.operator.tenantId,
      email: (await withRoot(async (client) => {
        const result = await client.query<{ email: string }>(
          'SELECT email FROM kernel.user_account WHERE id = $1',
          [installed.operator.userId],
        );
        return result.rows[0]?.email ?? '';
      })),
      password: operatorPassword,
    }, context(sink).ctx);
    secrets.push(loggedOut.token);
    await logout(db, { tenantId: installed.operator.tenantId, token: loggedOut.token }, context(sink).ctx);
    await assert.rejects(
      () => authenticate(db, {
        tenantId: installed.operator.tenantId,
        token: loggedOut.token,
        routeClass: 'read',
      }, context(sink).ctx),
      (error: unknown) => error instanceof SessionRejectedError,
    );
    const persisted = await withRoot(async (client) => client.query<{ body: string }>(
      `SELECT concat_ws(' ',
         (SELECT string_agg(password_hash, ' ') FROM kernel.user_account),
         (SELECT string_agg(code_hash, ' ') FROM kernel.rescue_code),
         (SELECT string_agg(token_hash, ' ') FROM kernel.session),
         (SELECT string_agg(token_hash, ' ') FROM kernel.password_reset),
         (SELECT string_agg(coalesce(session_hash, '') || ' ' || reason, ' ') FROM kernel.auth_audit),
         (SELECT string_agg(payload::text, ' ') FROM kernel.outbox)
       ) AS body`,
    ));
    hides(`${sink.text()}\n${persisted.rows[0]?.body ?? ''}`, secrets);
    const app = new pg.Client({ connectionString: POOLED });
    await app.connect();
    try {
      await app.query('BEGIN');
      await app.query('SET LOCAL ROLE plerni_plugin_a');
      await assert.rejects(
        () => app.query('SELECT id FROM kernel.user_account'),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === '42501',
      );
      await app.query('ROLLBACK');
      await assert.rejects(
        () => app.query("UPDATE kernel.auth_audit SET reason = 'tamper'"),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === '42501',
      );
    } finally {
      await app.end();
    }
  } finally {
    await db.destroy();
  }
});

serial('a failed bootstrap rolls back and the credential still works', async () => {
  await ready();
  await resetIdentity();
  const credential = secret();
  const password = secret();
  const db = appDb(POOLED, 1);
  try {
    await withCredential(credential, async () => {
      const sink = new Sink();
      await assert.rejects(
        () => bootstrapInstallation(db, {
          credential,
          operatorEmail: email('operator'),
          operatorPassword: password,
          customerEmail: email('customer'),
          customerPassword: password,
        }, context(sink).ctx, {
          afterOperator: async () => {
            throw new Error('stop');
          },
        }),
        (error: unknown) => error instanceof Error && error.message === 'stop',
      );
      assert.deepEqual(await counts(), { tenants: 0, users: 0, consumed: false });
      const installed = await bootstrapInstallation(db, {
        credential,
        operatorEmail: email('operator'),
        operatorPassword: password,
        customerEmail: email('customer'),
        customerPassword: password,
      }, context(sink).ctx);
      assert.equal(installed.operator.rescueCodes.length, RESCUE_CODE_COUNT);
      assert.equal((await counts()).consumed, true);
      hides(sink.text(), [credential, password, ...installed.operator.rescueCodes, ...installed.customer.rescueCodes]);
    });
  } finally {
    await db.destroy();
  }
});

serial('two bootstraps leave one operator and the credential closed', async () => {
  await ready();
  await resetIdentity();
  const credential = secret();
  const password = secret();
  const input = {
    credential,
    operatorEmail: email('operator'),
    operatorPassword: password,
    customerEmail: email('customer'),
    customerPassword: password,
  };
  const left = appDb(POOLED, 1);
  const right = appDb(POOLED, 1);
  try {
    await withCredential(credential, async () => {
      const results = await Promise.allSettled([
        bootstrapInstallation(left, input, context(new Sink()).ctx),
        bootstrapInstallation(right, input, context(new Sink()).ctx),
      ]);
      const fulfilled = results.filter((item) => item.status === 'fulfilled');
      const rejected = results.filter((item) => item.status === 'rejected');
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.equal(rejected[0]?.status === 'rejected' && rejected[0].reason instanceof BootstrapClosedError, true);
      const after = await counts();
      assert.equal(after.tenants, 2);
      assert.equal(after.users, 2);
      assert.equal(after.consumed, true);
    });
  } finally {
    await left.destroy();
    await right.destroy();
  }
});

serial('pooled: bootstrap recovers a leaked plugin role', async () => {
  await ready();
  await resetIdentity();
  const credential = secret();
  const password = secret();
  const db = appDb(POOLED, 1);
  try {
    await sql`SET ROLE plerni_plugin_a`.execute(db);
    const sink = new Sink();
    const { evidence, ctx } = context(sink);
    const installed = await withCredential(credential, () => bootstrapInstallation(db, {
      credential,
      operatorEmail: email('operator'),
      operatorPassword: password,
      customerEmail: email('customer'),
      customerPassword: password,
    }, ctx));
    assert.equal(installed.customer.userId.length > 0, true);
    assert.ok(evidence.attempts >= 2);
    assert.ok(evidence.attempts <= MAX_RETRY + 1);
    assert.equal(evidence.terminatedBackendPids.length, 1);
    hides(sink.text(), [credential, password]);
  } finally {
    await db.destroy();
    await withRoot(async (client) => {
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE usename = 'plerni_app' AND pid <> pg_backend_pid()`,
      );
    });
  }
});

serial('a disabled account stays disabled for rescue and login', async () => {
  await ready();
  await resetIdentity();
  const credential = secret();
  const password = secret();
  const db = appDb(POOLED, 1);
  try {
    const installed = await withCredential(credential, () => bootstrapInstallation(db, {
      credential,
      operatorEmail: email('operator'),
      operatorPassword: password,
      customerEmail: email('customer'),
      customerPassword: password,
    }, context(new Sink()).ctx));
    const customerEmail = await withRoot(async (client) => {
      const result = await client.query<{ email: string }>(
        'SELECT email FROM kernel.user_account WHERE id = $1',
        [installed.customer.userId],
      );
      return result.rows[0]?.email ?? '';
    });
    const operator = await login(db, {
      tenantId: installed.operator.tenantId,
      email: (await withRoot(async (client) => {
        const result = await client.query<{ email: string }>(
          'SELECT email FROM kernel.user_account WHERE id = $1',
          [installed.operator.userId],
        );
        return result.rows[0]?.email ?? '';
      })),
      password,
    }, context(new Sink()).ctx);
    const memberEmail = email('member');
    const memberPassword = secret();
    const created = await createUser(db, {
      tenantId: installed.customer.tenantId,
      token: (await login(db, {
        tenantId: installed.customer.tenantId,
        email: customerEmail,
        password,
      }, context(new Sink()).ctx)).token,
    }, { email: memberEmail, password: memberPassword }, context(new Sink()).ctx);
    await disableUser(db, {
      tenantId: installed.customer.tenantId,
      token: (await login(db, {
        tenantId: installed.customer.tenantId,
        email: customerEmail,
        password,
      }, context(new Sink()).ctx)).token,
    }, created.userId, context(new Sink()).ctx);
    await assert.rejects(
      () => login(db, {
        tenantId: installed.customer.tenantId,
        email: memberEmail,
        password: memberPassword,
      }, context(new Sink()).ctx),
      (error: unknown) => error instanceof AccountDisabledError,
    );
    const code = created.rescueCodes[0];
    if (!code) throw new Error('rescue code missing');
    await assert.rejects(
      () => recoverWithRescueCode(db, {
        tenantId: installed.customer.tenantId,
        email: memberEmail,
        code,
        password: secret(),
      }, context(new Sink()).ctx),
      (error: unknown) => error instanceof AccountDisabledError,
    );
    assert.equal(operator.userId, installed.operator.userId);
    await assert.rejects(
      () => disableUser(db, {
        tenantId: installed.operator.tenantId,
        token: operator.token,
      }, installed.operator.userId, context(new Sink()).ctx),
      (error: unknown) => error instanceof IdentityForbiddenError,
    );
  } finally {
    await db.destroy();
  }
});

function rendezvous(parties: number): () => Promise<void> {
  let arrived = 0;
  let openGate: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  return () => {
    arrived += 1;
    if (arrived >= parties) openGate();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('race barrier timed out')), 10_000);
      void opened.then(() => {
        clearTimeout(timer);
        resolve();
      }, reject);
    });
  };
}

serial('two admins cannot disable each other out of the last enabled admin', async () => {
  await ready();
  await resetIdentity();
  const credential = secret();
  const password = secret();
  const secondPassword = secret();
  const left = appDb(POOLED, 1);
  const right = appDb(POOLED, 1);
  try {
    const installed = await withCredential(credential, () => bootstrapInstallation(left, {
      credential,
      operatorEmail: email('operator'),
      operatorPassword: password,
      customerEmail: email('customer'),
      customerPassword: password,
    }, context(new Sink()).ctx));
    const customerEmail = await withRoot(async (client) => {
      const result = await client.query<{ email: string }>(
        'SELECT email FROM kernel.user_account WHERE id = $1',
        [installed.customer.userId],
      );
      return result.rows[0]?.email ?? '';
    });
    const first = await login(left, {
      tenantId: installed.customer.tenantId,
      email: customerEmail,
      password,
    }, context(new Sink()).ctx);
    const secondEmail = email('admin');
    const second = await createUser(left, {
      tenantId: installed.customer.tenantId,
      token: first.token,
    }, { email: secondEmail, password: secondPassword, kind: 'admin' }, context(new Sink()).ctx);
    const secondSession = await login(right, {
      tenantId: installed.customer.tenantId,
      email: secondEmail,
      password: secondPassword,
    }, context(new Sink()).ctx);
    const arrived = rendezvous(2);
    const actor = { tenantId: installed.customer.tenantId };
    const results = await Promise.allSettled([
      disableUser(left, { ...actor, token: first.token }, first.userId, context(new Sink()).ctx, {
        beforeAdminLock: async () => arrived(),
      }),
      disableUser(right, { ...actor, token: secondSession.token }, second.userId, context(new Sink()).ctx, {
        beforeAdminLock: async () => arrived(),
      }),
    ]);
    const fulfilled = results.filter((item) => item.status === 'fulfilled');
    const rejected = results.filter((item) => item.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(
      rejected[0]?.status === 'rejected' && rejected[0].reason instanceof IdentityForbiddenError,
      true,
    );
    const enabled = await withRoot(async (client) => client.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM kernel.user_account u
       JOIN kernel.user_auth_state s ON s.tenant_id = u.tenant_id AND s.id = u.id
       WHERE u.tenant_id = $1 AND u.kind = 'admin' AND s.disabled_at IS NULL`,
      [installed.customer.tenantId],
    ));
    assert.equal(enabled.rows[0]?.count, '1');
  } finally {
    await left.destroy();
    await right.destroy();
  }
});

serial('recovery throttles before hashing and a used reset token dies with the password', async () => {
  await ready();
  await resetIdentity();
  const credential = secret();
  const password = secret();
  const nextPassword = secret();
  const db = appDb(POOLED, 1);
  try {
    const installed = await withCredential(credential, () => bootstrapInstallation(db, {
      credential,
      operatorEmail: email('operator'),
      operatorPassword: password,
      customerEmail: email('customer'),
      customerPassword: password,
    }, context(new Sink()).ctx));
    const customerEmail = await withRoot(async (client) => {
      const result = await client.query<{ email: string }>(
        'SELECT email FROM kernel.user_account WHERE id = $1',
        [installed.customer.userId],
      );
      return result.rows[0]?.email ?? '';
    });
    await assert.rejects(
      () => recoverWithRescueCode(db, {
        tenantId: installed.customer.tenantId,
        email: customerEmail,
        code: 'not-a-code',
        password: 'x',
      }, context(new Sink()).ctx),
      (error: unknown) => error instanceof LoginRejectedError && !(error instanceof IdentityValidationError),
    );
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await assert.rejects(
        () => recoverWithRescueCode(db, {
          tenantId: installed.customer.tenantId,
          email: customerEmail,
          code: 'AAAA-AAAA-AAAA-AAAA',
          password: 'x',
        }, context(new Sink()).ctx),
        (error: unknown) => error instanceof LoginRejectedError,
      );
    }
    await assert.rejects(
      () => recoverWithRescueCode(db, {
        tenantId: installed.customer.tenantId,
        email: customerEmail,
        code: 'AAAA-AAAA-AAAA-AAAA',
        password: 'x',
      }, context(new Sink()).ctx),
      (error: unknown) => error instanceof ThrottledError,
    );
    const firstReset = await requestPasswordReset(db, {
      tenantId: installed.operator.tenantId,
      email: (await withRoot(async (client) => {
        const result = await client.query<{ email: string }>(
          'SELECT email FROM kernel.user_account WHERE id = $1',
          [installed.operator.userId],
        );
        return result.rows[0]?.email ?? '';
      })),
    }, context(new Sink()).ctx);
    const operatorEmail = await withRoot(async (client) => {
      const result = await client.query<{ email: string }>(
        'SELECT email FROM kernel.user_account WHERE id = $1',
        [installed.operator.userId],
      );
      return result.rows[0]?.email ?? '';
    });
    const secondReset = await requestPasswordReset(db, {
      tenantId: installed.operator.tenantId,
      email: operatorEmail,
    }, context(new Sink()).ctx);
    if (!firstReset.token || !secondReset.token) throw new Error('reset token missing');
    await confirmPasswordReset(db, {
      tenantId: installed.operator.tenantId,
      token: firstReset.token,
      password: nextPassword,
    }, context(new Sink()).ctx);
    await assert.rejects(
      () => confirmPasswordReset(db, {
        tenantId: installed.operator.tenantId,
        token: secondReset.token ?? '',
        password: secret(),
      }, context(new Sink()).ctx),
      (error: unknown) => error instanceof LoginRejectedError,
    );
    const code = installed.operator.rescueCodes[0];
    if (!code) throw new Error('rescue code missing');
    const leftover = await requestPasswordReset(db, {
      tenantId: installed.operator.tenantId,
      email: operatorEmail,
    }, context(new Sink()).ctx);
    if (!leftover.token) throw new Error('reset token missing');
    const leftoverToken = leftover.token;
    const rescuePassword = secret();
    await recoverWithRescueCode(db, {
      tenantId: installed.operator.tenantId,
      email: operatorEmail,
      code,
      password: rescuePassword,
    }, context(new Sink()).ctx);
    await assert.rejects(
      () => confirmPasswordReset(db, {
        tenantId: installed.operator.tenantId,
        token: leftoverToken,
        password: secret(),
      }, context(new Sink()).ctx),
      (error: unknown) => error instanceof LoginRejectedError,
    );
    await login(db, {
      tenantId: installed.operator.tenantId,
      email: operatorEmail,
      password: rescuePassword,
    }, context(new Sink()).ctx);
  } finally {
    await db.destroy();
  }
});

function errorCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if ('code' in current && typeof current.code === 'string') return current.code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

serial('two admins disabling each other leave one enabled admin and do not deadlock', async () => {
  await ready();
  await resetIdentity();
  const credential = secret();
  const password = secret();
  const secondPassword = secret();
  const left = appDb(POOLED, 1);
  const right = appDb(POOLED, 1);
  try {
    const installed = await withCredential(credential, () => bootstrapInstallation(left, {
      credential,
      operatorEmail: email('operator'),
      operatorPassword: password,
      customerEmail: email('customer'),
      customerPassword: password,
    }, context(new Sink()).ctx));
    const customerEmail = await withRoot(async (client) => {
      const result = await client.query<{ email: string }>(
        'SELECT email FROM kernel.user_account WHERE id = $1',
        [installed.customer.userId],
      );
      return result.rows[0]?.email ?? '';
    });
    const first = await login(left, {
      tenantId: installed.customer.tenantId,
      email: customerEmail,
      password,
    }, context(new Sink()).ctx);
    const secondEmail = email('admin');
    const second = await createUser(left, {
      tenantId: installed.customer.tenantId,
      token: first.token,
    }, { email: secondEmail, password: secondPassword, kind: 'admin' }, context(new Sink()).ctx);
    const secondSession = await login(right, {
      tenantId: installed.customer.tenantId,
      email: secondEmail,
      password: secondPassword,
    }, context(new Sink()).ctx);
    const arrived = rendezvous(2);
    const actor = { tenantId: installed.customer.tenantId };
    const results = await Promise.allSettled([
      disableUser(left, { ...actor, token: first.token }, second.userId, context(new Sink()).ctx, {
        beforeAdminLock: async () => arrived(),
      }),
      disableUser(right, { ...actor, token: secondSession.token }, first.userId, context(new Sink()).ctx, {
        beforeAdminLock: async () => arrived(),
      }),
    ]);
    const fulfilled = results.filter((item) => item.status === 'fulfilled');
    const rejected = results.filter((item) => item.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    const reason = rejected[0]?.status === 'rejected' ? rejected[0].reason : undefined;
    assert.notEqual(errorCode(reason), '40P01');
    assert.equal(
      reason instanceof SessionRejectedError || reason instanceof IdentityForbiddenError,
      true,
    );
    const enabled = await withRoot(async (client) => client.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM kernel.user_account u
       JOIN kernel.user_auth_state s ON s.tenant_id = u.tenant_id AND s.id = u.id
       WHERE u.tenant_id = $1 AND u.kind = 'admin' AND s.disabled_at IS NULL`,
      [installed.customer.tenantId],
    ));
    assert.equal(enabled.rows[0]?.count, '1');
  } finally {
    await left.destroy();
    await right.destroy();
  }
});

serial('concurrent rescue attempts reserve at most the throttle limit', async () => {
  await ready();
  await resetIdentity();
  const credential = secret();
  const password = secret();
  const db = appDb(POOLED, 8);
  try {
    const installed = await withCredential(credential, () => bootstrapInstallation(db, {
      credential,
      operatorEmail: email('operator'),
      operatorPassword: password,
      customerEmail: email('customer'),
      customerPassword: password,
    }, context(new Sink()).ctx));
    const customerEmail = await withRoot(async (client) => {
      const result = await client.query<{ email: string }>(
        'SELECT email FROM kernel.user_account WHERE id = $1',
        [installed.customer.userId],
      );
      return result.rows[0]?.email ?? '';
    });
    const arrived = rendezvous(8);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => recoverWithRescueCode(db, {
      tenantId: installed.customer.tenantId,
      email: customerEmail,
      code: 'not-a-code',
      password: 'x',
    }, context(new Sink()).ctx, {
      beforeReserve: async () => arrived(),
    })));
    const rejected = results.filter((item) => item.status === 'rejected' && item.reason instanceof LoginRejectedError);
    const throttled = results.filter((item) => item.status === 'rejected' && item.reason instanceof ThrottledError);
    assert.equal(rejected.length, 5);
    assert.equal(throttled.length, 3);
    const stored = await withRoot(async (client) => client.query<{ failures: number }>(
      'SELECT failures FROM kernel.login_throttle WHERE tenant_id = $1',
      [installed.customer.tenantId],
    ));
    assert.equal(stored.rows[0]?.failures, 5);
  } finally {
    await db.destroy();
  }
});

serial('an expired reset token is refused at consumption', async () => {
  await ready();
  await resetIdentity();
  const credential = secret();
  const password = secret();
  const db = appDb(POOLED, 1);
  try {
    const installed = await withCredential(credential, () => bootstrapInstallation(db, {
      credential,
      operatorEmail: email('operator'),
      operatorPassword: password,
      customerEmail: email('customer'),
      customerPassword: password,
    }, context(new Sink()).ctx));
    const operatorEmail = await withRoot(async (client) => {
      const result = await client.query<{ email: string }>(
        'SELECT email FROM kernel.user_account WHERE id = $1',
        [installed.operator.userId],
      );
      return result.rows[0]?.email ?? '';
    });
    const reset = await requestPasswordReset(db, {
      tenantId: installed.operator.tenantId,
      email: operatorEmail,
    }, context(new Sink()).ctx);
    if (!reset.token) throw new Error('reset token missing');
    const token = reset.token;
    await assert.rejects(
      () => confirmPasswordReset(db, {
        tenantId: installed.operator.tenantId,
        token,
        password: secret(),
      }, context(new Sink()).ctx, {
        afterLookup: async () => {
          await withRoot(async (client) => {
            await client.query(
              `UPDATE kernel.password_reset
               SET expires_at = clock_timestamp() - interval '1 minute'
               WHERE token_hash = $1`,
              [sha256(token)],
            );
          });
        },
      }),
      (error: unknown) => error instanceof LoginRejectedError,
    );
    await login(db, {
      tenantId: installed.operator.tenantId,
      email: operatorEmail,
      password,
    }, context(new Sink()).ctx);
  } finally {
    await db.destroy();
  }
});
