export * as EnsemblePlugin from "./ensemble.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Cause, Effect } from "effect"
import { PluginPromise } from "../promise.js"

const PACKAGE: string = "@maiteuxzanela/ensemble-room-lowcost"
const DEFAULT_ID = "ensemble"

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

      if ("effect" in mod && typeof mod.effect === "function") {
        yield* (mod as { effect: (c: typeof ctx) => Effect.Effect<void, unknown, any> }).effect(ctx).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(`[EnsembleBuiltin] Initialization defect in "${id}": ${Cause.squash(cause)}`),
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
