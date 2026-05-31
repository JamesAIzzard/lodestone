import path from 'node:path';

const BUNDLED_MODEL_PARTS = ['models', 'Snowflake', 'snowflake-arctic-embed-s'] as const;

export interface ResolveBundledModelDirOptions {
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
}

export function resolveBundledModelDir(options: ResolveBundledModelDirOptions): string {
  const root = options.isPackaged
    ? options.resourcesPath
    : path.join(options.appPath, 'resources');
  return path.join(root, ...BUNDLED_MODEL_PARTS);
}
