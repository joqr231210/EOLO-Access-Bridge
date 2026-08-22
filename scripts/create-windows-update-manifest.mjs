import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [, , installerPath, downloadUrl, versionArg] = process.argv;

if (!installerPath || !downloadUrl) {
  console.error('Uso: node scripts/create-windows-update-manifest.mjs <installer.exe> <download-url> [version]');
  process.exit(1);
}

const root = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(versionArg || packageJson.version || '').replace(/^v/i, '');
const absoluteInstallerPath = path.resolve(root, installerPath);

if (!version) {
  console.error('No se pudo resolver la version desde package.json o argumento.');
  process.exit(1);
}

if (!fs.existsSync(absoluteInstallerPath)) {
  console.error(`No existe el instalador: ${absoluteInstallerPath}`);
  process.exit(1);
}

const buffer = fs.readFileSync(absoluteInstallerPath);
const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
const outputPath = path.join(root, 'updates', 'windows-latest.json');
const manifest = {
  version,
  publishedAt: new Date().toISOString(),
  notes: `EOLO Access Bridge ${version}`,
  windows: {
    x64: {
      url: downloadUrl,
      sha256
    }
  }
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Manifest escrito: ${outputPath}`);
console.log(`SHA-256: ${sha256}`);
