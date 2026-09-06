import type { SiloManager } from '../backend/silo-manager';

type ReadySilo = [string, SiloManager];

export function selectSilos(
  siloManagers: ReadonlyMap<string, SiloManager>,
  names: string[] | undefined,
): ReadySilo[] {
  if (names === undefined) {
    return [...siloManagers].filter(([, manager]) => !manager.isStopped && manager.isAvailable);
  }

  const selected: ReadySilo[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);

    const manager = siloManagers.get(name);
    if (!manager) throw new Error(`Silo "${name}" not found`);
    if (manager.isStopped) throw new Error(`Silo "${name}" is stopped`);
    if (!manager.isAvailable) throw new Error(`Silo "${name}" is temporarily unavailable.`);
    selected.push([name, manager]);
  }

  return selected;
}

export async function siloWarnings(
  ready: Iterable<ReadySilo>,
  needsEmbedding: boolean,
): Promise<string[]> {
  const warnings: string[] = [];

  for (const [name, manager] of ready) {
    const status = await manager.getStatus();
    if (needsEmbedding && !manager.getEmbeddingService()) {
      warnings.push(`Silo "${name}" is still initializing and not yet searchable.`);
    }
    if (status.watcherState === 'indexing') {
      const progress = status.reconcileProgress;
      warnings.push(
        progress
          ? `Silo "${name}" is indexing (${progress.current.toLocaleString()} / ${progress.total.toLocaleString()} files) — results may be incomplete.`
          : `Silo "${name}" is indexing — results may be incomplete.`,
      );
    }
  }

  return warnings;
}

export function toSiloNames(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((name) => typeof name === 'string')) return value;
  throw new Error('Invalid silo selection');
}
