// Check the actual Git publication set, or a clean source copy without .git.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { extname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const ignored = new Set(['.git', 'node_modules', 'dist', 'dist-ssr', 'output', '.venv',
  '__pycache__', '.playwright', '.playwright-cli', 'playwright-report', 'test-results']);
function walk(folder = root) {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    if (ignored.has(entry.name)) return [];
    const path = resolve(folder, entry.name);
    return entry.isDirectory() ? walk(path) : [relative(root, path).split(sep).join('/')];
  });
}
let files;
try {
  const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (resolve(gitRoot).toLowerCase() !== resolve(root).toLowerCase()) throw new Error('Source copy');
  files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
} catch {
  files = walk();
}
const published = new Set(files);
const errors = [];
const textTypes = new Set(['.md', '.txt', '.ts', '.wgsl', '.js', '.mjs', '.json', '.csv', '.gltf', '.html', '.css', '.yml', '.yaml', '.py', '.vtt', '.svg']);
let textFiles = 0, localLinks = 0, archives = 0, sceneAssets = 0;
const han = /\p{Script=Han}/u;
const personalPath = /(?:[A-Za-z]:[\\/](?:Users|CodeForCourses)[\\/]|file:\/\/)/i;
function checkLink(source, value) {
  if (!value || /^(?:[a-z][\w+.-]*:|#|\/\/)/i.test(value)) return;
  const clean = decodeURIComponent(value.split(/[?#]/)[0]);
  if (!clean) return;
  const path = resolve(root, source, '..', clean);
  const repoPath = relative(root, path).split(sep).join('/');
  if (!published.has(repoPath) || !existsSync(path)) errors.push(`${source}: missing or ignored target ${value}`);
  localLinks++;
}
for (const file of files) {
  if (han.test(file)) errors.push(`Non-English filename: ${file}`);
  if (file.startsWith('output/')) errors.push(`Local artifact included: ${file}`);
  const path = resolve(root, file);
  if (!existsSync(path)) { errors.push(`Missing file: ${file}`); continue; }
  let content;
  if (file.endsWith('.json.gz')) {
    content = gunzipSync(readFileSync(path)).toString('utf8');
    JSON.parse(content); archives++;
  } else if (textTypes.has(extname(file)) || file === '.gitignore') {
    content = readFileSync(path, 'utf8'); textFiles++;
  } else continue;
  if (han.test(content)) errors.push(`Non-English text: ${file}`);
  if (personalPath.test(content)) errors.push(`Machine-specific path: ${file}`);
  if (file.endsWith('.md')) {
    for (const match of content.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) checkLink(file, match[1]);
  }
  if (file.startsWith('docs/') && file.endsWith('.html')) {
    for (const match of content.matchAll(/(?:src|href)="([^"<>]+)"/g)) checkLink(file, match[1]);
  }
  if (file.endsWith('.gltf')) {
    const scene = JSON.parse(content);
    for (const asset of [...(scene.buffers ?? []), ...(scene.images ?? [])]) {
      if (asset.uri && !asset.uri.startsWith('data:')) { checkLink(file, asset.uri); sceneAssets++; }
    }
  }
}
if (errors.length) {
  console.error(errors.join('\n')); process.exitCode = 1;
} else {
  console.log(`Checked ${files.length} publication files, ${textFiles} text files, ${archives} compressed datasets, ${localLinks} local references (${sceneAssets} scene assets).`);
  console.log('All text is free of Chinese characters and personal filesystem paths; all local references are included.');
}
