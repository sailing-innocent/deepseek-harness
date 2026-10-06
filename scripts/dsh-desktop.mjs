#!/usr/bin/env node
/**
 * Dev-carrier for Desktop's reserved profile.
 *
 * The npm CLI (`node apps/cli/lib/bin.js`) refuses `--profile desktop`
 * (apps/cli/src/args.ts rejects it for everyone except Desktop's installed
 * carrier, which passes `manageDesktopProfile`). This wrapper imports the
 * built CLI and opts in, so a development checkout can manage the desktop
 * profile the same way the packaged `dsh.cmd` does:
 *
 *   node scripts/dsh-desktop.mjs plugin --profile desktop add file:<abs path>
 *   node scripts/dsh-desktop.mjs plugin --profile desktop list
 *
 * The desktop profile must already exist: launch Desktop once and fully quit
 * it (the app initializes $DSH_HOME/profiles/desktop on first start).
 */
import { runCli } from '../apps/cli/lib/bin.js'

await runCli({ manageDesktopProfile: true })
