import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractFile, listPackage } from '@electron/asar';

const projectPackage = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const allowedTopLevel = new Set(['node_modules', 'out', 'package.json']);
const privateName =
  /^(?:\.env(?:\..*)?|\.npmrc|\.git|\.aws|\.ssh|[^/]+\.(?:pem|key|p12|pfx|db|sqlite|sqlite3))$/i;
// certifi 2026.7.22 ships a public CA trust store needed by the frozen ASR runtime.
const publicCaBundle = 'asr-worker/_internal/certifi/cacert.pem';
const publicCaSha256 = '9cc2a774b5198dcff14d9be1e66091f538975d867ce029a96bce15a55dfd730f';

export function normalizeArchivePath(path) {
  return path.replaceAll('\\', '/').replace(/^\/+/, '');
}

function assertSafePath(path) {
  const parts = path.split('/');
  assertNoPrivatePath(path);
  if (!allowedTopLevel.has(parts[0])) {
    throw new Error(`Unexpected top-level app package path: ${path}`);
  }
  for (const name of Object.keys(projectPackage.devDependencies ?? {})) {
    if (path === `node_modules/${name}` || path.startsWith(`node_modules/${name}/`)) {
      throw new Error(`Development dependency found in app package: ${name}`);
    }
  }
}

function assertNoPrivatePath(path) {
  if (path.split('/').some((part) => privateName.test(part))) {
    throw new Error(`Private configuration path found in app package: ${path}`);
  }
}

function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? [path, ...walk(path)] : [path];
  });
}

export function verifyPackageContents(appDirectory) {
  const app = resolve(appDirectory);
  const macResources = join(app, 'Contents', 'Resources');
  const resources = existsSync(macResources) ? macResources : join(app, 'resources');
  const archive = join(resources, 'app.asar');
  if (!existsSync(archive)) throw new Error('Packaged app.asar is missing');

  const paths = listPackage(archive, { isPack: false }).map(normalizeArchivePath);
  for (const path of paths) assertSafePath(path);

  const packaged = JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
  for (const field of ['name', 'version', 'main']) {
    if (packaged[field] !== projectPackage[field]) {
      throw new Error(`Packaged ${field} does not match package.json`);
    }
  }
  if (!paths.includes(projectPackage.main)) {
    throw new Error(`Packaged entry point is missing: ${projectPackage.main}`);
  }

  const unpacked = join(resources, 'app.asar.unpacked');
  for (const path of walk(unpacked)) {
    assertSafePath(relative(unpacked, path).split(sep).join('/'));
  }
  for (const path of walk(resources)) {
    const resourcePath = relative(resources, path).split(sep).join('/');
    if (resourcePath === publicCaBundle) {
      const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
      if (hash !== publicCaSha256) throw new Error('Unexpected public CA bundle contents');
      continue;
    }
    assertNoPrivatePath(resourcePath);
  }

  console.log(
    `Package contents OK: ${packaged.name} ${packaged.version}, ${paths.length} archive entries`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) {
    console.error('Usage: node scripts/verify-package-contents.mjs <unpacked app directory>');
    process.exit(2);
  }
  try {
    verifyPackageContents(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
