/**
 * Reference data for the code chunker: per-grammar lists of top-level AST
 * node types that count as "definitions" — the natural chunk boundaries.
 *
 * Anything not in a language's list is treated as inter-definition content
 * (preamble, global vars, comments). To support a new language: add an entry
 * here keyed by the Tree-sitter grammar name (matching the .wasm filename),
 * and ensure `getCodeGrammar` in shared/file-types maps the file extension
 * to that key.
 */

export const DEFINITION_TYPES: Record<string, string[]> = {
  typescript: [
    'function_declaration',
    'class_declaration',
    'interface_declaration',
    'type_alias_declaration',
    'enum_declaration',
    'export_statement',
    'lexical_declaration',
    'abstract_class_declaration',
    'module',
  ],
  tsx: [
    'function_declaration',
    'class_declaration',
    'interface_declaration',
    'type_alias_declaration',
    'enum_declaration',
    'export_statement',
    'lexical_declaration',
    'abstract_class_declaration',
    'module',
  ],
  javascript: [
    'function_declaration',
    'class_declaration',
    'export_statement',
    'lexical_declaration',
    'variable_declaration',
  ],
  python: ['function_definition', 'class_definition', 'decorated_definition'],
  rust: [
    'function_item',
    'struct_item',
    'enum_item',
    'impl_item',
    'trait_item',
    'mod_item',
    'type_item',
    'const_item',
    'static_item',
    'use_declaration',
    'macro_definition',
  ],
  go: ['function_declaration', 'method_declaration', 'type_declaration'],
  java: [
    'class_declaration',
    'interface_declaration',
    'method_declaration',
    'enum_declaration',
    'annotation_type_declaration',
  ],
  c: [
    'function_definition',
    'struct_specifier',
    'enum_specifier',
    'type_definition',
    'declaration',
  ],
  cpp: [
    'function_definition',
    'class_specifier',
    'struct_specifier',
    'enum_specifier',
    'namespace_definition',
    'template_declaration',
    'type_definition',
    'declaration',
  ],
  c_sharp: [
    'class_declaration',
    'interface_declaration',
    'struct_declaration',
    'enum_declaration',
    'method_declaration',
    'namespace_declaration',
  ],
  ruby: ['method', 'class', 'module', 'singleton_method'],
  swift: [
    'function_declaration',
    'class_declaration',
    'struct_declaration',
    'enum_declaration',
    'protocol_declaration',
    'extension_declaration',
  ],
  kotlin: [
    'function_declaration',
    'class_declaration',
    'object_declaration',
    'interface_declaration',
  ],
};
