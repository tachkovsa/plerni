// SPDX-License-Identifier: Apache-2.0
declare const sql: { raw: (text: string) => unknown };
sql.raw('select 1');
