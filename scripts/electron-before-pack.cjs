const fs = require('node:fs');
const path = require('node:path');

const ARCH_NAMES = {
  0: 'x64',
  1: 'ia32',
  2: 'armv7l',
  3: 'arm64',
  4: 'universal'
};

function archName(value) {
  return ARCH_NAMES[value] || String(value || process.arch);
}

function assertFile(filePath, message) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${message}\nFalta: ${filePath}`);
  }
}

module.exports = async function beforePack(context) {
  const platform = context.electronPlatformName || context.packager?.platform?.nodeName;
  const arch = archName(context.arch);
  const root = context.appDir || context.packager?.projectDir || process.cwd();

  if (platform === 'win32') {
    assertFile(
      path.join(root, 'dist', 'anpr-eolo', 'anpr-eolo.exe'),
      'Build Windows bloqueado: falta el sidecar ANPR nativo para Windows. Ejecuta `npm run anpr:build:win` en Windows antes de empaquetar.'
    );
    assertFile(
      path.join(root, 'vendor', 'sidecars', 'go2rtc', 'win32-x64', 'go2rtc.exe'),
      'Build Windows bloqueado: falta go2rtc para Windows. Ejecuta `npm run sidecars:prepare` en Windows, o `GO2RTC_TARGET=win32-x64 npm run sidecars:prepare`.'
    );
    return;
  }

  if (platform === 'darwin') {
    const go2rtcTarget = arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
    assertFile(
      path.join(root, 'dist', 'anpr-eolo', 'anpr-eolo'),
      'Build macOS bloqueado: falta el sidecar ANPR nativo. Ejecuta `npm run anpr:build` antes de empaquetar.'
    );
    assertFile(
      path.join(root, 'vendor', 'sidecars', 'go2rtc', go2rtcTarget, 'go2rtc'),
      `Build macOS bloqueado: falta go2rtc para ${go2rtcTarget}. Ejecuta \`npm run sidecars:prepare\`.`
    );
  }
};
