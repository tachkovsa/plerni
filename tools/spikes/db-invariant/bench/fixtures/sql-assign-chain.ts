// SPDX-License-Identifier: Apache-2.0
import { sql } from 'kysely';

const raw = sql;
const again = raw;
again`select 1`;
