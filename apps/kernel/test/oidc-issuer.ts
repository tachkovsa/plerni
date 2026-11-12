// SPDX-License-Identifier: Apache-2.0
// Local authorization server for the OIDC suite. oidc-provider 9.13.3.
// The client secret below is a fixed synthetic test value.
import { createServer as createNetServer } from 'node:net';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Provider, type ProviderConfiguration } from 'oidc-provider';

export const CLIENT_ID = 'plerni-test';
export const CLIENT_SECRET = 'synthetic-oidc-secret';
export const REDIRECT_URI = 'http://127.0.0.1:9/kernel/oidc/callback';

export interface TestAccount {
  id: string;
  email: string;
  emailVerified: boolean;
}

export interface TestIssuer {
  issuer: string;
  account: TestAccount;
  close(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close();
        reject(new Error('port missing'));
        return;
      }
      const port = address.port;
      probe.close(() => resolve(port));
    });
  });
}

export async function startTestIssuer(): Promise<TestIssuer> {
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const state: { account: TestAccount } = {
    account: { id: 'subject-1', email: 'none@example.com', emailVerified: true },
  };
  const configuration: ProviderConfiguration = {
    clients: [{
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
    }],
    cookies: { keys: ['synthetic-cookie-key'] },
    pkce: { required: () => true },
    scopes: ['openid', 'email'],
    claims: {
      openid: ['sub'],
      email: ['email', 'email_verified'],
    },
    features: { devInteractions: { enabled: false } },
    async findAccount(_ctx, id) {
      if (id !== state.account.id) return undefined;
      const account = state.account;
      return {
        accountId: id,
        async claims() {
          return {
            sub: id,
            email: account.email,
            email_verified: account.emailVerified,
          };
        },
      };
    },
  };
  const provider = new Provider(issuer, configuration);
  const callback = provider.callback();

  async function finish(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const details = await provider.interactionDetails(req, res);
    if (details.prompt.name === 'login') {
      await provider.interactionFinished(req, res, {
        login: { accountId: state.account.id },
      }, { mergeWithLastSubmission: false });
      return;
    }
    const accountId = details.session?.accountId ?? state.account.id;
    const grant = new provider.Grant({ accountId, clientId: CLIENT_ID });
    grant.addOIDCScope('openid email');
    grant.addOIDCClaims(['email', 'email_verified']);
    const grantId = await grant.save();
    await provider.interactionFinished(req, res, {
      consent: { grantId },
    }, { mergeWithLastSubmission: true });
  }

  const server = createServer((req, res) => {
    const path = req.url?.split('?', 1)[0] ?? '';
    if (path.startsWith('/interaction/')) {
      void finish(req, res).catch(() => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end();
        }
      });
      return;
    }
    callback(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return {
    issuer,
    get account() {
      return state.account;
    },
    set account(value: TestAccount) {
      state.account = value;
    },
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
