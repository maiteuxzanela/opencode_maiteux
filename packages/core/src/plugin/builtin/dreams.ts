export * as DreamsPlugin from "./dreams.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Cause, Effect } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { z } from "zod/v4"
import { PluginPromise } from "../promise.js"

const PACKAGE: string = "opencode-plugin-dreams"
const DEFAULT_ID = "opencode-plugin-dreams"

type BuiltinSetup = (context: any) => void | (() => void) | Promise<void | (() => void)>

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

/**
 * V1 tools declare their arguments as a Zod raw shape, while core tools require a
 * full schema. Without this conversion the bundled tools register with an empty
 * input schema and the model cannot pass `scope`, `fact`, `category`, or `query`.
 */
function toolInput(args: unknown) {
  if (args && typeof args === "object" && ("~standard" in args || "_zod" in args)) return args
  return z.object((args as Record<string, z.ZodType> | undefined) ?? {})
}

/**
 * V1 tools return a string or `{ output, metadata, attachments }`, while core tools
 * must return a `Tool.Result` object. Passing a raw string makes core's executor
 * evaluate `"output" in result` and fail the call.
 */
function toolResult(result: unknown) {
  if (typeof result === "string") return { content: result }
  if (result && typeof result === "object") {
    const value = result as {
      output?: unknown
      content?: string
      metadata?: Record<string, unknown>
    }
    const content = typeof value.output === "string" ? value.output : value.content
    return {
      ...(content === undefined ? {} : { content }),
      ...(value.metadata === undefined ? {} : { metadata: value.metadata }),
    }
  }
  return { content: result === undefined ? "" : String(result) }
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
        yield* Effect.logWarning(`[DreamsBuiltin] Failed to import "${PACKAGE}": ${imported.message}`)
        return
      }

      const mod = (imported as { default?: unknown }).default ?? imported
      if (!mod || typeof mod !== "object") {
        yield* Effect.logWarning(`[DreamsBuiltin] Package "${PACKAGE}" did not export a valid plugin object`)
        return
      }

      // Only provision after the package actually resolves, so a missing optional
      // dependency never creates memory directories during cold boot.
      ensureDreamsDirectories()

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
                if (res && typeof res === "object") {
                  if (res.tool && typeof res.tool === "object" && context.tool?.transform) {
                    context.tool.transform((editor: any) => {
                      for (const [name, def] of Object.entries(res.tool)) {
                        editor.add({
                          id: name,
                          name,
                          description: (def as any).description ?? "",
                          input: toolInput((def as any).args),
                          execute: async (input: any, toolContext: any) =>
                            toolResult(await (def as any).execute(input, toolContext)),
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
                  // Intentionally do not forward `res.dispose`: the package keeps one
                  // process-global SQLite handle created at import, and closing it here
                  // would permanently break reactivation in the same process because
                  // the cached module never reopens it ("Cannot use a closed database").
                  // Unloading still drops the tool registrations through the plugin scope.
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
