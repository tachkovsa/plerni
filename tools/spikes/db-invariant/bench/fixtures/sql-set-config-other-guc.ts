// SPDX-License-Identifier: Apache-2.0
declare function sql(text: TemplateStringsArray, ...values: unknown[]): unknown;
sql`select set_config('search_path', ${'public'}, true)`;
