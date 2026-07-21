/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// trees.ts — the four Docker views (Containers grouped by compose project, then
// flat Images / Volumes / Networks). Providers hold no daemon state; they call the
// injected DockerClient on demand and re-fire on refresh(). The nodes are tagged
// unions so the command layer (extension.ts) can dispatch by `kind`, and their
// `contextValue` drives the per-item context menus in package.json.

import { Event, EventEmitter, ThemeColor, ThemeIcon, TreeDataProvider, TreeItem, TreeItemCollapsibleState } from 'vscode';
import { ContainerGroup, DockerContainer, DockerImage, DockerNetwork, DockerVolume, groupByProject } from './dockerCli';
import { DockerClient } from './docker';

// ---- tagged nodes (also the command arguments) ----------------------------

export interface ContainerNode { readonly kind: 'container'; readonly container: DockerContainer; }
export interface ProjectNode { readonly kind: 'project'; readonly group: ContainerGroup; }
export interface ImageNode { readonly kind: 'image'; readonly image: DockerImage; }
export interface VolumeNode { readonly kind: 'volume'; readonly volume: DockerVolume; }
export interface NetworkNode { readonly kind: 'network'; readonly network: DockerNetwork; }

export type DockerNode = ContainerNode | ProjectNode | ImageNode | VolumeNode | NetworkNode;

/** The docker id/name a command should act on, per node kind. */
export function nodeTarget(node: DockerNode | undefined): string {
	switch (node?.kind) {
		case 'container': return node.container.id;
		case 'image': return node.image.id;
		case 'network': return node.network.id;
		case 'volume': return node.volume.name;
		default: return '';
	}
}

// ---- Containers: projects → containers -------------------------------------

type ContainersNode = ProjectNode | ContainerNode;

export class ContainersProvider implements TreeDataProvider<ContainersNode> {

	private readonly changed = new EventEmitter<void>();
	readonly onDidChangeTreeData: Event<void> = this.changed.event;

	constructor(private readonly docker: DockerClient) { }

	refresh(): void { this.changed.fire(); }

	async getChildren(node?: ContainersNode): Promise<ContainersNode[]> {
		if (!node) {
			const groups = groupByProject(await this.docker.containers());
			// All standalone → show containers flat rather than under one dummy group.
			if (groups.length === 1 && groups[0].project === undefined) {
				return groups[0].containers.map(container => ({ kind: 'container', container }));
			}
			return groups.map(group => ({ kind: 'project', group }));
		}
		if (node.kind === 'project') {
			return node.group.containers.map(container => ({ kind: 'container', container }));
		}
		return [];
	}

	getTreeItem(node: ContainersNode): TreeItem {
		return node.kind === 'project' ? projectItem(node.group) : containerItem(node.container);
	}
}

function projectItem(group: ContainerGroup): TreeItem {
	const item = new TreeItem(group.project ?? 'standalone', TreeItemCollapsibleState.Expanded);
	item.iconPath = new ThemeIcon('layers');
	item.contextValue = 'project';
	const up = group.containers.filter(c => c.running).length;
	item.description = `${up}/${group.containers.length} up`;
	return item;
}

function containerItem(container: DockerContainer): TreeItem {
	const item = new TreeItem(container.name, TreeItemCollapsibleState.None);
	item.description = `${container.image}  ·  ${container.status}`;
	item.tooltip = [container.name, container.image, container.status, container.ports].filter(Boolean).join('\n');
	item.iconPath = container.running
		? new ThemeIcon('vm-running', new ThemeColor('charts.green'))
		: new ThemeIcon('vm-outline');
	item.contextValue = container.running ? 'container.running' : 'container.stopped';
	return item;
}

// ---- Flat views: Images / Volumes / Networks -------------------------------

/** A one-level provider: load tagged nodes, render each. Refreshable. */
export class FlatProvider<T extends DockerNode> implements TreeDataProvider<T> {

	private readonly changed = new EventEmitter<void>();
	readonly onDidChangeTreeData: Event<void> = this.changed.event;

	constructor(
		private readonly load: () => Promise<T[]>,
		private readonly toItem: (node: T) => TreeItem,
	) { }

	refresh(): void { this.changed.fire(); }
	getChildren(node?: T): Promise<T[]> { return node ? Promise.resolve([]) : this.load(); }
	getTreeItem(node: T): TreeItem { return this.toItem(node); }
}

export function imagesProvider(docker: DockerClient): FlatProvider<ImageNode> {
	return new FlatProvider<ImageNode>(
		async () => (await docker.images()).map(image => ({ kind: 'image', image })),
		({ image }) => {
			const item = new TreeItem(`${image.repository}:${image.tag}`, TreeItemCollapsibleState.None);
			item.description = image.size;
			item.tooltip = `${image.repository}:${image.tag}\n${image.id}\n${image.size}`;
			item.iconPath = new ThemeIcon('file-zip');
			item.contextValue = 'image';
			return item;
		},
	);
}

export function volumesProvider(docker: DockerClient): FlatProvider<VolumeNode> {
	return new FlatProvider<VolumeNode>(
		async () => (await docker.volumes()).map(volume => ({ kind: 'volume', volume })),
		({ volume }) => {
			const item = new TreeItem(volume.name, TreeItemCollapsibleState.None);
			item.description = volume.driver;
			item.iconPath = new ThemeIcon('database');
			item.contextValue = 'volume';
			return item;
		},
	);
}

export function networksProvider(docker: DockerClient): FlatProvider<NetworkNode> {
	return new FlatProvider<NetworkNode>(
		async () => (await docker.networks()).map(network => ({ kind: 'network', network })),
		({ network }) => {
			const item = new TreeItem(network.name, TreeItemCollapsibleState.None);
			item.description = network.driver;
			item.tooltip = `${network.name}\n${network.id}\n${network.driver}`;
			item.iconPath = new ThemeIcon('type-hierarchy-sub');
			item.contextValue = 'network';
			return item;
		},
	);
}
