/**
 * electron-builder afterPack hook: properly ad-hoc sign the whole bundle.
 *
 * With `identity: null` electron-builder skips signing entirely, leaving only
 * the linker's partial adhoc signature on the main binary — the bundle's
 * resources are NOT sealed, `codesign --verify` fails, and on some macOS
 * versions Gatekeeper shows the dead-end "damaged, move to Trash" dialog
 * instead of the recoverable "unverified developer" one (System Settings →
 * Privacy & Security → "Open Anyway").
 *
 * A full `codesign --force --deep --sign -` seals every nested binary and
 * the resource envelope. It is still anonymous (no Apple Developer account,
 * no notarization), so Gatekeeper keeps warning on first launch — but the
 * Settings escape hatch is guaranteed to work and no terminal is needed.
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed and verified  ${appName}`);
};
