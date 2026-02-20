import type {
  SiloStatus,
  SearchResult,
  ActivityEvent,
  ServerStatus,
} from './types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function minutesAgo(m: number): Date {
  return new Date(Date.now() - m * 60_000);
}

let nextId = 1;
function id(): string {
  return String(nextId++);
}

// ── Silos ─────────────────────────────────────────────────────────────────────

export const DEFAULT_MODEL = 'nomic-embed-text';

export const mockSilos: SiloStatus[] = [
  {
    config: {
      name: 'personal-kb',
      directories: ['/home/james/vault'],
      extensions: ['.md'],
      ignorePatterns: ['.git', '.obsidian', 'node_modules'],
      modelOverride: null,
      dbPath: '/home/james/.local/share/lodestone/personal-kb.db',
    },
    indexedFileCount: 342,
    chunkCount: 1_847,
    lastUpdated: minutesAgo(3),
    databaseSizeBytes: 14_200_000,
    watcherState: 'idle',
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
      modelOverride: null,
      dbPath: '/home/james/.local/share/lodestone/dietrix.db',
    },
    indexedFileCount: 128,
    chunkCount: 2_103,
    lastUpdated: minutesAgo(1),
    databaseSizeBytes: 8_700_000,
    watcherState: 'indexing',
  },
  {
    config: {
      name: 'reference-papers',
      directories: ['/home/james/papers'],
      extensions: ['.pdf', '.md'],
      ignorePatterns: ['.git'],
      modelOverride: 'mxbai-embed-large',
      dbPath: '/home/james/.local/share/lodestone/reference-papers.db',
    },
    indexedFileCount: 23,
    chunkCount: 614,
    lastUpdated: minutesAgo(47),
    databaseSizeBytes: 3_100_000,
    watcherState: 'idle',
  },
];

// ── Search Results ────────────────────────────────────────────────────────────

export const mockSearchResults: SearchResult[] = [
  {
    filePath: '/home/james/vault/projects/lodestone/architecture.md',
    score: 0.94,
    matchingSection: 'Vector Store Design',
    siloName: 'personal-kb',
  },
  {
    filePath: '/home/james/projects/codiet-optimiser/src/solver/constraint_handler.py',
    score: 0.91,
    matchingSection: 'ConstraintHandler.validate',
    siloName: 'dietrix',
  },
  {
    filePath: '/home/james/vault/notes/embedding-models-comparison.md',
    score: 0.89,
    matchingSection: 'Nomic Embed Text',
    siloName: 'personal-kb',
  },
  {
    filePath: '/home/james/projects/codiet-core/src/nutrients/calculator.py',
    score: 0.87,
    matchingSection: 'NutrientCalculator.compute_totals',
    siloName: 'dietrix',
  },
  {
    filePath: '/home/james/papers/retrieval-augmented-generation-survey-2024.pdf',
    score: 0.85,
    matchingSection: null,
    siloName: 'reference-papers',
  },
  {
    filePath: '/home/james/vault/daily/2025-02-14.md',
    score: 0.82,
    matchingSection: 'Chunking Strategy Notes',
    siloName: 'personal-kb',
  },
  {
    filePath: '/home/james/projects/codiet-types/src/food_item.py',
    score: 0.80,
    matchingSection: 'FoodItem',
    siloName: 'dietrix',
  },
  {
    filePath: '/home/james/vault/references/chokidar-watcher-patterns.md',
    score: 0.78,
    matchingSection: 'Debounce Configuration',
    siloName: 'personal-kb',
  },
  {
    filePath: '/home/james/projects/codiet-data/seeds/usda_nutrients.toml',
    score: 0.75,
    matchingSection: null,
    siloName: 'dietrix',
  },
  {
    filePath: '/home/james/papers/dense-passage-retrieval-karpukhin-2020.pdf',
    score: 0.73,
    matchingSection: null,
    siloName: 'reference-papers',
  },
  {
    filePath: '/home/james/vault/projects/lodestone/mcp-tool-design.md',
    score: 0.71,
    matchingSection: 'Search Tool Parameters',
    siloName: 'personal-kb',
  },
  {
    filePath: '/home/james/projects/codiet-optimiser/src/solver/objective.py',
    score: 0.68,
    matchingSection: 'ObjectiveFunction.__call__',
    siloName: 'dietrix',
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
};
