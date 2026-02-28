/**
 * Store module — V2 indexing system.
 *
 * Re-exports all public API from the store sub-modules. Consumers import
 * from './store' (which resolves to this index.ts) to get types, path
 * utilities, compression helpers, database operations, and peek functions.
 */

export * from './types';
export * from './paths';
export * from './compression';
export * from './term-cache';
export * from './peek';
export * from './schema';
export * from './operations';
