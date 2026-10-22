import fs from "fs"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Location } from "@opencode/core/location"
import { type Generation, Plugin } from "@opencode/core/plugin"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import { PluginInternal } from "../src/plugin/internal.js"
import { Plugin as EnsemblePlugin } from "../src/plugin/builtin/ensemble.js"
import { Plugin as DreamsPlugin, ensureDreamsDirectories } from "../src/plugin/builtin/dreams.js"
import { definition } from "../src/tool/runtime.js"
import { PluginTestLayer } from "./plugin/fixture"
import { withEnv } from "./fixture/env"
import { toolIdentity } from "./lib/tool"
import { tmpdir } from "./fixture/tmpdir"

// The bundled dreams plugin resolves its storage with os.homedir(), and Bun caches
// that value at process start. A runtime process.env.HOME change cannot redirect it,
// so this suite must run through script/test.ts, which sets OPENCODE_TEST_HOME/HOME
// before the process starts. Fail fast instead of writing into the developer's real
// ~/.config/opencode/dreams.
if (!process.env.OPENCODE_TEST_HOME) {
  throw new Error(
    "Run this suite with `bun run test` from packages/core: it isolates HOME before Bun caches os.homedir()",
  )
}

// The bundled ensemble plugin defaults to a dashboard on port 4747 and, on
// EADDRINUSE, probes the live daemon's /api/health without a timeout. Disable it
// through the project config that the plugin actually reads
// (ctx.location.directory), so the suite never binds or probes the real port.
function disableEnsembleDashboard(directory: string) {
  const configDir = path.join(directory, ".opencode")
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, "ensemble.json"), JSON.stringify({ dashboardPort: 0 }))
}

const builtins: Generation[] = [EnsemblePlugin, DreamsPlugin].map((plugin) => ({
  ...plugin,
  revision: "builtin-test",
  source: { type: "builtin" as const },
}))

describe("Built-in Plugins E2E Cold-Start in Offline Mode", () => {
  test("Cold-start in zero-config environment boots cleanly without opencode.json", async () => {
    await using tmp = await tmpdir("opencode-cold-start-")
    const isolatedHome = path.join(tmp.path, "home")
    const isolatedProject = path.join(tmp.path, "project")
    const isolatedDreams = path.join(isolatedHome, ".config", "opencode", "dreams")

    fs.mkdirSync(isolatedProject, { recursive: true })
    // Deliberately do not create ~/.config/opencode: a first run has no config directory.

    // Verify zero-config precondition: NO opencode.json anywhere
    expect(fs.existsSync(path.join(isolatedProject, "opencode.json"))).toBe(false)
    expect(fs.existsSync(path.join(isolatedHome, ".config", "opencode", "opencode.json"))).toBe(false)

    const testProg = withEnv(
      {
        HOME: isolatedHome,
        DREAMS_OFFLINE: "1",
        OPENCODE_DREAMS_DIR: isolatedDreams,
        HTTP_PROXY: "http://127.0.0.1:0",
        HTTPS_PROXY: "http://127.0.0.1:0",
      },
      () =>
        Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          const tools = yield* Tool.Service

          // Verify built-ins are listed in post plugins array
          expect(PluginInternal.post.map((p) => p.id)).toContain("ensemble")
          expect(PluginInternal.post.map((p) => p.id)).toContain("opencode-plugin-dreams")

          const location = yield* Location.Service
          disableEnsembleDashboard(location.directory)

          // Cold-start activation
          yield* plugins.activate(builtins)
          yield* plugins.awaitActivation

          const activeList = yield* plugins.list()
          const pluginMap = new Map<string, string>(activeList.map((p) => [String(p.id), p.state.status]))

          expect(pluginMap.get("ensemble")).toBe("active")
          expect(pluginMap.get("opencode-plugin-dreams")).toBe("active")

          // A first run has no config directory; the bundled plugins must still
          // initialize their storage and expose their tools.
          const toolIds = new Set((yield* tools.list()).map((tool) => tool.id))
          expect(toolIds.has("team_create")).toBe(true)
          expect(toolIds.has("dream_learn")).toBe(true)
          expect(fs.existsSync(path.join(isolatedHome, ".config", "opencode"))).toBe(true)
        }),
    )

    await Effect.runPromise(testProg.pipe(Effect.provide(PluginTestLayer)))
  })

  test("Automatic provisioning of Dreams memory directories on cold-start", async () => {
    await using tmp = await tmpdir("dreams-provision-")
    const customDreamsPath = path.join(tmp.path, "custom_dreams")

    expect(fs.existsSync(customDreamsPath)).toBe(false)

    const createdPath = ensureDreamsDirectories(customDreamsPath)
    expect(createdPath).toBe(customDreamsPath)
    expect(fs.existsSync(customDreamsPath)).toBe(true)
    expect(fs.existsSync(path.join(customDreamsPath, "collective"))).toBe(true)
    expect(fs.existsSync(path.join(customDreamsPath, "personas"))).toBe(true)
    expect(fs.existsSync(path.join(customDreamsPath, "daily"))).toBe(true)

    // Idempotency check: repeated calls succeed without error
    expect(() => ensureDreamsDirectories(customDreamsPath)).not.toThrow()
  })

  test("Offline registration of all Ensemble and Dreams tools with valid schemas", async () => {
    await using tmp = await tmpdir("tools-reg-")
    const isolatedHome = path.join(tmp.path, "home")

    const testProg = withEnv(
      {
        HOME: isolatedHome,
        DREAMS_OFFLINE: "1",
        OPENCODE_DREAMS_DIR: path.join(isolatedHome, ".config", "opencode", "dreams"),
      },
      () =>
        Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          const tools = yield* Tool.Service

          const location = yield* Location.Service
          disableEnsembleDashboard(location.directory)

          yield* plugins.activate(builtins)
          yield* plugins.awaitActivation

          const toolList = yield* tools.list()
          const toolIds = new Set(toolList.map((t) => t.id))

          // Verify ensemble tools
          const expectedTeamTools = [
            "team_create",
            "team_spawn",
            "team_message",
            "team_broadcast",
            "team_tasks_list",
            "team_tasks_add",
            "team_tasks_complete",
            "team_claim",
            "team_results",
            "team_shutdown",
            "team_cleanup",
            "team_merge",
            "team_status",
            "team_view",
          ]

          for (const toolId of expectedTeamTools) {
            expect(toolIds.has(toolId)).toBe(true)
            const registered = toolList.find((t) => t.id === toolId)
            expect(registered).toBeDefined()
            expect(registered?.description).toBeDefined()
            expect(registered?.description.length).toBeGreaterThan(0)
            expect(typeof registered?.execute).toBe("function")
          }

          // Verify dreams tools, including their input schemas
          const expectedDreamTools = ["dream_learn", "dream_recall"]
          for (const toolId of expectedDreamTools) {
            expect(toolIds.has(toolId)).toBe(true)
            const registered = toolList.find((t) => t.id === toolId)
            expect(registered).toBeDefined()
            expect(registered?.description).toBeDefined()
            expect(registered?.description.length).toBeGreaterThan(0)
            expect(typeof registered?.execute).toBe("function")
            expect(registered?.input).toBeDefined()
          }

          const dreamLearn = toolList.find((t) => t.id === "dream_learn")
          const learnSchema = definition(dreamLearn!).inputSchema as {
            properties?: Record<string, unknown>
          }
          expect(Object.keys(learnSchema.properties ?? {}).sort()).toEqual(["category", "fact", "scope"])

          const dreamRecall = toolList.find((t) => t.id === "dream_recall")
          const recallSchema = definition(dreamRecall!).inputSchema as {
            properties?: Record<string, unknown>
          }
          expect(Object.keys(recallSchema.properties ?? {}).sort()).toEqual(["category", "query", "scope"])
        }),
    )

    await Effect.runPromise(testProg.pipe(Effect.provide(PluginTestLayer)))
  })

  test("Anti-mock verification: real execution of offline tools without network", async () => {
    await using tmp = await tmpdir("exec-tools-")
    const isolatedHome = path.join(tmp.path, "home")

    const testProg = withEnv(
      {
        HOME: isolatedHome,
        DREAMS_OFFLINE: "1",
        OPENCODE_DREAMS_DIR: path.join(isolatedHome, ".config", "opencode", "dreams"),
      },
      () =>
        Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          const tools = yield* Tool.Service

          const location = yield* Location.Service
          disableEnsembleDashboard(location.directory)

          yield* plugins.activate(builtins)
          yield* plugins.awaitActivation

          const snapshot = yield* tools.snapshot()
          const run = (code: string) =>
            snapshot.execute({
              sessionID: Session.ID.make("ses_builtin_exec"),
              ...toolIdentity,
              call: { type: "tool-call", id: "call_builtin_exec", name: "execute", input: { code } },
            })

          // Real execution through the production tool pipeline (code mode).
          const learned = yield* run(
            `return await tools.dream_learn({ scope: "collective", fact: "cold start offline probe", category: "learning" })`,
          )
          const learnedOutput = learned.output as { output: string; error?: boolean }
          expect(learnedOutput.error).not.toBe(true)
          expect(learnedOutput.output).toContain("Memory logged to daily stream")

          const recalled = yield* run(`return await tools.dream_recall({ query: "cold start offline probe" })`)
          const recalledOutput = recalled.output as { output: string; error?: boolean }
          expect(recalledOutput.error).not.toBe(true)
          expect(typeof recalledOutput.output).toBe("string")
        }),
    )

    await Effect.runPromise(testProg.pipe(Effect.provide(PluginTestLayer)))
  })

  test("Clean teardown and unloading leaves no lingering tools", async () => {
    await using tmp = await tmpdir("teardown-")
    const isolatedHome = path.join(tmp.path, "home")

    const testProg = withEnv(
      {
        HOME: isolatedHome,
        DREAMS_OFFLINE: "1",
        OPENCODE_DREAMS_DIR: path.join(isolatedHome, ".config", "opencode", "dreams"),
      },
      () =>
        Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          const tools = yield* Tool.Service

          const location = yield* Location.Service
          disableEnsembleDashboard(location.directory)

          // Activate
          yield* plugins.activate(builtins)
          yield* plugins.awaitActivation

          expect((yield* tools.list()).some((t) => t.id === "dream_learn")).toBe(true)

          // Deactivate all
          yield* plugins.activate([])
          yield* plugins.awaitActivation

          const activeList = yield* plugins.list()
          expect(activeList.length).toBe(0)

          // Check that tools were cleanly removed
          const lingeringTools = yield* tools.list()
          expect(lingeringTools.some((t) => t.id === "dream_learn")).toBe(false)
          expect(lingeringTools.some((t) => t.id === "team_create")).toBe(false)
        }),
    )

    await Effect.runPromise(testProg.pipe(Effect.provide(PluginTestLayer)))
  })
})
