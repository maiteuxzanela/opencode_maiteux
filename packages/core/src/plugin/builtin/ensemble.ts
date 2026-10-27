export * as EnsemblePlugin from "./ensemble.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Cause, Effect } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { PluginPromise } from "../promise.js"

const PACKAGE: string = "@maiteuxzanela/ensemble-room-lowcost"
const DEFAULT_ID = "ensemble"

type BuiltinSetup = (context: any) => void | (() => void) | Promise<void | (() => void)>

/**
 * `os.homedir()` prefers `$HOME` on POSIX, so a poisoned `HOME` (e.g. the literal
 * `"~"`) leaks straight back through it. `os.userInfo().homedir` is passwd-based in
 * Node but follows `$HOME` in Bun, so it is used only as an extra candidate.
 */
function safeUserInfoHome(): string | undefined {
  try {
    return os.userInfo().homedir
  } catch {
    return undefined
  }
}

/**
 * Last-resort passwd lookup: reads the account database directly so a literal `"~"`
 * can be expanded to the real home even in runtimes whose `os.homedir()` follows
 * `$HOME` (Bun). Returns undefined on Windows or when the entry is unavailable.
 */
function passwdHome(): string | undefined {
  if (process.platform === "win32") return undefined
  try {
    const uid = typeof process.getuid === "function" ? String(process.getuid()) : undefined
    if (!uid) return undefined
    const entry = fs
      .readFileSync("/etc/passwd", "utf8")
      .split("\n")
      .find((line) => {
        const fields = line.split(":")
        return fields.length >= 6 && fields[2] === uid
      })
    return entry?.split(":")[5] || undefined
  } catch {
    return undefined
  }
}

/**
 * A usable home is non-empty and NOT an unexpanded tilde: `"~"` / `"~/..."` would be
 * joined verbatim by `path.join`, recreating a literal `./~` folder in the cwd.
 */
function isUsableHome(value: string | undefined): value is string {
  // Declared as `string` (not `string | undefined`) so `path.isAbsolute` is
  // type-safe under strictNullChecks; `Boolean(candidate)` short-circuits empties.
  // Absolute is mandatory: `"~"`, `"~/sub"` and any other relative value would be
  // joined verbatim and recreate a literal `./~` folder in the cwd.
  const candidate = value?.trim() ?? ""
  return Boolean(candidate) && path.isAbsolute(candidate)
}

/**
 * Resolve the user's real home directory.
 *
 * `HOME` is frequently unset (Windows, systemd units, containers, sandboxes) and the
 * previous `?? "~"` fallback made `path.join` create a literal `./~/.config/opencode`
 * directory relative to the process cwd. A literal `"~"` is just as bad: `os.homedir()`
 * reads `$HOME` first on POSIX (Node and Bun), so it echoes the poisoned value back.
 * Candidates are therefore filtered and, if nothing usable remains, `/tmp` is used.
 */
export function resolveEnsembleHomeDirectory(): string {
  // Declared precedence (TICKET-HARNESS-87): HOME → USERPROFILE → os.homedir() → /tmp.
  const declared = process.env.HOME || process.env.USERPROFILE || os.homedir() || "/tmp"
  if (isUsableHome(declared)) return declared.trim()

  // `os.homedir()` and Bun's `os.userInfo()` follow `$HOME`; the passwd database is the
  // only source that still knows the real home when the environment is poisoned.
  for (const lookup of [safeUserInfoHome, passwdHome]) {
    const value = lookup()
    if (isUsableHome(value)) return value.trim()
  }
  return "/tmp"
}

/**
 * The bundled ensemble plugin's V2 setup opens `$HOME/.config/opencode/ensemble.db`
 * without creating the parent directory (only its V1 entry point did). A first run
 * has no config directory yet, so the SQLite open fails and the adapter would report
 * an active plugin with no tools. Provision the exact directory its `getDbPath()`
 * targets before initialization.
 */
export function ensureEnsembleConfigDirectory(): string {
  const home = resolveEnsembleHomeDirectory()
  const configDir = path.join(home, ".config", "opencode")
  try {
    fs.mkdirSync(configDir, { recursive: true })
  } catch {
    // Fail-safe: read-only filesystem or permission error must never crash boot
  }
  return configDir
}

export const Plugin = define({
  id: DEFAULT_ID,
  effect: (ctx) =>
    Effect.gen(function* () {
      const imported = yield* Effect.tryPromise({
        try: () => import(PACKAGE),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(
        Effect.orElseSucceed((err) => err),
      )

      if (imported instanceof Error) {
        yield* Effect.logWarning(`[EnsembleBuiltin] Failed to import "${PACKAGE}": ${imported.message}`)
        return
      }

      const mod = (imported as { default?: unknown }).default ?? imported
      if (!mod || typeof mod !== "object") {
        yield* Effect.logWarning(`[EnsembleBuiltin] Package "${PACKAGE}" did not export a valid plugin object`)
        return
      }

      const id =
        "id" in mod && typeof mod.id === "string" && mod.id.trim().length > 0
          ? mod.id
          : DEFAULT_ID

      // Only provision after the package actually resolves, so a missing optional
      // dependency never creates directories in the user's home during cold boot.
      ensureEnsembleConfigDirectory()

      if ("effect" in mod && typeof mod.effect === "function") {
        yield* (mod as { effect: (c: typeof ctx) => Effect.Effect<void, unknown, any> }).effect(ctx).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(`[EnsembleBuiltin] Initialization defect in "${id}": ${Cause.squash(cause)}`),
          ),
          Effect.asVoid,
        )
        return
      }

      const setup: BuiltinSetup | null =
        "setup" in mod && typeof mod.setup === "function"
          ? async (context: any) => {
              const result = await (mod.setup as (context: any) => unknown)(context)
              return typeof result === "function" ? (result as () => void) : undefined
            }
          : "server" in mod && typeof mod.server === "function"
            ? async (context: any) => {
                const res = await (mod as any).server({
                  client: context.app?.client ?? context,
                  directory: context.location?.directory,
                  project: context.location?.project,
                  worktree: context.worktree,
                })
                if (res && typeof res.dispose === "function") {
                  return () => res.dispose()
                }
              }
            : null

      if (!setup) {
        yield* Effect.logWarning(`[EnsembleBuiltin] Plugin "${id}" has no valid setup function`)
        return
      }

      const promisePlugin = PluginPromise.fromPromise({
        id,
        setup,
      })

      yield* promisePlugin.effect(ctx).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`[EnsembleBuiltin] Initialization defect in "${id}": ${Cause.squash(cause)}`),
        ),
        Effect.asVoid,
      )
    }),
})

export default Plugin
