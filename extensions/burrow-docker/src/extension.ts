/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// burrow-docker — a first-class Docker activity-bar viewlet ("Docker's UI"):
// Containers (grouped by compose project), Images, Volumes and Networks, with
// start/stop/restart/remove, exec-into-a-terminal, follow-logs and inspect. It is
// pure Layer 4 — standard viewsContainers + TreeDataProvider contributions — and
// drives the `docker` CLI directly (see docker.ts). No daemon socket, no dockerode.

import { ExtensionContext, ProgressLocation, commands, window, workspace } from 'vscode';
import { DockerClient } from './docker';
import {
	ContainerNode, DockerNode, ContainersProvider,
	imagesProvider, networksProvider, nodeTarget, volumesProvider,
} from './trees';

const DAEMON_CONTEXT = 'burrow.docker.daemonRunning';
const CONFIG_SECTION = 'burrow.docker';

export function activate(context: ExtensionContext): void {
	const docker = new DockerClient();
	const containers = new ContainersProvider(docker);
	const images = imagesProvider(docker);
	const volumes = volumesProvider(docker);
	const networks = networksProvider(docker);

	// One refresh reloads every view and re-evaluates daemon reachability (which
	// toggles the daemon-down welcome). Errors here are swallowed — a down daemon
	// is a state, not a failure to surface as a modal on every tick.
	const refreshAll = async (): Promise<void> => {
		await commands.executeCommand('setContext', DAEMON_CONTEXT, await docker.daemonOk());
		containers.refresh();
		images.refresh();
		volumes.refresh();
		networks.refresh();
	};

	const containersView = window.createTreeView('burrowDockerContainers', { treeDataProvider: containers });

	// Poll only while the Containers view is visible — a background IDE shouldn't
	// shell out to `docker` forever. 0 disables polling (manual refresh only).
	let timer: NodeJS.Timeout | undefined;
	const intervalMs = (): number => workspace.getConfiguration(CONFIG_SECTION).get<number>('refreshInterval') ?? 4000;
	const startPoll = (): void => { if (!timer && intervalMs() > 0) { timer = setInterval(() => void refreshAll(), intervalMs()); } };
	const stopPoll = (): void => { if (timer) { clearInterval(timer); timer = undefined; } };

	// Run a docker action with a directive error + a refresh, so the tree reflects
	// the new state immediately rather than waiting for the next poll tick.
	const act = async (label: string, run: () => Promise<unknown>): Promise<void> => {
		try {
			await window.withProgress({ location: ProgressLocation.Window, title: `Docker: ${label}…` }, () => run());
		} catch (err) {
			void window.showErrorMessage(`Docker: ${label} failed — ${errText(err)}`);
		} finally {
			await refreshAll();
		}
	};

	const confirmRemove = async (name: string): Promise<boolean> => {
		const pick = await window.showWarningMessage(`Remove "${name}"? This cannot be undone.`, { modal: true }, 'Remove');
		return pick === 'Remove';
	};

	context.subscriptions.push(
		containersView,
		window.registerTreeDataProvider('burrowDockerImages', images),
		window.registerTreeDataProvider('burrowDockerVolumes', volumes),
		window.registerTreeDataProvider('burrowDockerNetworks', networks),

		containersView.onDidChangeVisibility(e => (e.visible ? startPoll() : stopPoll())),

		commands.registerCommand('burrow.docker.refresh', () => void refreshAll()),

		commands.registerCommand('burrow.docker.start', (n: ContainerNode) => act(`start ${n.container.name}`, () => docker.start(n.container.id))),
		commands.registerCommand('burrow.docker.stop', (n: ContainerNode) => act(`stop ${n.container.name}`, () => docker.stop(n.container.id))),
		commands.registerCommand('burrow.docker.restart', (n: ContainerNode) => act(`restart ${n.container.name}`, () => docker.restart(n.container.id))),
		commands.registerCommand('burrow.docker.remove', async (n: ContainerNode) => {
			if (await confirmRemove(n.container.name)) {
				// A running container needs -f; a stopped one removes plainly.
				await act(`remove ${n.container.name}`, () => docker.remove(n.container.id, n.container.running));
			}
		}),
		commands.registerCommand('burrow.docker.logs', (n: ContainerNode) => openLogs(n)),
		commands.registerCommand('burrow.docker.exec', (n: ContainerNode) => openExec(n)),
		commands.registerCommand('burrow.docker.inspect', (n: DockerNode) => inspect(docker, n)),

		commands.registerCommand('burrow.docker.removeImage', async (n) => {
			if (await confirmRemove(`${n.image.repository}:${n.image.tag}`)) {
				await act('remove image', () => docker.removeImage(n.image.id));
			}
		}),
		commands.registerCommand('burrow.docker.removeVolume', async (n) => {
			if (await confirmRemove(n.volume.name)) {
				await act('remove volume', () => docker.removeVolume(n.volume.name));
			}
		}),
		commands.registerCommand('burrow.docker.removeNetwork', async (n) => {
			if (await confirmRemove(n.network.name)) {
				await act('remove network', () => docker.removeNetwork(n.network.id));
			}
		}),

		{ dispose: stopPoll },
	);

	if (containersView.visible) {
		startPoll();
	}
	void refreshAll();
}

/** Open an interactive shell inside the container as a terminal (docker exec -it). */
function openExec(node: ContainerNode): void {
	const shell = workspace.getConfiguration(CONFIG_SECTION).get<string>('execShell') || '/bin/sh';
	const terminal = window.createTerminal({
		name: `docker: ${node.container.name}`,
		shellPath: 'docker',
		shellArgs: ['exec', '-it', node.container.id, shell],
	});
	terminal.show();
}

/** Follow a container's logs in a terminal (docker logs -f). */
function openLogs(node: ContainerNode): void {
	const terminal = window.createTerminal({
		name: `logs: ${node.container.name}`,
		shellPath: 'docker',
		shellArgs: ['logs', '-f', '--tail', '200', node.container.id],
	});
	terminal.show();
}

/** Open `docker inspect <id>` as a read-only JSON document. */
async function inspect(docker: DockerClient, node: DockerNode): Promise<void> {
	const target = nodeTarget(node);
	if (!target) {
		return;
	}
	try {
		const json = node.kind === 'volume'
			? await docker.inspectVolume(node.volume.name)
			: node.kind === 'network'
				? await docker.inspectNetwork(node.network.id)
				: await docker.inspect(target);
		const doc = await workspace.openTextDocument({ content: json, language: 'json' });
		await window.showTextDocument(doc, { preview: true });
	} catch (err) {
		void window.showErrorMessage(`Docker: inspect failed — ${errText(err)}`);
	}
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function deactivate(): void {
	// The poll timer + tree views are disposed via context.subscriptions.
}
