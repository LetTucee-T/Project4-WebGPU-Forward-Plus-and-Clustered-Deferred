import { cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const folder of ['scenes', 'docs']) {
  cpSync(resolve(root, folder), resolve(root, 'dist', folder), { recursive: true });
}
console.log('Copied scene assets and public documentation to dist/.');
