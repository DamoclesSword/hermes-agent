/**
 * after-pack.mjs — electron-builder afterPack hook.
 *
 * Stamps the Hermes icon + identity onto the packed Windows Hermes.exe via
 * rcedit (delegated to set-exe-identity.mjs). This runs for EVERY packed build
 * — first install, `hermes desktop`, the installer's --update rebuild, and a
 * dev's manual `npm run pack` — so the branded exe can never silently revert
 * to the stock "Electron" icon/name (the bug when the stamp lived only in
 * install.ps1, which the update path doesn't use).
 *
 * Windows-only: rcedit edits PE resources, irrelevant on macOS/Linux where the
 * app identity comes from the bundle Info.plist / desktop entry. Best-effort:
 * a stamp failure must never fail an otherwise-good build (worst case is the
 * stock icon, not a broken app), so we log and resolve rather than throw.
 *
 * electron-builder passes a context with:
 *   - electronPlatformName: 'win32' | 'darwin' | 'linux'
 *   - appOutDir:            the unpacked app directory for this target
 *   - packager.appInfo.productFilename: the exe basename (e.g. 'Hermes')
 */

import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { stampExeIdentity } from './set-exe-identity.mjs'

const execFileAsync = promisify(execFile)

export default async function afterPack(context) {
  if (context.electronPlatformName === 'darwin') {
    const productName = context.packager?.appInfo?.productFilename || 'Hermes'
    const app = path.join(context.appOutDir, `${productName}.app`)

    // Local updater builds may not have a valid Apple Developer certificate.
    // Re-sign the complete bundle ad hoc so nested Electron signatures stay
    // internally consistent and macOS can launch the rebuilt local app.
    await execFileAsync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app])
    await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
    console.log(`[after-pack] applied and verified ad-hoc signature: ${app}`)
    return
  }

  if (context.electronPlatformName !== 'win32') {
    return
  }

  const productName = context.packager?.appInfo?.productFilename || 'Hermes'
  const exe = path.join(context.appOutDir, `${productName}.exe`)
  const desktopRoot = path.resolve(import.meta.dirname, '..')

  try {
    await stampExeIdentity(exe, desktopRoot)
  } catch (err) {
    // Never fail the build over a cosmetic stamp.
    console.warn(`[after-pack] exe identity stamp failed (${err.message}); Hermes.exe keeps the stock Electron icon`)
  }
}
