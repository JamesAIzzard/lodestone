export type FileProcessorKind = 'markdown' | 'code' | 'pdf' | 'plaintext';

export type CodeGrammar =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'python'
  | 'rust'
  | 'go'
  | 'java'
  | 'c'
  | 'cpp'
  | 'c_sharp'
  | 'ruby'
  | 'swift'
  | 'kotlin';

interface BaseFileType {
  extension: string;
  label: string;
  processorKind: FileProcessorKind;
  defaultEnabled: boolean;
  pickerVisible: boolean;
}

export interface CodeFileType extends BaseFileType {
  processorKind: 'code';
  treeSitterGrammar: CodeGrammar;
}

export type FileTypeDefinition =
  | CodeFileType
  | (BaseFileType & { processorKind: Exclude<FileProcessorKind, 'code'> });

export const FILE_TYPES = [
  {
    extension: '.md',
    label: 'Markdown',
    processorKind: 'markdown',
    defaultEnabled: true,
    pickerVisible: true,
  },
  {
    extension: '.markdown',
    label: 'Markdown',
    processorKind: 'markdown',
    defaultEnabled: false,
    pickerVisible: false,
  },
  {
    extension: '.mdx',
    label: 'MDX',
    processorKind: 'markdown',
    defaultEnabled: false,
    pickerVisible: false,
  },
  {
    extension: '.txt',
    label: 'Plain text',
    processorKind: 'plaintext',
    defaultEnabled: true,
    pickerVisible: true,
  },
  {
    extension: '.pdf',
    label: 'PDF',
    processorKind: 'pdf',
    defaultEnabled: false,
    pickerVisible: true,
  },
  {
    extension: '.toml',
    label: 'TOML',
    processorKind: 'plaintext',
    defaultEnabled: false,
    pickerVisible: true,
  },
  {
    extension: '.yaml',
    label: 'YAML',
    processorKind: 'plaintext',
    defaultEnabled: false,
    pickerVisible: true,
  },
  {
    extension: '.yml',
    label: 'YAML',
    processorKind: 'plaintext',
    defaultEnabled: false,
    pickerVisible: false,
  },
  {
    extension: '.json',
    label: 'JSON',
    processorKind: 'plaintext',
    defaultEnabled: false,
    pickerVisible: true,
  },
  {
    extension: '.ts',
    label: 'TypeScript',
    processorKind: 'code',
    treeSitterGrammar: 'typescript',
    defaultEnabled: true,
    pickerVisible: true,
  },
  {
    extension: '.tsx',
    label: 'TSX',
    processorKind: 'code',
    treeSitterGrammar: 'tsx',
    defaultEnabled: true,
    pickerVisible: true,
  },
  {
    extension: '.js',
    label: 'JavaScript',
    processorKind: 'code',
    treeSitterGrammar: 'javascript',
    defaultEnabled: true,
    pickerVisible: true,
  },
  {
    extension: '.jsx',
    label: 'JSX',
    processorKind: 'code',
    treeSitterGrammar: 'tsx',
    defaultEnabled: true,
    pickerVisible: true,
  },
  {
    extension: '.py',
    label: 'Python',
    processorKind: 'code',
    treeSitterGrammar: 'python',
    defaultEnabled: true,
    pickerVisible: true,
  },
  {
    extension: '.rs',
    label: 'Rust',
    processorKind: 'code',
    treeSitterGrammar: 'rust',
    defaultEnabled: true,
    pickerVisible: true,
  },
  {
    extension: '.go',
    label: 'Go',
    processorKind: 'code',
    treeSitterGrammar: 'go',
    defaultEnabled: true,
    pickerVisible: true,
  },
  {
    extension: '.java',
    label: 'Java',
    processorKind: 'code',
    treeSitterGrammar: 'java',
    defaultEnabled: true,
    pickerVisible: true,
  },
  {
    extension: '.c',
    label: 'C',
    processorKind: 'code',
    treeSitterGrammar: 'c',
    defaultEnabled: true,
    pickerVisible: true,
  },
  {
    extension: '.h',
    label: 'C header',
    processorKind: 'code',
    treeSitterGrammar: 'c',
    defaultEnabled: true,
    pickerVisible: false,
  },
  {
    extension: '.cpp',
    label: 'C++',
    processorKind: 'code',
    treeSitterGrammar: 'cpp',
    defaultEnabled: true,
    pickerVisible: true,
  },
  {
    extension: '.hpp',
    label: 'C++ header',
    processorKind: 'code',
    treeSitterGrammar: 'cpp',
    defaultEnabled: true,
    pickerVisible: false,
  },
  {
    extension: '.cs',
    label: 'C#',
    processorKind: 'code',
    treeSitterGrammar: 'c_sharp',
    defaultEnabled: true,
    pickerVisible: true,
  },
  {
    extension: '.rb',
    label: 'Ruby',
    processorKind: 'code',
    treeSitterGrammar: 'ruby',
    defaultEnabled: true,
    pickerVisible: false,
  },
  {
    extension: '.swift',
    label: 'Swift',
    processorKind: 'code',
    treeSitterGrammar: 'swift',
    defaultEnabled: true,
    pickerVisible: false,
  },
  {
    extension: '.kt',
    label: 'Kotlin',
    processorKind: 'code',
    treeSitterGrammar: 'kotlin',
    defaultEnabled: true,
    pickerVisible: false,
  },
] as const satisfies readonly FileTypeDefinition[];

function normalizeExtension(ext: string): string {
  const trimmed = ext.trim().toLowerCase();
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

export function getFileType(ext: string): FileTypeDefinition | undefined {
  const normalized = normalizeExtension(ext);
  return FILE_TYPES.find((type) => type.extension === normalized);
}

export function getCodeGrammar(ext: string): CodeGrammar | undefined {
  const fileType = getFileType(ext);
  return fileType?.processorKind === 'code' ? fileType.treeSitterGrammar : undefined;
}

export const DEFAULT_INDEX_EXTENSIONS: string[] = FILE_TYPES.filter(
  (type) => type.defaultEnabled,
).map((type) => type.extension);

export const PICKER_EXTENSIONS: string[] = FILE_TYPES.filter((type) => type.pickerVisible).map(
  (type) => type.extension,
);

export const CODE_EXTENSIONS: string[] = FILE_TYPES.filter(
  (type) => type.processorKind === 'code',
).map((type) => type.extension);
