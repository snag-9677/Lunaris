/**
 * Project registry: ~/.lunaris/projects.json
 * Shape: { "projects": [{ "id": "...", "name": "...", "root": "/abs/path" }] }
 *
 * register(root) reads the project's lunaris.toml via @lunaris/core loadManifest
 * and upserts the entry (keyed by project id).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadManifest } from '@lunaris/core';
import type { LunarisManifest } from '@lunaris/core';

export interface RegisteredProject {
  id: string;
  name: string;
  root: string;
}

export interface RegistryData {
  projects: RegisteredProject[];
}

export function defaultRegistryPath(): string {
  return join(homedir(), '.lunaris', 'projects.json');
}

export class ProjectRegistry {
  readonly path: string;

  constructor(path: string = defaultRegistryPath()) {
    this.path = path;
  }

  load(): RegistryData {
    if (!existsSync(this.path)) {
      return { projects: [] };
    }
    const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<RegistryData> | null;
    const projects = raw && Array.isArray(raw.projects) ? raw.projects : [];
    return { projects };
  }

  save(data: RegistryData): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }

  /** Register (or re-register) the project rooted at `root` by reading its lunaris.toml. */
  async register(root: string): Promise<RegisteredProject> {
    const absRoot = resolve(root);
    // `await` tolerates loadManifest being sync or async.
    const manifest: LunarisManifest = await loadManifest(absRoot);
    const entry: RegisteredProject = {
      id: manifest.project.id,
      name: manifest.project.name,
      root: absRoot,
    };
    const data = this.load();
    const idx = data.projects.findIndex((p) => p.id === entry.id);
    if (idx >= 0) {
      data.projects[idx] = entry;
    } else {
      data.projects.push(entry);
    }
    this.save(data);
    return entry;
  }

  list(): RegisteredProject[] {
    return this.load().projects;
  }

  get(id: string): RegisteredProject | undefined {
    return this.load().projects.find((p) => p.id === id);
  }
}
