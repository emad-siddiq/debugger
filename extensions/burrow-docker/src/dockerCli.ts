/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// dockerCli.ts — pure parsing of `docker … --format '{{json .}}'` output for the
// Docker viewlet (architecture task: Docker integration). It imports nothing from
// 'vscode' or 'child_process': the exec wrapper (docker.ts) hands raw stdout here,
// so the row parsing + compose grouping are unit-tested against captured output.

/** A container row from `docker ps -a`. */
export interface DockerContainer {
	readonly id: string;
	readonly name: string;
	readonly image: string;
	/** running | exited | created | paused | restarting | dead. */
	readonly state: string;
	/** Human status, e.g. "Up 11 hours" / "Exited (1) 3 minutes ago". */
	readonly status: string;
	readonly ports: string;
	/** com.docker.compose.project label, when the container is compose-managed. */
	readonly project?: string;
	/** com.docker.compose.service label. */
	readonly service?: string;
	readonly running: boolean;
}

export interface DockerImage {
	readonly id: string;
	readonly repository: string;
	readonly tag: string;
	readonly size: string;
}

export interface DockerVolume {
	readonly name: string;
	readonly driver: string;
}

export interface DockerNetwork {
	readonly id: string;
	readonly name: string;
	readonly driver: string;
}

/** Parse newline-delimited `{{json .}}` output, skipping blank/malformed lines. */
export function parseJsonLines(stdout: string): Array<Record<string, string>> {
	const out: Array<Record<string, string>> = [];
	for (const line of stdout.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		try {
			out.push(JSON.parse(trimmed));
		} catch {
			// A malformed line (a warning printed to stdout, say) is skipped, not fatal.
		}
	}
	return out;
}

/** Parse a `docker ps` `Labels` string ("k=v,k2=v2") into a map. */
export function parseLabels(labels: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const pair of (labels || '').split(',')) {
		const eq = pair.indexOf('=');
		if (eq > 0) {
			out[pair.slice(0, eq)] = pair.slice(eq + 1);
		}
	}
	return out;
}

export function parseContainers(stdout: string): DockerContainer[] {
	return parseJsonLines(stdout).map(row => {
		const labels = parseLabels(row.Labels || '');
		const state = (row.State || '').toLowerCase();
		return {
			id: row.ID || '',
			name: row.Names || '',
			image: row.Image || '',
			state,
			status: row.Status || '',
			ports: row.Ports || '',
			project: labels['com.docker.compose.project'] || undefined,
			service: labels['com.docker.compose.service'] || undefined,
			running: state === 'running',
		};
	});
}

export function parseImages(stdout: string): DockerImage[] {
	return parseJsonLines(stdout).map(row => ({
		id: row.ID || '',
		repository: row.Repository || '<none>',
		tag: row.Tag || '<none>',
		size: row.Size || '',
	}));
}

export function parseVolumes(stdout: string): DockerVolume[] {
	return parseJsonLines(stdout).map(row => ({
		name: row.Name || '',
		driver: row.Driver || '',
	}));
}

export function parseNetworks(stdout: string): DockerNetwork[] {
	return parseJsonLines(stdout).map(row => ({
		id: row.ID || '',
		name: row.Name || '',
		driver: row.Driver || '',
	}));
}

/** A compose project (or the standalone bucket) with its containers. */
export interface ContainerGroup {
	/** undefined = standalone containers (no compose project label). */
	readonly project: string | undefined;
	readonly containers: DockerContainer[];
}

/**
 * Group containers by their compose project for the tree — projects first
 * (alphabetical), standalone containers last, each group name-sorted. This is
 * what makes the merkle `infra` stack read as one collapsible node.
 */
export function groupByProject(containers: DockerContainer[]): ContainerGroup[] {
	const byProject = new Map<string, DockerContainer[]>();
	const standalone: DockerContainer[] = [];
	for (const container of containers) {
		if (container.project) {
			const list = byProject.get(container.project) ?? [];
			list.push(container);
			byProject.set(container.project, list);
		} else {
			standalone.push(container);
		}
	}
	const byName = (a: DockerContainer, b: DockerContainer) => a.name.localeCompare(b.name);
	const groups: ContainerGroup[] = [...byProject.keys()].sort().map(project => ({
		project,
		containers: byProject.get(project)!.sort(byName),
	}));
	if (standalone.length) {
		groups.push({ project: undefined, containers: standalone.sort(byName) });
	}
	return groups;
}
