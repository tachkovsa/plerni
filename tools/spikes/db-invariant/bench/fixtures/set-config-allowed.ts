// SPDX-License-Identifier: Apache-2.0
import { sql } from 'kysely';

void sql`select set_config('plerni.tenant_id', ${'00000000-0000-4000-8000-000000000001'}, true)`;
