// SPDX-License-Identifier: Apache-2.0
declare function sql<T>(text: TemplateStringsArray, ...values: unknown[]): T;
sql<string>`select set_config('plerni.tenant_id', ${'t'}, true)`;
