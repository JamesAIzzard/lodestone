import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ID = 'Snowflake/snowflake-arctic-embed-s';
const REVISION = 'e596f507467533e48a2e17c007f0e1dacc837b33';
const LICENSE = 'apache-2.0';
const FILES = [
  'README.md',
  'config.json',
  'special_tokens_map.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'vocab.txt',
  'onnx/model_quantized.onnx',
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetDir = path.join(repoRoot, 'resources', 'models', 'Snowflake', 'snowflake-arctic-embed-s');

function hfUrl(file) {
  const encodedPath = file.split('/').map(encodeURIComponent).join('/');
  return `https://huggingface.co/${REPO_ID}/resolve/${REVISION}/${encodedPath}`;
}

function formatBytes(bytes) {
  return `${bytes.toLocaleString('en-US')} bytes`;
}

async function downloadFile(file) {
  const destination = path.join(targetDir, ...file.split('/'));
  await fs.mkdir(path.dirname(destination), { recursive: true });

  const response = await fetch(hfUrl(file));
  if (!response.ok) {
    throw new Error(`Failed to download ${file}: ${response.status} ${response.statusText}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(destination, bytes);
  return { file, size: bytes.length };
}

await fs.rm(targetDir, { recursive: true, force: true });
await fs.mkdir(targetDir, { recursive: true });

const downloaded = [];
for (const file of FILES) {
  process.stdout.write(`[model] ${file} ... `);
  const result = await downloadFile(file);
  downloaded.push(result);
  process.stdout.write(`${formatBytes(result.size)}\n`);
}

const fetchedDate = new Date().toISOString().slice(0, 10);
const provenance = `# Lodestone Model Provenance

Bundled model: \`${REPO_ID}\`

- Hugging Face repo: https://huggingface.co/${REPO_ID}
- Revision: \`${REVISION}\`
- Fetched date: ${fetchedDate}
- License: ${LICENSE}
- Included weight file: \`onnx/model_quantized.onnx\`
- Excluded weight files: \`model.safetensors\`, full-size ONNX files, and alternate quantizations
- Upstream license files: none present in the repository at this revision

## Vendored Files

| File | Size |
|---|---:|
${downloaded.map(({ file, size }) => `| \`${file}\` | ${formatBytes(size)} |`).join('\n')}
`;

await fs.writeFile(path.join(targetDir, 'LODESTONE_MODEL_PROVENANCE.md'), provenance);
process.stdout.write(`[model] Wrote ${path.relative(repoRoot, targetDir)}\n`);
