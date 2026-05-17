const { existsSync } = require('node:fs');
const { join } = require('node:path');

const PRODUCT_EXECUTABLE_NAME = 'CommandCabin.exe';
const WINDOWS_ICON_RELATIVE_PATH = ['apps', 'desktop', 'build', 'icon.ico'];

module.exports = async function afterPackWindowsIcon(context) {
  if (context.electronPlatformName !== 'win32') {
    return;
  }

  const exePath = join(context.appOutDir, PRODUCT_EXECUTABLE_NAME);
  const iconPath = join(context.packager.projectDir, ...WINDOWS_ICON_RELATIVE_PATH);

  if (!existsSync(exePath)) {
    throw new Error(`CommandCabin executable was not found at ${exePath}.`);
  }

  if (!existsSync(iconPath)) {
    throw new Error(`CommandCabin Windows icon was not found at ${iconPath}.`);
  }

  const { rcedit } = await import('rcedit');
  await rcedit(exePath, {
    icon: iconPath,
  });
};
