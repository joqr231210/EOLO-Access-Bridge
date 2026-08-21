import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const version = process.env.GO2RTC_VERSION || 'v1.9.14';

const targets = {
  'darwin-arm64': 'go2rtc_mac_arm64.zip',
  'darwin-x64': 'go2rtc_mac_amd64.zip',
  'win32-x64': 'go2rtc_win64.zip',
  'linux-x64': 'go2rtc_linux_amd64'
};

function currentTargetKey() {
  const arch = os.arch() === 'x64' ? 'x64' : os.arch();
  return `${process.platform}-${arch}`;
}

function download(url, destination) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const file = fs.createWriteStream(destination);
    https
      .get(url, (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          file.close();
          fs.rmSync(destination, { force: true });
          download(response.headers.location, destination).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          file.close();
          fs.rmSync(destination, { force: true });
          reject(new Error(`HTTP ${response.statusCode} descargando ${url}`));
          return;
        }
        response.pipe(file);
        file.on('finish', () => {
          file.close(resolve);
        });
      })
      .on('error', (error) => {
        file.close();
        fs.rmSync(destination, { force: true });
        reject(error);
      });
  });
}

function extractZip(zipPath, destination) {
  fs.mkdirSync(destination, { recursive: true });
  if (process.platform === 'win32') {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destination}' -Force`],
      { stdio: 'inherit' }
    );
    return;
  }
  execFileSync('unzip', ['-o', zipPath, '-d', destination], {
    stdio: 'inherit'
  });
}

const targetKey = process.env.GO2RTC_TARGET || currentTargetKey();
const assetName = targets[targetKey];
if (!assetName) {
  throw new Error(`No hay asset go2rtc configurado para ${targetKey}`);
}

const outputName = targetKey.startsWith('win32') ? 'go2rtc.exe' : 'go2rtc';
const outputPath = path.join(rootDir, 'vendor', 'sidecars', 'go2rtc', targetKey, outputName);

if (!fs.existsSync(outputPath)) {
  const url = `https://github.com/AlexxIT/go2rtc/releases/download/${version}/${assetName}`;
  const downloadPath = assetName.endsWith('.zip') ? `${outputPath}.zip` : outputPath;
  console.log(`Descargando ${url}`);
  await download(url, downloadPath);
  if (assetName.endsWith('.zip')) {
    extractZip(downloadPath, path.dirname(outputPath));
    fs.rmSync(downloadPath, { force: true });
    const extractedBinary = path.join(path.dirname(outputPath), outputName);
    if (!fs.existsSync(extractedBinary)) {
      throw new Error(`No se encontro ${outputName} dentro de ${assetName}`);
    }
  }
}

if (!targetKey.startsWith('win32')) {
  fs.chmodSync(outputPath, 0o755);
}

console.log(`go2rtc listo: ${path.relative(rootDir, outputPath)}`);
