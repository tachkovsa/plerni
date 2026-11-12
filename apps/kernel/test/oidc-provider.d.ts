// SPDX-License-Identifier: Apache-2.0
declare module 'oidc-provider' {
  import type { IncomingMessage, ServerResponse } from 'node:http';

  interface Grant {
    addOIDCScope(scope: string): void;
    addOIDCClaims(claims: string[]): void;
    save(): Promise<string>;
  }

  export interface ProviderConfiguration {
    clients: readonly Record<string, unknown>[];
    cookies: { keys: readonly string[] };
    pkce: { required: () => boolean };
    scopes: readonly string[];
    claims: Record<string, readonly string[] | null>;
    features: { devInteractions: { enabled: boolean } };
    findAccount: (
      ctx: unknown,
      id: string,
    ) => Promise<{ accountId: string; claims: () => Promise<Record<string, unknown>> } | undefined>;
  }

  export class Provider {
    constructor(issuer: string, configuration: ProviderConfiguration);
    callback(): (req: IncomingMessage, res: ServerResponse) => void;
    interactionDetails(req: IncomingMessage, res: ServerResponse): Promise<{
      prompt: { name: string };
      session?: { accountId?: string };
    }>;
    interactionFinished(
      req: IncomingMessage,
      res: ServerResponse,
      result: Record<string, unknown>,
      options?: { mergeWithLastSubmission?: boolean },
    ): Promise<void>;
    Grant: {
      new (input: { accountId: string; clientId: string }): Grant;
      find(id: string): Promise<Grant | undefined>;
    };
  }
}
