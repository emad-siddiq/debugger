/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// docker.ts — the CLI boundary for the Docker viewlet. The one place we shell out
// to `docker` (no dockerode, no daemon socket wrangling — the CLI is already the
// user's supported interface). The runner is injectable so the client is unit-
// tested against captured stdout without a live daemon.

import { execFile } from 'child_process';
import { promisify } from 'util';
import {
	DockerContainer, DockerImage, DockerNetwork, DockerVolume,
	parseContainers, parseImages, parseNetworks, parseVolumes,
} from './dockerCli';

const execFileAsync = promisify(execFile);

/** Runs `docker <args>` and resolves stdout. Injected so DockerClient is testable. */
export type DockerRun = (args: string[]) => Promise<string>;

const defaultRun: DockerRun = async (args) => {
	// 16MB covers a large `docker inspect`; the CLI, not a socket, is the boundary.
	const { stdout } = await execFileAsync('docker', args, { maxBuffer: 16 * 1024 * 1024 });
	return stdout;
};

/** Thin, typed wrapper over the `docker` CLI. */
export class DockerClient {

	constructor(private readonly run: DockerRun = defaultRun) { }

	/** True when the daemon answers — drives the daemon-down welcome view. */
	async daemonOk(): Promise<boolean> {
		try {
			await this.run(['info', '--format', '{{.ServerVersion}}']);
			return true;
		} catch {
			return false;
		}
	}

	async containers(): Promise<DockerContainer[]> {
		return parseContainers(await this.run(['ps', '-a', '--no-trunc', '--format', '{{json .}}']));
	}
	async images(): Promise<DockerImage[]> {
		return parseImages(await this.run(['images', '--format', '{{json .}}']));
	}
	async volumes(): Promise<DockerVolume[]> {
		return parseVolumes(await this.run(['volume', 'ls', '--format', '{{json .}}']));
	}
	async networks(): Promise<DockerNetwork[]> {
		return parseNetworks(await this.run(['network', 'ls', '--format', '{{json .}}']));
	}

	start(id: string): Promise<string> { return this.run(['start', id]); }
	stop(id: string): Promise<string> { return this.run(['stop', id]); }
	restart(id: string): Promise<string> { return this.run(['restart', id]); }
	remove(id: string, force = false): Promise<string> { return this.run(force ? ['rm', '-f', id] : ['rm', id]); }
	removeImage(id: string): Promise<string> { return this.run(['rmi', id]); }
	removeVolume(name: string): Promise<string> { return this.run(['volume', 'rm', name]); }
	removeNetwork(id: string): Promise<string> { return this.run(['network', 'rm', id]); }

	/** Raw `docker inspect <id>` JSON (containers/images) — opened read-only. */
	inspect(id: string): Promise<string> { return this.run(['inspect', id]); }
	/** Volumes need the type-specific subcommand (`docker inspect` misses them). */
	inspectVolume(name: string): Promise<string> { return this.run(['volume', 'inspect', name]); }
	inspectNetwork(id: string): Promise<string> { return this.run(['network', 'inspect', id]); }
}
