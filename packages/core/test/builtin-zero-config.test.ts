import fs from "fs"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ensureDreamsDirectories, Plugin as DreamsPlugin } from "../src/plugin/builtin/dreams.js"
import { Plugin as EnsemblePlugin } from "../src/plugin/builtin/ensemble.js"
import { PluginInternal } from "../src/plugin/internal.js"
import { ConfigNormalize } from "../src/config/normalize.js"
import { tmpdir } from "./fixture/tmpdir"

// The bundled dreams plugin resolves its storage with os.homedir(), and Bun caches
// that value at process start. Run through script/test.ts so the process HOME is a
// disposable directory; otherwise a direct `bun test` could touch the real
// ~/.config/opencode/dreams.
if (!process.env.OPENCODE_TEST_HOME) {
  throw new Error(
    "Run this suite with `bun run test` from packages/core: it isolates HOME before Bun caches os.homedir()",
  )
}

describe("Built-in Zero-Config Fallbacks", () => {
  test("ensureDreamsDirectories provisions full directory structure defensively in fresh dir", async () => {
    await using tmp = await tmpdir("dreams-zero-config-")
    const targetDir = path.join(tmp.path, "nested", "dreams")

    expect(fs.existsSync(targetDir)).toBe(false)

    const resolved = ensureDreamsDirectories(targetDir)
    expect(resolved).toBe(targetDir)
    expect(fs.existsSync(targetDir)).toBe(true)
    expect(fs.existsSync(path.join(targetDir, "collective"))).toBe(true)
    expect(fs.existsSync(path.join(targetDir, "personas"))).toBe(true)
    expect(fs.existsSync(path.join(targetDir, "daily"))).toBe(true)

    // Idempotency check: calling again on existing structure succeeds without throw
    expect(() => ensureDreamsDirectories(targetDir)).not.toThrow()
  })

  test("ensureDreamsDirectories handles uncreatable path without throwing", () => {
    // Null byte path or invalid path that cannot be created
    expect(() => ensureDreamsDirectories("\0invalid")).not.toThrow()
  })

  test("EnsembleBuiltin and DreamsBuiltin define valid Plugin contracts", () => {
    expect(EnsemblePlugin.id).toBe("ensemble")
    expect(typeof EnsemblePlugin.effect).toBe("function")

    expect(DreamsPlugin.id).toBe("opencode-plugin-dreams")
    expect(typeof DreamsPlugin.effect).toBe("function")
  })

  test("Internal plugins include Ensemble and Dreams in post array", () => {
    // Verify that PluginInternal exports both plugins in builtin post list
    const postIds = PluginInternal.post.map((p) => p.id)
    expect(postIds).toContain("ensemble")
    expect(postIds).toContain("opencode-plugin-dreams")
  })

  test("Builtin effect handles plugin execution safely without throwing or dying", async () => {
    const dummyHost = {
      app: {},
      location: { directory: "/tmp" },
      storage: {
        get: () => Effect.void,
        set: () => Effect.void,
        remove: () => Effect.void,
        scan: () => Effect.succeed([]),
      },
      tool: {
        reload: () => Effect.void,
        list: () => Effect.succeed([]),
        transform: () => Effect.void,
      },
      session: {
        hook: () => Effect.void,
      },
      worktree: {
        list: () => Effect.succeed([]),
        create: () => Effect.void,
        remove: () => Effect.void,
        refresh: () => Effect.void,
        reload: () => Effect.void,
        transform: () => Effect.void,
      },
      shell: {
        hook: () => Effect.void,
      },
      websearch: {
        transform: () => Effect.void,
      },
    } as any

    // Execution of Dreams effect must complete gracefully within a Scope
    await expect(
      Effect.runPromise(Effect.scoped(DreamsPlugin.effect(dummyHost)) as Effect.Effect<void>),
    ).resolves.toBeUndefined()

    // Execution of Ensemble effect must complete gracefully within a Scope
    await expect(
      Effect.runPromise(Effect.scoped(EnsemblePlugin.effect(dummyHost)) as Effect.Effect<void>),
    ).resolves.toBeUndefined()
  })

  test("Zero-config tolerance: empty configuration normalizes cleanly without error", () => {
    const result = ConfigNormalize.normalize({})
    expect(result.type).toBe("normalized")
    if (result.type === "normalized") {
      expect(result.diagnostics).toEqual([])
      expect(result.encoded).toEqual({})
    }
  })
})
