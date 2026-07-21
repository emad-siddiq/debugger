/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit test for the pure docker CLI parsers. dockerCli.ts imports nothing
// from 'vscode'/'child_process', so out/dockerCli.js is a clean CommonJS module we can
// require directly. Fixtures are captured `docker … --format '{{json .}}'` lines. Run:
// `npm test` (after a compile) or `node test/dockerCli.test.js`.

'use strict';

const assert = require('node:assert');
const {
	parseJsonLines, parseLabels, parseContainers, parseImages, parseVolumes, parseNetworks, groupByProject,
} = require('../out/dockerCli');

// A standalone container (empty Labels) and two compose-managed ones.
const PS = [
	JSON.stringify({ ID: 'aaa', Image: 'alpine/socat', Names: 'nw-db-fwd', State: 'running', Status: 'Up 11 hours', Ports: '0.0.0.0:5432->5432/tcp', Labels: '' }),
	JSON.stringify({ ID: 'bbb', Image: 'timescale/timescaledb:latest-pg16', Names: 'infra-nodewatch-db-1', State: 'running', Status: 'Up 11 hours', Ports: '5432/tcp', Labels: 'com.docker.compose.project=infra,com.docker.compose.service=nodewatch-db' }),
	JSON.stringify({ ID: 'ccc', Image: 'nodewatch-api', Names: 'infra-nodewatch-api-1', State: 'exited', Status: 'Exited (0) 2 hours ago', Ports: '', Labels: 'com.docker.compose.project=infra,com.docker.compose.service=nodewatch-api' }),
].join('\n');

const cases = {
	'parseJsonLines skips blank and malformed lines': () => {
		assert.deepStrictEqual(parseJsonLines('{"a":"1"}\n\nnot json\n{"b":"2"}'), [{ a: '1' }, { b: '2' }]);
	},
	'parseLabels splits k=v,k2=v2 into a map': () => {
		assert.deepStrictEqual(parseLabels('com.docker.compose.project=infra,com.docker.compose.service=db'), {
			'com.docker.compose.project': 'infra',
			'com.docker.compose.service': 'db',
		});
	},
	'parseLabels returns an empty map for an empty string': () => {
		assert.deepStrictEqual(parseLabels(''), {});
	},
	'parseContainers maps fields and derives running + compose project': () => {
		const cs = parseContainers(PS);
		assert.strictEqual(cs.length, 3);
		assert.deepStrictEqual(
			{ name: cs[0].name, running: cs[0].running, project: cs[0].project },
			{ name: 'nw-db-fwd', running: true, project: undefined },
		);
		assert.deepStrictEqual(
			{ name: cs[1].name, running: cs[1].running, project: cs[1].project, service: cs[1].service },
			{ name: 'infra-nodewatch-db-1', running: true, project: 'infra', service: 'nodewatch-db' },
		);
		assert.strictEqual(cs[2].running, false); // exited
	},
	'parseImages maps repository/tag/size': () => {
		const line = JSON.stringify({ ID: '4e6', Repository: 'alpine/socat', Tag: 'latest', Size: '15.8MB' });
		assert.deepStrictEqual(parseImages(line), [{ id: '4e6', repository: 'alpine/socat', tag: 'latest', size: '15.8MB' }]);
	},
	'parseVolumes and parseNetworks map name/driver': () => {
		assert.deepStrictEqual(parseVolumes(JSON.stringify({ Name: 'nodewatch_pgdata', Driver: 'local' })), [{ name: 'nodewatch_pgdata', driver: 'local' }]);
		assert.deepStrictEqual(parseNetworks(JSON.stringify({ ID: 'n1', Name: 'infra_default', Driver: 'bridge' })), [{ id: 'n1', name: 'infra_default', driver: 'bridge' }]);
	},
	'groupByProject buckets compose projects first, standalone last': () => {
		const groups = groupByProject(parseContainers(PS));
		assert.strictEqual(groups.length, 2);
		assert.strictEqual(groups[0].project, 'infra');
		assert.strictEqual(groups[0].containers.length, 2);
		assert.strictEqual(groups[1].project, undefined); // standalone bucket last
		assert.strictEqual(groups[1].containers[0].name, 'nw-db-fwd');
	},
	'groupByProject yields a single standalone bucket when nothing is compose-managed': () => {
		const groups = groupByProject(parseContainers(PS.split('\n')[0]));
		assert.strictEqual(groups.length, 1);
		assert.strictEqual(groups[0].project, undefined);
	},
};

let failed = 0;
for (const [name, fn] of Object.entries(cases)) {
	try {
		fn();
		console.log('  ok  ' + name);
	} catch (err) {
		failed++;
		console.error('FAIL  ' + name + '\n      ' + (err && err.message));
	}
}
if (failed) {
	console.error('\n' + failed + ' dockerCli test(s) failed');
	process.exit(1);
}
console.log('\nAll ' + Object.keys(cases).length + ' dockerCli tests passed');
