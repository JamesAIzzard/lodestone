/**
 * Single owner of a silo's mutable configuration plus its persistence
 * to the per-silo config blob. Replaces the seven near-identical
 * `update*` methods and the `persistConfigBlob` helper that used to
 * live on `SiloManager` (Phase 3 of the refactor plan).
 *
 * Two write paths, deliberately:
 *
 *   - **`apply(patch)`** — pure in-memory mutation. Validates
 *     `color` / `icon` through the silo-appearance helpers (silent
 *     fallback to the defaults, matching pre-refactor behaviour). Used
 *     by callers that need to mutate config first, run something long
 *     (reconcile-and-restart), then persist when the new config is
 *     durable.
 *
 *   - **`persist()`** — writes the current blob to the store. No-op when
 *     `canPersist()` returns false (today: when the manager's `dbOpen`
 *     is false). The `canPersist` predicate is injected so the store has
 *     no direct knowledge of the manager's lifecycle state.
 *
 * Identity note: `siloId` is read off the live `cfg.name`, matching the
 * pre-refactor behaviour where the manager recomputed `this.config.name`
 * on every access. `updateName` therefore continues to send
 * `saveConfigBlob` against the *new* slug while the store still has the
 * silo open under the *old* slug — see the rename regression baseline
 * pinned in `silo-manager-regression.test.ts`. Making `siloId`
 * immutable is option (B) in the plan and remains out of scope for this
 * refactor.
 */

import { validateSiloColor, validateSiloIcon } from '../../shared/silo-appearance';
import type { ResolvedSiloConfig } from '../config';
import type { StoreFacade } from '../store-facade';
import type { StoredSiloConfig } from '../store/types';

/**
 * Patch shape for `apply()`. Mirrors the fields the seven legacy
 * `update*` methods could change. `directories` and `dbPath` are
 * intentionally absent — they're construction-time configuration today.
 */
export interface ConfigPatch {
  name?: string;
  contentDescription?: string;
  accentColor?: string;
  iconName?: string;
  ignoredFolderPatterns?: string[];
  ignoredFilePatterns?: string[];
  indexedFileExtensions?: string[];
}

export class SiloConfigStore {
  constructor(
    private cfg: ResolvedSiloConfig,
    private readonly store: StoreFacade,
    private readonly canPersist: () => boolean,
  ) {}

  /** Live config snapshot. Read-only — do not mutate the returned object. */
  get current(): ResolvedSiloConfig {
    return this.cfg;
  }

  /**
   * The silo id used for store-worker calls. Today identical to
   * `current.name`; mutates when `apply({ name })` is called. See file
   * header for the rename caveat.
   */
  get siloId(): string {
    return this.cfg.name;
  }

  /**
   * Apply an in-memory patch. `color` / `icon` are validated through the
   * silo-appearance helpers — invalid values silently fall back to the
   * defaults. Other fields are written through verbatim.
   */
  apply(patch: ConfigPatch): void {
    const next: Partial<ResolvedSiloConfig> = {};
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.contentDescription !== undefined)
      next.contentDescription = patch.contentDescription;
    if (patch.accentColor !== undefined) next.accentColor = validateSiloColor(patch.accentColor);
    if (patch.iconName !== undefined) next.iconName = validateSiloIcon(patch.iconName);
    if (patch.ignoredFolderPatterns !== undefined)
      next.ignoredFolderPatterns = patch.ignoredFolderPatterns;
    if (patch.ignoredFilePatterns !== undefined)
      next.ignoredFilePatterns = patch.ignoredFilePatterns;
    if (patch.indexedFileExtensions !== undefined)
      next.indexedFileExtensions = patch.indexedFileExtensions;
    this.cfg = { ...this.cfg, ...next };
  }

  /**
   * Build and persist the current config as a JSON blob. No-op when
   * `canPersist()` is false (matches the pre-refactor `if (!dbOpen) return`).
   */
  async persist(): Promise<void> {
    if (!this.canPersist()) return;
    const blob: StoredSiloConfig = {
      name: this.cfg.name,
      contentDescription: this.cfg.contentDescription || undefined,
      indexedDirectories: this.cfg.indexedDirectories,
      indexedFileExtensions: this.cfg.indexedFileExtensions,
      ignoredFolderPatterns: this.cfg.ignoredFolderPatterns,
      ignoredFilePatterns: this.cfg.ignoredFilePatterns,
      accentColor: this.cfg.accentColor,
      iconName: this.cfg.iconName,
    };
    await this.store.saveConfigBlob(this.cfg.name, blob);
  }
}
