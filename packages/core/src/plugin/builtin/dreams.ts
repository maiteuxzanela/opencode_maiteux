export * as DreamsPlugin from "./dreams.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Cause, Effect } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { PluginPromise } from "../promise.js"

const PACKAGE: string = "opencode-plugin-dreams"
const DEFAULT_ID = "opencode-plugin-dreams"

export function ensureDreamsDirectories(overrideDir?: string): string {
  const dreamsDir =
    overrideDir ||
    process.env.OPENCODE_DREAMS_DIR ||
    path.join(os.homedir() || "/tmp", ".config", "opencode", "dreams")
  try {
    const subdirs = ["collective", "personas", "daily"]
    fs.mkdirSync(dreamsDir, { recursive: true })
    for (const sub of subdirs) {
      fs.mkdirSync(path.join(dreamsDir, sub), { recursive: true })
    }
  } catch {
    // Fail-safe: read-only filesystem or permission error must never crash boot
  }
  return dreamsDir
}

export const Plugin = define({
  id: DEFAULT_ID,
  effect: (ctx) =>
    Effect.gen(function* () {
      ensureDreamsDirectories()

      const imported = yield* Effect.tryPromise({
        try: () => import(PACKAGE),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(
        Effect.orElseSucceed((err) => err),
      )

      if (imported instanceof Error) {
        yield* Effect.logWarning(`[DreamsBuiltin] Failed to import "${PACKAGE}": ${imported.message}`)
        return
      }

      const mod = (imported as { default?: unknown }).default ?? imported
      if (!mod || typeof mod !== "object") {
        yield* Effect.logWarning(`[DreamsBuiltin] Package "${PACKAGE}" did not export a valid plugin object`)
        return
      }

      const id =
        "id" in mod && typeof mod.id === "string" && mod.id.trim().length > 0
          ? mod.id
          : DEFAULT_ID

      if ("effect" in mod && typeof mod.effect === "function") {
        yield* (mod as { effect: (c: typeof ctx) => Effect.Effect<void, unknown, any> }).effect(ctx).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(`[DreamsBuiltin] Initialization defect in "${id}": ${Cause.squash(cause)}`),
          ),
          Effect.asVoid,
        )
        return
      }

      const setup =
        "setup" in mod && typeof mod.setup === "function"
          ? (mod.setup as (context: any) => Promise<unknown> | unknown)
          : "server" in mod && typeof mod.server === "function"
            ? async (context: any) => {
                const res = await (mod as any).server({
                  client: context.app?.client ?? context,
                  directory: context.location?.directory,
                  project: context.location?.project,
                  worktree: context.worktree,
                })
                if (res && typeof res === "object") {
                  if (res.tool && typeof res.tool === "object" && context.tool?.transform) {
                    context.tool.transform((editor: any) => {
                      for (const [name, def] of Object.entries(res.tool)) {
                        editor.add({
                          id: name,
                          name,
                          description: (def as any).description ?? "",
                          execute: (input: any) => (def as any).execute(input),
                        })
                      }
                    })
                  }
                  if (typeof res["experimental.chat.system.transform"] === "function" && context.session?.hook) {
                    context.session.hook("context", async (ctx2: any) => {
                      const output = { system: [] as string[] }
                      await res["experimental.chat.system.transform"](
                        { sessionID: ctx2.sessionID },
                        output,
                      )
                      if (output.system.length > 0 && Array.isArray(ctx2.system)) {
                        ctx2.system.push(...output.system)
                      }
                    })
                  }
                  if (typeof res.dispose === "function") {
                    return () => res.dispose()
                  }
                }
              }
            : null

      if (!setup) {
        yield* Effect.logWarning(`[DreamsBuiltin] Plugin "${id}" has no valid setup function`)
        return
      }

      const promisePlugin = PluginPromise.fromPromise({
        id,
        setup,
      })

      yield* promisePlugin.effect(ctx).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`[DreamsBuiltin] Initialization defect in "${id}": ${Cause.squash(cause)}`),
        ),
        Effect.asVoid,
      )
    }),
})

export default Plugin
