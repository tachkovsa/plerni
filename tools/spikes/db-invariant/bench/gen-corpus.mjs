// SPDX-License-Identifier: Apache-2.0
// gen-corpus.mjs N — Kysely corpus and raw-sql baseline for one band.
// Allocation is S=3N, M=floor(1.5N), L=5N-S-M (plan §3.1 A5).
// "2-3 joins" is two or three JOIN clauses. M and L both include
// plugin_lrs_statement. Every Kysely query asserts its inferred row type.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { artifactDir, bandModel } from './band.mjs';

const ENTITY_KEY = '{ id: string; tenant_id: string; label: string }';
const STATEMENT_KEY = '{ id: string; tenant_id: string; payload: Json }';
const JOIN2 = '{ a_id: string; b_id: string; c_id: string }';
const JOIN3 = '{ a_id: string; b_id: string; c_id: string; d_id: string }';
const ST_JOIN2 = '{ s_id: string; a_id: string; b_id: string; payload: Json }';
const ST_JOIN3 = '{ s_id: string; a_id: string; b_id: string; c_id: string; payload: Json }';
const L_SHAPES = ['cte-select', 'cte-modify', 'conditional', 'helper'];
// TypeScript stops control-flow analysis at flow depth 2000 (diagnostic 2563)
// and then types callbacks as implicit any. Band 75 (375 queries) fits in one
// function; band 400 does not. Each part stays well under that limit.
const QUERIES_PER_FUNCTION = 100;
const ENTRY_PARAMS = [
  '  db: Kysely<DB>,',
  '  status: string | undefined,',
  '  cursor: { seq: string; id: string } | undefined,',
];

const ENTITY_VALUES = "{ id, tenant_id: tenant, parent_id: null, label: 'bench', status: 'active', seq: '1', amount: '1.00', note: null }";
const STATEMENT_VALUES = "{ id, tenant_id: tenant, seq: '1', payload: { annex: 'l' } }";

function range(count) {
  return Array.from({ length: count }, (_, i) => i);
}

export function descriptors(n, { sample = false } = {}) {
  const model = bandModel(n);
  const out = [];
  const sTables = sample ? [model.entities[0], model.statement] : model.tables;
  for (const table of sTables) {
    for (const op of ['select', 'insert', 'update']) {
      out.push({ kind: 'S', op, table });
    }
  }
  const mIndices = sample ? [0, 1, 2, 5] : range(model.allocation.m);
  for (const index of mIndices) {
    out.push({
      kind: 'M',
      index,
      joins: index % 2 === 0 ? 2 : 3,
      statement: index % 5 === 0,
      chain: model.chains[index % model.chains.length],
    });
  }
  const lIndices = sample ? [0, 1, 2, 3, 4, 5, 10, 15] : range(model.allocation.l);
  for (const index of lIndices) {
    out.push({
      kind: 'L',
      index,
      shape: L_SHAPES[index % L_SHAPES.length],
      statement: index % 5 === 0,
      table: model.entities[index % model.entities.length],
    });
  }
  return out;
}

function indent(lines, spaces) {
  const pad = ' '.repeat(spaces);
  return lines.map((line) => (line ? pad + line : ''));
}

function block(lines) {
  return ['{', ...indent(lines, 2), '}'];
}

function assertRow(typeLiteral) {
  return [
    'type Row = Awaited<ReturnType<typeof page.executeTakeFirstOrThrow>>;',
    `type _assert = Expect<Equal<Row, ${typeLiteral}>>;`,
  ];
}

function pageTail(alias, rowType) {
  return [
    'if (status !== undefined) {',
    "  q = q.where('a.status', '=', status);",
    '}',
    'if (cursor !== undefined) {',
    '  q = q.where((eb) => eb.or([',
    `    eb('${alias}.seq', '>', cursor.seq),`,
    `    eb.and([eb('${alias}.seq', '=', cursor.seq), eb('${alias}.id', '>', cursor.id)]),`,
    '  ]));',
    '}',
    `const page = q.orderBy('${alias}.seq').orderBy('${alias}.id').limit(50);`,
    ...assertRow(rowType),
  ];
}

function emitS(desc) {
  const { op, table } = desc;
  const name = table.name;
  const lines = [`// shape:S ${op} ${name}`];
  if (table.kind === 'entity' && op === 'select') {
    lines.push(`const page = db.selectFrom('${name}').select(['id', 'tenant_id', 'label']).where('id', '=', id);`);
    lines.push(...assertRow(ENTITY_KEY));
  } else if (table.kind === 'entity' && op === 'insert') {
    lines.push(`const page = db.insertInto('${name}').values(${ENTITY_VALUES}).returning(['id', 'tenant_id', 'label']);`);
    lines.push(...assertRow(ENTITY_KEY));
  } else if (table.kind === 'entity' && op === 'update') {
    lines.push(`const page = db.updateTable('${name}').set({ label: 'next' }).where('id', '=', id).returning(['id', 'tenant_id', 'label']);`);
    lines.push(...assertRow(ENTITY_KEY));
  } else if (op === 'select') {
    lines.push(`const page = db.selectFrom('${name}').select(['id', 'tenant_id', 'payload']).where('id', '=', id);`);
    lines.push(...assertRow(STATEMENT_KEY));
  } else if (op === 'insert') {
    lines.push(`const page = db.insertInto('${name}').values(${STATEMENT_VALUES}).returning(['id', 'tenant_id', 'payload']);`);
    lines.push(...assertRow(STATEMENT_KEY));
  } else {
    lines.push(`const page = db.updateTable('${name}').set({ seq: '2' }).where('id', '=', id).returning(['id', 'tenant_id', 'payload']);`);
    lines.push(...assertRow(STATEMENT_KEY));
  }
  return lines;
}

function emitM(desc) {
  const { joins, statement, chain, index } = desc;
  const lines = [`// shape:M joins=${joins} statement=${statement ? 1 : 0}`];
  if (statement) {
    const tables = chain.slice(0, joins);
    const [a, b, c] = tables;
    lines.push("let q = db.selectFrom('plugin_lrs_statement as s')");
    lines.push(`  .innerJoin('${a.name} as a', 'a.tenant_id', 's.tenant_id')`);
    lines.push(`  .innerJoin('${b.name} as b', 'b.parent_id', 'a.id')`);
    if (joins === 3) lines.push(`  .innerJoin('${c.name} as c', 'c.parent_id', 'b.id')`);
    const cols = joins === 3
      ? "['s.id as s_id', 'a.id as a_id', 'b.id as b_id', 'c.id as c_id', 's.payload as payload']"
      : "['s.id as s_id', 'a.id as a_id', 'b.id as b_id', 's.payload as payload']";
    lines.push(`  .select(${cols})`);
    lines.push("  .where('s.tenant_id', '=', tenant);");
    lines.push(...pageTail('s', joins === 3 ? ST_JOIN3 : ST_JOIN2));
    return lines;
  }
  const width = joins + 1;
  const tables = chain.slice(0, width);
  const [a, b, c, d] = tables;
  if (index === 2) {
    lines.push(`let q = db.selectFrom('${a.name} as a')`);
    lines.push(`  .innerJoin('${b.name} as b', 'b.parent_id', 'a.id')`);
    lines.push(`  .innerJoin('${c.name} as c', 'c.parent_id', 'b.id')`);
    lines.push('  .select((eb) => [');
    lines.push("    eb.ref('a.id').as('a_id'),");
    lines.push("    eb.ref('b.id').as('b_id'),");
    lines.push("    eb.ref('c.id').as('c_id'),");
    lines.push('  ])');
    lines.push("  .where('a.tenant_id', '=', tenant);");
    lines.push(...pageTail('a', JOIN2));
    return lines;
  }
  lines.push(`let q = db.selectFrom('${a.name} as a')`);
  lines.push(`  .innerJoin('${b.name} as b', 'b.parent_id', 'a.id')`);
  lines.push(`  .innerJoin('${c.name} as c', 'c.parent_id', 'b.id')`);
  if (joins === 3) lines.push(`  .innerJoin('${d.name} as d', 'd.parent_id', 'c.id')`);
  const cols = joins === 3
    ? "['a.id as a_id', 'b.id as b_id', 'c.id as c_id', 'd.id as d_id']"
    : "['a.id as a_id', 'b.id as b_id', 'c.id as c_id']";
  lines.push(`  .select(${cols})`);
  lines.push("  .where('a.tenant_id', '=', tenant);");
  lines.push(...pageTail('a', joins === 3 ? JOIN3 : JOIN2));
  return lines;
}

function keysetOnId() {
  return [
    'if (cursor !== undefined) {',
    "  q = q.where('id', '>', cursor.id);",
    '}',
  ];
}

function emitL(desc) {
  const { shape, statement, table } = desc;
  const lines = [`// shape:L ${shape} statement=${statement ? 1 : 0}`];
  if (statement && shape === 'cte-select') {
    lines.push('let q = db.with(\'picked\', (qb) =>');
    lines.push("  qb.selectFrom('plugin_lrs_statement').select(['id', 'tenant_id', 'payload']).where('tenant_id', '=', tenant),");
    lines.push(').selectFrom(\'picked\').select([\'id\', \'tenant_id\', \'payload\']);');
    lines.push(...keysetOnId());
    lines.push('const page = q;');
    lines.push(...assertRow(STATEMENT_KEY));
    return lines;
  }
  if (statement && shape === 'cte-modify') {
    lines.push('const page = db.with(\'inserted\', (qb) =>');
    lines.push(`  qb.insertInto('plugin_lrs_statement').values(${STATEMENT_VALUES}).returning(['id', 'tenant_id', 'payload']),`);
    lines.push(').selectFrom(\'inserted\').select([\'id\', \'tenant_id\', \'payload\']);');
    lines.push(...assertRow(STATEMENT_KEY));
    return lines;
  }
  if (statement && shape === 'conditional') {
    lines.push("let q = db.selectFrom('plugin_lrs_statement').select(['id', 'tenant_id', 'payload']).where('tenant_id', '=', tenant);");
    lines.push('if (cursor !== undefined) {');
    lines.push('  q = q.where((eb) => eb.or([');
    lines.push("    eb('seq', '>', cursor.seq),");
    lines.push("    eb.and([eb('seq', '=', cursor.seq), eb('id', '>', cursor.id)]),");
    lines.push('  ]));');
    lines.push('}');
    lines.push('const page = q;');
    lines.push(...assertRow(STATEMENT_KEY));
    return lines;
  }
  if (statement && shape === 'helper') {
    lines.push("const base = db.selectFrom('plugin_lrs_statement').select(['id', 'tenant_id', 'payload']).where('tenant_id', '=', tenant);");
    lines.push('const page = withOptionalLimit(');
    lines.push('  withKeyset(base, (inner, key) => inner.where((eb) => eb.or([');
    lines.push("    eb('seq', '>', key.seq),");
    lines.push("    eb.and([eb('seq', '=', key.seq), eb('id', '>', key.id)]),");
    lines.push('  ])), cursor),');
    lines.push('  50,');
    lines.push(');');
    lines.push(...assertRow(STATEMENT_KEY));
    return lines;
  }
  const name = table.name;
  if (shape === 'cte-select') {
    lines.push('let q = db.with(\'picked\', (qb) =>');
    lines.push(`  qb.selectFrom('${name}').select(['id', 'tenant_id', 'label']).where('tenant_id', '=', tenant),`);
    lines.push(').selectFrom(\'picked\').select([\'id\', \'tenant_id\', \'label\']);');
    lines.push(...keysetOnId());
    lines.push('const page = q;');
    lines.push(...assertRow(ENTITY_KEY));
    return lines;
  }
  if (shape === 'cte-modify') {
    lines.push('const page = db.with(\'inserted\', (qb) =>');
    lines.push(`  qb.insertInto('${name}').values(${ENTITY_VALUES}).returning(['id', 'tenant_id', 'label']),`);
    lines.push(').selectFrom(\'inserted\').select([\'id\', \'tenant_id\', \'label\']);');
    lines.push(...assertRow(ENTITY_KEY));
    return lines;
  }
  if (shape === 'conditional') {
    lines.push(`let q = db.selectFrom('${name}').select(['id', 'tenant_id', 'label']).where('tenant_id', '=', tenant);`);
    lines.push('if (status !== undefined) {');
    lines.push("  q = q.where('status', '=', status);");
    lines.push('}');
    lines.push('if (cursor !== undefined) {');
    lines.push('  q = q.where((eb) => eb.or([');
    lines.push("    eb('seq', '>', cursor.seq),");
    lines.push("    eb.and([eb('seq', '=', cursor.seq), eb('id', '>', cursor.id)]),");
    lines.push('  ]));');
    lines.push('}');
    lines.push("const page = q.orderBy('seq').orderBy('id').limit(50);");
    lines.push(...assertRow(ENTITY_KEY));
    return lines;
  }
  lines.push(`const base = db.selectFrom('${name}').select(['id', 'tenant_id', 'label']).where('tenant_id', '=', tenant);`);
  lines.push('const page = withOptionalLimit(');
  lines.push('  withKeyset(base, (inner, key) => inner.where((eb) => eb.or([');
  lines.push("    eb('seq', '>', key.seq),");
  lines.push("    eb.and([eb('seq', '=', key.seq), eb('id', '>', key.id)]),");
  lines.push('  ])), cursor),');
  lines.push('  50,');
  lines.push(');');
  lines.push(...assertRow(ENTITY_KEY));
  return lines;
}

function emitQuery(desc) {
  if (desc.kind === 'S') return emitS(desc);
  if (desc.kind === 'M') return emitM(desc);
  return emitL(desc);
}

function statusPredicate(alias) {
  const column = alias ? `${alias}.status` : 'status';
  return `and (\${status}::text is null or ${column} = \${status})`;
}

function keysetPredicate(alias) {
  const seq = alias ? `${alias}.seq` : 'seq';
  const id = alias ? `${alias}.id` : 'id';
  return `and (\${seq}::text is null or ${seq} > \${seq} or (${seq} = \${seq} and ${id} > \${keyId}))`;
}

function orderLimit(alias) {
  const seq = alias ? `${alias}.seq` : 'seq';
  const id = alias ? `${alias}.id` : 'id';
  return `order by ${seq}, ${id} limit 50`;
}

function baselineSql(desc) {
  if (desc.kind === 'S' && desc.table.kind === 'entity' && desc.op === 'select') {
    return { sql: `select id, tenant_id, label from ${desc.table.name} where id = \${id}`, rowType: ENTITY_KEY };
  }
  if (desc.kind === 'S' && desc.table.kind === 'entity' && desc.op === 'insert') {
    return {
      sql: `insert into ${desc.table.name} (id, tenant_id, parent_id, label, status, seq, amount, note) values (\${id}, \${tenant}, null, 'bench', 'active', '1', '1.00', null) returning id, tenant_id, label`,
      rowType: ENTITY_KEY,
    };
  }
  if (desc.kind === 'S' && desc.table.kind === 'entity') {
    return {
      sql: `update ${desc.table.name} set label = 'next' where id = \${id} returning id, tenant_id, label`,
      rowType: ENTITY_KEY,
    };
  }
  if (desc.kind === 'S' && desc.op === 'select') {
    return { sql: `select id, tenant_id, payload from ${desc.table.name} where id = \${id}`, rowType: STATEMENT_KEY };
  }
  if (desc.kind === 'S' && desc.op === 'insert') {
    return {
      sql: `insert into ${desc.table.name} (id, tenant_id, seq, payload) values (\${id}, \${tenant}, '1', '{}'::jsonb) returning id, tenant_id, payload`,
      rowType: STATEMENT_KEY,
    };
  }
  if (desc.kind === 'S') {
    return {
      sql: `update ${desc.table.name} set seq = '2' where id = \${id} returning id, tenant_id, payload`,
      rowType: STATEMENT_KEY,
    };
  }
  if (desc.kind === 'M' && desc.statement) {
    const [a, b, c] = desc.chain;
    const extra = desc.joins === 3 ? ` join ${c.name} c on c.parent_id = b.id` : '';
    const cols = desc.joins === 3
      ? 's.id as s_id, a.id as a_id, b.id as b_id, c.id as c_id, s.payload as payload'
      : 's.id as s_id, a.id as a_id, b.id as b_id, s.payload as payload';
    const sql = `select ${cols} from plugin_lrs_statement s join ${a.name} a on a.tenant_id = s.tenant_id join ${b.name} b on b.parent_id = a.id${extra} where s.tenant_id = \${tenant} ${statusPredicate('a')} ${keysetPredicate('s')} ${orderLimit('s')}`;
    return { sql, rowType: desc.joins === 3 ? ST_JOIN3 : ST_JOIN2 };
  }
  if (desc.kind === 'M') {
    const [a, b, c, d] = desc.chain;
    const extra = desc.joins === 3 ? ` join ${d.name} d on d.parent_id = c.id` : '';
    const cols = desc.joins === 3
      ? 'a.id as a_id, b.id as b_id, c.id as c_id, d.id as d_id'
      : 'a.id as a_id, b.id as b_id, c.id as c_id';
    const sql = `select ${cols} from ${a.name} a join ${b.name} b on b.parent_id = a.id join ${c.name} c on c.parent_id = b.id${extra} where a.tenant_id = \${tenant} ${statusPredicate('a')} ${keysetPredicate('a')} ${orderLimit('a')}`;
    return { sql, rowType: desc.joins === 3 ? JOIN3 : JOIN2 };
  }
  if (desc.statement && desc.shape === 'cte-select') {
    return {
      sql: `with picked as (select id, tenant_id, payload from plugin_lrs_statement where tenant_id = \${tenant}) select id, tenant_id, payload from picked where (\${keyId}::text is null or id > \${keyId})`,
      rowType: STATEMENT_KEY,
    };
  }
  if (desc.statement && desc.shape === 'cte-modify') {
    return {
      sql: `with inserted as (insert into plugin_lrs_statement (id, tenant_id, seq, payload) values (\${id}, \${tenant}, '1', '{}'::jsonb) returning id, tenant_id, payload) select id, tenant_id, payload from inserted`,
      rowType: STATEMENT_KEY,
    };
  }
  if (desc.statement && desc.shape === 'conditional') {
    return {
      sql: `select id, tenant_id, payload from plugin_lrs_statement where tenant_id = \${tenant} ${keysetPredicate('')}`,
      rowType: STATEMENT_KEY,
    };
  }
  if (desc.statement && desc.shape === 'helper') {
    return {
      sql: `select id, tenant_id, payload from plugin_lrs_statement where tenant_id = \${tenant} ${keysetPredicate('')} limit 50`,
      rowType: STATEMENT_KEY,
    };
  }
  const name = desc.table.name;
  if (desc.shape === 'cte-select') {
    return {
      sql: `with picked as (select id, tenant_id, label from ${name} where tenant_id = \${tenant}) select id, tenant_id, label from picked where (\${keyId}::text is null or id > \${keyId})`,
      rowType: ENTITY_KEY,
    };
  }
  if (desc.shape === 'cte-modify') {
    return {
      sql: `with inserted as (insert into ${name} (id, tenant_id, parent_id, label, status, seq, amount, note) values (\${id}, \${tenant}, null, 'bench', 'active', '1', '1.00', null) returning id, tenant_id, label) select id, tenant_id, label from inserted`,
      rowType: ENTITY_KEY,
    };
  }
  if (desc.shape === 'conditional') {
    return {
      sql: `select id, tenant_id, label from ${name} where tenant_id = \${tenant} ${statusPredicate('')} ${keysetPredicate('')} ${orderLimit('')}`,
      rowType: ENTITY_KEY,
    };
  }
  return {
    sql: `select id, tenant_id, label from ${name} where tenant_id = \${tenant} ${keysetPredicate('')} limit 50`,
    rowType: ENTITY_KEY,
  };
}

function emitBaseline(desc) {
  const { sql, rowType } = baselineSql(desc);
  const marker = desc.kind === 'S'
    ? `// shape:S ${desc.op} ${desc.table.name}`
    : desc.kind === 'M'
      ? `// shape:M joins=${desc.joins} statement=${desc.statement ? 1 : 0}`
      : `// shape:L ${desc.shape} statement=${desc.statement ? 1 : 0}`;
  const prelude = [];
  if (sql.includes('${seq}')) prelude.push('const seq = cursor === undefined ? null : cursor.seq;');
  if (sql.includes('${keyId}')) prelude.push('const keyId = cursor === undefined ? null : cursor.id;');
  return [
    marker,
    ...prelude,
    `void sql<${rowType}>\`${sql}\`.execute(db);`,
  ];
}

function relImport(fromDir, toFile) {
  let rel = relative(fromDir, toFile);
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel.split('\\').join('/');
}

function helpers() {
  return [
    'type Expect<T extends true> = T;',
    'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;',
    '',
    'function withOptionalLimit<TB extends keyof DB, O>(',
    '  qb: SelectQueryBuilder<DB, TB, O>,',
    '  n: number | undefined,',
    '): SelectQueryBuilder<DB, TB, O> {',
    '  if (n === undefined) return qb;',
    '  return qb.limit(n);',
    '}',
    '',
    'function withKeyset<TB extends keyof DB, O>(',
    '  qb: SelectQueryBuilder<DB, TB, O>,',
    '  apply: (',
    '    inner: SelectQueryBuilder<DB, TB, O>,',
    '    key: { seq: string; id: string },',
    '  ) => SelectQueryBuilder<DB, TB, O>,',
    '  key: { seq: string; id: string } | undefined,',
    '): SelectQueryBuilder<DB, TB, O> {',
    '  if (key === undefined) return qb;',
    '  return apply(qb, key);',
    '}',
    '',
  ];
}

function chunk(items, size) {
  const groups = [];
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size));
  return groups;
}

function fn(name, exported, body) {
  return [
    `${exported ? 'export ' : ''}function ${name}(`,
    ...ENTRY_PARAMS,
    '): void {',
    ...indent(body, 2),
    '}',
    '',
  ];
}

export function renderSources(n, { outDir, sample = false }) {
  const model = bandModel(n);
  const items = descriptors(n, { sample });
  const typesImport = relImport(outDir, join(artifactDir(n), 'database-types.ts'));
  const header = [
    '// Generated by tools/spikes/db-invariant/bench/gen-corpus.mjs',
    `// Band N=${n}. S=${model.allocation.s} M=${model.allocation.m} L=${model.allocation.l}.`,
    `// Queries are grouped ${QUERIES_PER_FUNCTION} per function (compiler control-flow depth).`,
    '// Plan §3.1 A5. Do not edit.',
    '',
  ];
  const groups = chunk(items, QUERIES_PER_FUNCTION);
  const ids = [
    "const id = '00000000-0000-4000-8000-000000000002';",
    "const tenant = '00000000-0000-4000-8000-000000000001';",
  ];
  const corpusFns = groups.flatMap((group, i) => fn(`acceptanceCorpusPart${i}`, false, [
    ...ids,
    ...(i === 0
      ? ["void sql`select set_config('plerni.tenant_id', ${tenant}, true)`.execute(db);"]
      : []),
    ...group.flatMap((desc) => block(emitQuery(desc))),
  ]));
  const corpus = [
    ...header,
    "import { sql, type Kysely, type SelectQueryBuilder } from 'kysely';",
    `import type { DB, Json } from '${typesImport}';`,
    '',
    ...helpers(),
    ...corpusFns,
    ...fn(
      'acceptanceCorpus',
      true,
      groups.map((_, i) => `acceptanceCorpusPart${i}(db, status, cursor);`),
    ),
  ].join('\n');
  const baselineFns = groups.flatMap((group, i) => fn(`acceptanceBaselinePart${i}`, false, [
    ...ids,
    ...group.flatMap((desc) => block(emitBaseline(desc))),
  ]));
  const baseline = [
    ...header,
    "import { sql, type Kysely } from 'kysely';",
    `import type { DB, Json } from '${typesImport}';`,
    '',
    ...baselineFns,
    ...fn(
      'acceptanceBaseline',
      true,
      groups.map((_, i) => `acceptanceBaselinePart${i}(db, status, cursor);`),
    ),
  ].join('\n');
  return { corpus, baseline, allocation: model.allocation, queryCount: items.length };
}

function tsconfig(extendsPath, file) {
  return `${JSON.stringify({ extends: extendsPath, files: [file] }, null, 2)}\n`;
}

export function renderCorpus(n, { outDir, sample = false } = {}) {
  const dir = outDir ?? join(artifactDir(n), '..', '..', 'out', `band-${n}`);
  mkdirSync(dir, { recursive: true });
  const { corpus, baseline, allocation: alloc, queryCount } = renderSources(n, { outDir: dir, sample });
  const corpusPath = join(dir, 'corpus.ts');
  const baselinePath = join(dir, 'baseline.ts');
  writeFileSync(corpusPath, corpus);
  writeFileSync(baselinePath, baseline);
  const benchTsconfig = join(artifactDir(n), '..', '..', 'tsconfig.bench.json');
  const extendsPath = relImport(dir, benchTsconfig);
  writeFileSync(join(dir, 'tsconfig.corpus.json'), tsconfig(extendsPath, 'corpus.ts'));
  writeFileSync(join(dir, 'tsconfig.baseline.json'), tsconfig(extendsPath, 'baseline.ts'));
  return { dir, corpusPath, baselinePath, allocation: alloc, queryCount };
}

export function countShapes(source) {
  const count = (kind) => source.split(`// shape:${kind}`).length - 1;
  return { S: count('S'), M: count('M'), L: count('L') };
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (invokedDirectly()) {
  const n = Number(process.argv[2]);
  const outFlag = process.argv.indexOf('--out');
  const outDir = outFlag === -1 ? undefined : process.argv[outFlag + 1];
  const written = renderCorpus(n, outDir ? { outDir } : {});
  console.log(`gen-corpus: band ${n} ${written.queryCount} queries in ${written.dir}`);
}
