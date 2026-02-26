import type {
  SiloStatus,
  SearchResult,
  ActivityEvent,
  ServerStatus,
} from './types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function minutesAgo(m: number): string {
  return new Date(Date.now() - m * 60_000).toISOString();
}

let nextId = 1;
function id(): string {
  return String(nextId++);
}

// ── Silos ─────────────────────────────────────────────────────────────────────

export const DEFAULT_MODEL = 'snowflake-arctic-embed-xs';

export const mockSilos: SiloStatus[] = [
  {
    config: {
      name: 'personal-kb',
      directories: ['/home/james/vault'],
      extensions: ['.md'],
      ignorePatterns: ['.git', '.obsidian', 'node_modules'],
      ignoreFilePatterns: ['.DS_Store', 'Thumbs.db'],
      hasIgnoreOverride: false,
      hasFileIgnoreOverride: false,
      hasExtensionOverride: false,
      modelOverride: null,
      dbPath: '/home/james/.local/share/lodestone/personal-kb.db',
      description: 'Personal notes, daily journal, and research from my Obsidian vault',
      color: 'blue',
      icon: 'book-open',
    },
    indexedFileCount: 342,
    chunkCount: 1_847,
    lastUpdated: minutesAgo(3),
    databaseSizeBytes: 14_200_000,
    watcherState: 'ready',
    resolvedDbPath: '/home/james/.local/share/lodestone/personal-kb.db',
    resolvedModel: DEFAULT_MODEL,
  },
  {
    config: {
      name: 'dietrix',
      directories: [
        '/home/james/projects/codiet',
        '/home/james/projects/codiet-types',
        '/home/james/projects/codiet-core',
        '/home/james/projects/codiet-optimiser',
        '/home/james/projects/codiet-data',
      ],
      extensions: ['.py', '.toml', '.md'],
      ignorePatterns: ['.git', '__pycache__', 'node_modules', '.venv'],
      ignoreFilePatterns: ['.DS_Store', 'Thumbs.db'],
      hasIgnoreOverride: false,
      hasFileIgnoreOverride: false,
      hasExtensionOverride: false,
      modelOverride: null,
      dbPath: '/home/james/.local/share/lodestone/dietrix.db',
      description: 'Dietrix project — Python codebase for nutrition optimization',
      color: 'emerald',
      icon: 'code',
    },
    indexedFileCount: 128,
    chunkCount: 2_103,
    lastUpdated: minutesAgo(1),
    databaseSizeBytes: 8_700_000,
    watcherState: 'indexing',
    resolvedDbPath: '/home/james/.local/share/lodestone/dietrix.db',
    resolvedModel: DEFAULT_MODEL,
  },
  {
    config: {
      name: 'reference-papers',
      directories: ['/home/james/papers'],
      extensions: ['.pdf', '.md'],
      ignorePatterns: ['.git'],
      ignoreFilePatterns: ['.DS_Store', 'Thumbs.db'],
      hasIgnoreOverride: false,
      hasFileIgnoreOverride: false,
      hasExtensionOverride: false,
      modelOverride: 'mxbai-embed-large',
      dbPath: '/home/james/.local/share/lodestone/reference-papers.db',
      description: 'Academic papers on retrieval-augmented generation and dense passage retrieval',
      color: 'violet',
      icon: 'graduation-cap',
    },
    indexedFileCount: 23,
    chunkCount: 614,
    lastUpdated: minutesAgo(47),
    databaseSizeBytes: 3_100_000,
    watcherState: 'ready',
    resolvedDbPath: '/home/james/.local/share/lodestone/reference-papers.db',
    resolvedModel: 'mxbai-embed-large',
  },
];

// ── Search Results ────────────────────────────────────────────────────────────

export const mockSearchResults: SearchResult[] = [
  {
    filePath: '/home/james/vault/projects/lodestone/architecture.md',
    siloName: 'personal-kb',
    score: 0.91,
    scoreLabel: 'semantic',
    signals: { semantic: 0.91, bm25: 0.52, filepath: 0 },
    hint: { startLine: 45, endLine: 52, sectionPath: ['Architecture', 'Vector Store Design'] },
  },
  {
    filePath: '/home/james/projects/codiet-optimiser/src/solver/constraint_handler.py',
    siloName: 'dietrix',
    score: 0.91,
    scoreLabel: 'semantic',
    signals: { semantic: 0.91, bm25: 0.18, filepath: 0 },
    hint: { startLine: 88, endLine: 102, sectionPath: ['ConstraintHandler.validate'] },
  },
  {
    filePath: '/home/james/vault/notes/embedding-models-comparison.md',
    siloName: 'personal-kb',
    score: 0.87,
    scoreLabel: 'semantic',
    signals: { semantic: 0.87, bm25: 0.62, filepath: 0 },
    hint: { startLine: 34, endLine: 39, sectionPath: ['Embedding Models', 'Nomic Embed Text'] },
  },
  {
    filePath: '/home/james/projects/codiet-core/src/nutrients/calculator.py',
    siloName: 'dietrix',
    score: 0.87,
    scoreLabel: 'semantic',
    signals: { semantic: 0.87, bm25: 0.24, filepath: 0 },
    hint: { startLine: 120, endLine: 135, sectionPath: ['NutrientCalculator', 'NutrientCalculator.compute_totals'] },
  },
  {
    filePath: '/home/james/papers/retrieval-augmented-generation-survey-2024.pdf',
    siloName: 'reference-papers',
    score: 0.85,
    scoreLabel: 'bm25',
    signals: { semantic: 0.08, bm25: 0.85, filepath: 0 },
    hint: { startLine: 1, endLine: 8 },
  },
  {
    filePath: '/home/james/projects/codiet-types/src/food_item.py',
    siloName: 'dietrix',
    score: 0.84,
    scoreLabel: 'convergence',
    signals: { semantic: 0.80, bm25: 0.35, filepath: 0.83 },
    hint: { startLine: 15, endLine: 22, sectionPath: ['FoodItem'] },
  },
  {
    filePath: '/home/james/vault/daily/2025-02-14.md',
    siloName: 'personal-kb',
    score: 0.82,
    scoreLabel: 'semantic',
    signals: { semantic: 0.82, bm25: 0.41, filepath: 0 },
    hint: { startLine: 12, endLine: 18, sectionPath: ['Chunking Strategy Notes'] },
  },
  {
    filePath: '/home/james/vault/projects/lodestone/mcp-tool-design.md',
    siloName: 'personal-kb',
    score: 0.78,
    scoreLabel: 'filepath',
    signals: { semantic: 0.71, bm25: 0.38, filepath: 0.78 },
    hint: { startLine: 22, endLine: 28, sectionPath: ['MCP Tool Design', 'Search Tool Parameters'] },
  },
  {
    filePath: '/home/james/vault/references/chokidar-watcher-patterns.md',
    siloName: 'personal-kb',
    score: 0.75,
    scoreLabel: 'bm25',
    signals: { semantic: 0.10, bm25: 0.75, filepath: 0 },
    hint: { startLine: 28, endLine: 33, sectionPath: ['Chokidar Patterns', 'Debounce Configuration'] },
  },
  {
    filePath: '/home/james/projects/codiet-data/seeds/usda_nutrients.toml',
    siloName: 'dietrix',
    score: 0.75,
    scoreLabel: 'semantic',
    signals: { semantic: 0.75, bm25: 0.22, filepath: 0 },
    hint: { startLine: 1, endLine: 12 },
  },
  {
    filePath: '/home/james/papers/dense-passage-retrieval-karpukhin-2020.pdf',
    siloName: 'reference-papers',
    score: 0.70,
    scoreLabel: 'semantic',
    signals: { semantic: 0.70, bm25: 0.58, filepath: 0 },
    hint: { startLine: 1, endLine: 6 },
  },
  {
    filePath: '/home/james/projects/codiet-optimiser/src/solver/objective.py',
    siloName: 'dietrix',
    score: 0.68,
    scoreLabel: 'semantic',
    signals: { semantic: 0.68, bm25: 0.15, filepath: 0 },
    hint: { startLine: 44, endLine: 58, sectionPath: ['ObjectiveFunction', 'ObjectiveFunction.__call__'] },
  },
];

// ── Activity Feed ─────────────────────────────────────────────────────────────

export const mockActivityEvents: ActivityEvent[] = [
  {
    id: id(),
    timestamp: minutesAgo(1),
    siloName: 'dietrix',
    filePath: '/home/james/projects/codiet-optimiser/src/solver/constraint_handler.py',
    eventType: 'reindexed',
  },
  {
    id: id(),
    timestamp: minutesAgo(1),
    siloName: 'dietrix',
    filePath: '/home/james/projects/codiet-core/src/nutrients/calculator.py',
    eventType: 'reindexed',
  },
  {
    id: id(),
    timestamp: minutesAgo(2),
    siloName: 'personal-kb',
    filePath: '/home/james/vault/daily/2025-02-20.md',
    eventType: 'indexed',
  },
  {
    id: id(),
    timestamp: minutesAgo(3),
    siloName: 'personal-kb',
    filePath: '/home/james/vault/projects/lodestone/architecture.md',
    eventType: 'reindexed',
  },
  {
    id: id(),
    timestamp: minutesAgo(5),
    siloName: 'dietrix',
    filePath: '/home/james/projects/codiet-types/src/deprecated_models.py',
    eventType: 'deleted',
  },
  {
    id: id(),
    timestamp: minutesAgo(8),
    siloName: 'personal-kb',
    filePath: '/home/james/vault/notes/embedding-models-comparison.md',
    eventType: 'reindexed',
  },
  {
    id: id(),
    timestamp: minutesAgo(12),
    siloName: 'reference-papers',
    filePath: '/home/james/papers/encrypted-thesis-draft.pdf',
    eventType: 'error',
    errorMessage: 'PDF extraction failed: encrypted document',
  },
  {
    id: id(),
    timestamp: minutesAgo(14),
    siloName: 'reference-papers',
    filePath: '/home/james/papers/retrieval-augmented-generation-survey-2024.pdf',
    eventType: 'indexed',
  },
  {
    id: id(),
    timestamp: minutesAgo(15),
    siloName: 'dietrix',
    filePath: '/home/james/projects/codiet-data/seeds/usda_nutrients.toml',
    eventType: 'indexed',
  },
  {
    id: id(),
    timestamp: minutesAgo(18),
    siloName: 'personal-kb',
    filePath: '/home/james/vault/references/chokidar-watcher-patterns.md',
    eventType: 'indexed',
  },
  {
    id: id(),
    timestamp: minutesAgo(22),
    siloName: 'dietrix',
    filePath: '/home/james/projects/codiet-optimiser/src/solver/objective.py',
    eventType: 'reindexed',
  },
  {
    id: id(),
    timestamp: minutesAgo(25),
    siloName: 'personal-kb',
    filePath: '/home/james/vault/daily/2025-02-19.md',
    eventType: 'indexed',
  },
  {
    id: id(),
    timestamp: minutesAgo(30),
    siloName: 'dietrix',
    filePath: '/home/james/projects/codiet-core/src/nutrients/__init__.py',
    eventType: 'indexed',
  },
  {
    id: id(),
    timestamp: minutesAgo(35),
    siloName: 'reference-papers',
    filePath: '/home/james/papers/corrupted-scan.pdf',
    eventType: 'error',
    errorMessage: 'PDF extraction failed: unable to parse document structure',
  },
  {
    id: id(),
    timestamp: minutesAgo(38),
    siloName: 'personal-kb',
    filePath: '/home/james/vault/projects/lodestone/mcp-tool-design.md',
    eventType: 'indexed',
  },
  {
    id: id(),
    timestamp: minutesAgo(42),
    siloName: 'dietrix',
    filePath: '/home/james/projects/codiet-types/src/food_item.py',
    eventType: 'reindexed',
  },
  {
    id: id(),
    timestamp: minutesAgo(45),
    siloName: 'reference-papers',
    filePath: '/home/james/papers/dense-passage-retrieval-karpukhin-2020.pdf',
    eventType: 'indexed',
  },
  {
    id: id(),
    timestamp: minutesAgo(50),
    siloName: 'personal-kb',
    filePath: '/home/james/vault/daily/2025-02-18.md',
    eventType: 'indexed',
  },
  {
    id: id(),
    timestamp: minutesAgo(55),
    siloName: 'dietrix',
    filePath: '/home/james/projects/codiet-optimiser/pyproject.toml',
    eventType: 'reindexed',
  },
  {
    id: id(),
    timestamp: minutesAgo(58),
    siloName: 'personal-kb',
    filePath: '/home/james/vault/references/orama-vector-search.md',
    eventType: 'indexed',
  },
];

// ── Server Status ─────────────────────────────────────────────────────────────

export const mockServerStatus: ServerStatus = {
  uptimeSeconds: 7_423,
  ollamaState: 'connected',
  ollamaUrl: 'http://localhost:11434',
  availableModels: ['nomic-embed-text', 'all-MiniLM-L6-v2', 'mxbai-embed-large'],
  defaultModel: DEFAULT_MODEL,
  totalIndexedFiles: mockSilos.reduce((sum, s) => sum + s.indexedFileCount, 0),
  modelPathSafeIds: { 'snowflake-arctic-embed-xs': 'arctic-xs', 'nomic-embed-text-v1.5': 'nomic-v1' },
};
