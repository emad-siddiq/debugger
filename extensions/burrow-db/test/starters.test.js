/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Unit test for the table-info + starter-query SQL builders (out/catalog.js).

'use strict';

const assert = require('node:assert');
const { quoteLiteral, buildColumnsSql, starterQueries } = require('../out/catalog');

assert.strictEqual(quoteLiteral('nodes'), "'nodes'");
assert.strictEqual(quoteLiteral("o'brien"), "'o''brien'");

const columnsSql = buildColumnsSql('public', "weird'name");
assert.ok(columnsSql.includes("table_schema = 'public'"), 'schema literal quoted');
assert.ok(columnsSql.includes("table_name = 'weird''name'"), 'embedded quote escaped');
assert.ok(columnsSql.includes('PRIMARY KEY'), 'PK detection included');
assert.ok(columnsSql.includes('ordinal_position'), 'ordered by position');

const starters = starterQueries('public', 'nodes', 50);
assert.strictEqual(starters.length, 4);
const sqls = starters.map(s => s.sql);
assert.ok(sqls[0].includes('SELECT * FROM "public"."nodes" LIMIT 50'), 'peek uses the preview SQL');
assert.ok(sqls[1].includes('ORDER BY 1 DESC LIMIT 50'), 'recent orders by first column desc');
assert.ok(sqls[2].includes('count(*)'), 'count starter');
assert.ok(sqls[3].includes('information_schema.columns'), 'columns starter reuses the info SQL');

console.log('starters.test.js OK');
