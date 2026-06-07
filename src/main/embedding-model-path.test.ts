import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveBundledModelDir } from './embedding-model-path';

describe('resolveBundledModelDir', () => {
  it('uses the app path resources directory in development', () => {
    expect(
      resolveBundledModelDir({
        isPackaged: false,
        appPath: path.join('C:', 'repo', 'lodestone'),
        resourcesPath: path.join('C:', 'Program Files', 'Lodestone', 'resources'),
      }),
    ).toBe(
      path.join(
        'C:',
        'repo',
        'lodestone',
        'resources',
        'models',
        'Snowflake',
        'snowflake-arctic-embed-s',
      ),
    );
  });

  it('uses process.resourcesPath in packaged builds', () => {
    expect(
      resolveBundledModelDir({
        isPackaged: true,
        appPath: path.join('C:', 'repo', 'lodestone'),
        resourcesPath: path.join('C:', 'Program Files', 'Lodestone', 'resources'),
      }),
    ).toBe(
      path.join(
        'C:',
        'Program Files',
        'Lodestone',
        'resources',
        'models',
        'Snowflake',
        'snowflake-arctic-embed-s',
      ),
    );
  });
});
