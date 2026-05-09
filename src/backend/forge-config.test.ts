import { describe, expect, it } from 'vitest';
import { getPackagedExternalDependencies } from '../../forge.config';

describe('forge packaging config', () => {
  it('keeps the scoped Tree-sitter grammar WASM package in packaged dependencies', () => {
    const filtered = getPackagedExternalDependencies({
      dependencies: {
        'web-tree-sitter': '^0.26.8',
        '@repomix/tree-sitter-wasms': '^0.1.17',
        react: '^19.2.4',
      },
    });

    expect(filtered).toMatchObject({
      'web-tree-sitter': '^0.26.8',
      '@repomix/tree-sitter-wasms': '^0.1.17',
    });
    expect(filtered).not.toHaveProperty('react');
  });
});
