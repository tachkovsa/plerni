// SPDX-License-Identifier: Apache-2.0
import * as kysely from 'kysely';

const raw = kysely.sql;
raw`select 1`;
