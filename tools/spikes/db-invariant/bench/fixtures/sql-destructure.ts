// SPDX-License-Identifier: Apache-2.0
import * as kysely from 'kysely';

const { sql: raw } = kysely;
raw`select 1`;
