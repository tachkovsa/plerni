// SPDX-License-Identifier: Apache-2.0
// The pinned search_path is the app role's login default (plan §2). The dev
// harness installs it with ALTER ROLE. SQL in this package is schema-qualified,
// so the pin is a hygiene check, not a name resolver.

export const PINNED_SEARCH_PATH = 'public';

/** Retries after the first contaminated attempt. Attempt 3 fails loud. */
export const MAX_RETRY = 2;

/** Named plerni.* settings inspected before any local override. */
export const CONTEXT_GUCS = ['plerni.tenant_id'] as const;
