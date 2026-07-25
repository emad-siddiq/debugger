// prodCss.js — locate the target's BUILT stylesheet.
//
// The isolation harness renders a component against the dev module graph, which
// is not quite what ships: the build minifies, reorders and drops. A "prod-css"
// toggle needs to know which file production serves, and how stale it is — a
// three-week-old bundle answers a different question than a fresh one, and
// showing it without saying so would be worse than not offering it.
//
// Path is derived from the configured target; nothing here is project-specific.

import fs from 'node:fs'
import path from 'node:path'

/** Vite's default output location, relative to the frontend root. */
export const ASSETS_REL = path.join('dist', 'assets')

/**
 * The newest built stylesheet under `<frontendDir>/dist/assets`, or a
 * not-found result with a hint. Never throws: "no build yet" is a normal
 * state, not an error.
 */
export function locateProdCss(frontendDir) {
  const assets = path.join(frontendDir, ASSETS_REL)
  let entries
  try {
    entries = fs.readdirSync(assets).filter((f) => f.endsWith('.css'))
  } catch {
    return { found: false, hint: 'no dist/assets — run the target build' }
  }
  const built = entries
    .map((f) => {
      const abs = path.join(assets, f)
      return { name: f, abs, mtime: fs.statSync(abs).mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)
  if (!built.length) {
    return { found: false, hint: 'no built CSS — run the target build' }
  }
  const newest = built[0]
  return {
    found: true,
    name: newest.name,
    // POSIX-joined: this is a URL path the browser requests, not a disk path.
    file: `${ASSETS_REL.split(path.sep).join('/')}/${newest.name}`,
    builtAt: new Date(newest.mtime).toISOString(),
    ageDays: Math.floor((Date.now() - newest.mtime) / 86_400_000),
    count: built.length,
  }
}

/** Absolute path of a built stylesheet by NAME, or null when it isn't one.
 *  Basename-only + `.css`-only, so this can't reach outside dist/assets. */
export function prodCssPath(frontendDir, name) {
  const base = path.basename(String(name || ''))
  if (!base.endsWith('.css')) {
    return null
  }
  const abs = path.join(frontendDir, ASSETS_REL, base)
  return fs.existsSync(abs) ? abs : null
}
