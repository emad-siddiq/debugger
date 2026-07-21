/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// db.ts — pure argument/path helpers for the Full Stack orchestrator's database
// leg. `docker compose up -d --wait <service>` blocks until the service's
// healthcheck passes (the single nodewatch-db defines one), so bringing the DB up
// is a single command with no separate pg_isready poll. No 'vscode' import — the
// arg building + path resolution are unit-tested directly.

import { isAbsolute, join } from 'path';

/** `docker compose` args to bring the single DB up and wait for its healthcheck. */
export function composeUpArgs(composeFile: string, service: string): string[] {
	return ['compose', '-f', composeFile, 'up', '-d', '--wait', service];
}

/** `docker compose` args to stop the DB service (leaves the container/volume). */
export function composeStopArgs(composeFile: string, service: string): string[] {
	return ['compose', '-f', composeFile, 'stop', service];
}

/** Resolve a possibly-relative compose path against the workspace root. */
export function resolveComposeFile(configured: string, workspaceRoot: string | undefined): string {
	if (isAbsolute(configured)) {
		return configured;
	}
	return workspaceRoot ? join(workspaceRoot, configured) : configured;
}
