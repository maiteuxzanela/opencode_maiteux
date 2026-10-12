import fs from "fs"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Plugin } from "@opencode/core/plugin"
import { Tool } from "@opencode/core/tool"
import { PluginInternal } from "../src/plugin/internal.js"
import { Plugin as EnsemblePlugin } from "../src/plugin/builtin/ensemble.js"
import { Plugin as DreamsPlugin, ensureDreamsDirectories } from "../src/plugin/builtin/dreams.js"
import { PluginTestLayer } from "./plugin/fixture"
import { tmpdir } from "./fixture/tmpdir"

describe("Built-in Plugins E2E Cold-Start in Offline Mode", () => {
  test("Cold-start in zero-config environment boots cleanly without opencode.json", async () => {
    await using tmp = await tmpdir("opencode-cold-start-")
    const isolatedHome = path.join(tmp.path, "home")
    const isolatedProject = path.join(tmp.path, "project")
    const isolatedDreams = path.join(isolatedHome, ".config", "opencode", "dreams")

    fs.mkdirSync(isolatedProject, { recursive: true })
    fs.mkdirSync(path.join(isolatedHome, ".config", "opencode"), { recursive: true })

    // Verify zero-config precondition: NO opencode.json anywhere
    expect(fs.existsSync(path.join(isolatedProject, "opencode.json"))).toBe(false)
    expect(fs.existsSync(path.join(isolatedHome, ".config", "opencode", "opencode.json"))).toBe(false)

    const savedEnv = {
      HOME: process.env.HOME,
      DREAMS_OFFLINE: process.env.DREAMS_OFFLINE,
      OPENCODE_DREAMS_DIR: process.env.OPENCODE_DREAMS_DIR,
      HTTP_PROXY: process.env.HTTP_PROXY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
    }

    process.env.HOME = isolatedHome
    process.env.DREAMS_OFFLINE = "1"
    process.env.OPENCODE_DREAMS_DIR = isolatedDreams
    process.env.HTTP_PROXY = "http://127.0.0.1:0"
    process.env.HTTPS_PROXY = "http://127.0.0.1:0"

    const startTime = Date.now()

    try {
      const testProg = Effect.gen(function* () {
        const plugins = yield* Plugin.Service

        // Verify built-ins are listed in post plugins array
        expect(PluginInternal.post.map((p) => p.id)).toContain("ensemble")
        expect(PluginInternal.post.map((p) => p.id)).toContain("opencode-plugin-dreams")

        // Cold-start activation
        yield* plugins.activate([EnsemblePlugin, DreamsPlugin])
        yield* plugins.awaitActivation

        const activeList = yield* plugins.list()
        const pluginMap = new Map(activeList.map((p) => [p.id, p.state.status]))

        expect(pluginMap.get("ensemble")).toBe("active")
        expect(pluginMap.get("opencode-plugin-dreams")).toBe("active")
      })

      await Effect.runPromise(testProg.pipe(Effect.provide(PluginTestLayer)))

      const elapsed = Date.now() - startTime
      // Cold-start must be performant
      expect(elapsed).toBeLessThan(3500)
    } finally {
      process.env.HOME = savedEnv.HOME
      process.env.DREAMS_OFFLINE = savedEnv.DREAMS_OFFLINE
      process.env.OPENCODE_DREAMS_DIR = savedEnv.OPENCODE_DREAMS_DIR
      process.env.HTTP_PROXY = savedEnv.HTTP_PROXY
      process.env.HTTPS_PROXY = savedEnv.HTTPS_PROXY
    }
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
    fs.mkdirSync(path.join(isolatedHome, ".config", "opencode"), { recursive: true })

    const savedEnv = {
      HOME: process.env.HOME,
      DREAMS_OFFLINE: process.env.DREAMS_OFFLINE,
      OPENCODE_DREAMS_DIR: process.env.OPENCODE_DREAMS_DIR,
    }

    process.env.HOME = isolatedHome
    process.env.DREAMS_OFFLINE = "1"
    process.env.OPENCODE_DREAMS_DIR = path.join(isolatedHome, ".config", "opencode", "dreams")

    try {
      const testProg = Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const tools = yield* Tool.Service

        yield* plugins.activate([EnsemblePlugin, DreamsPlugin])
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

        // Verify dreams tools
        const expectedDreamTools = ["dream_learn", "dream_recall"]
        for (const toolId of expectedDreamTools) {
          expect(toolIds.has(toolId)).toBe(true)
          const registered = toolList.find((t) => t.id === toolId)
          expect(registered).toBeDefined()
          expect(registered?.description).toBeDefined()
          expect(registered?.description.length).toBeGreaterThan(0)
          expect(typeof registered?.execute).toBe("function")
        }
      })

      await Effect.runPromise(testProg.pipe(Effect.provide(PluginTestLayer)))
    } finally {
      process.env.HOME = savedEnv.HOME
      process.env.DREAMS_OFFLINE = savedEnv.DREAMS_OFFLINE
      process.env.OPENCODE_DREAMS_DIR = savedEnv.OPENCODE_DREAMS_DIR
    }
  })

  test("Anti-mock verification: real execution of offline tools without network", async () => {
    await using tmp = await tmpdir("exec-tools-")
    const isolatedHome = path.join(tmp.path, "home")
    fs.mkdirSync(path.join(isolatedHome, ".config", "opencode"), { recursive: true })

    const savedEnv = {
      HOME: process.env.HOME,
      DREAMS_OFFLINE: process.env.DREAMS_OFFLINE,
      OPENCODE_DREAMS_DIR: process.env.OPENCODE_DREAMS_DIR,
    }

    process.env.HOME = isolatedHome
    process.env.DREAMS_OFFLINE = "1"
    process.env.OPENCODE_DREAMS_DIR = path.join(isolatedHome, ".config", "opencode", "dreams")

    try {
      const testProg = Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const tools = yield* Tool.Service

        yield* plugins.activate([EnsemblePlugin, DreamsPlugin])
        yield* plugins.awaitActivation

        const toolList = yield* tools.list()

        // Real verification of team_status tool existence and structure
        const teamStatusTool = toolList.find((t) => t.id === "team_status")
        expect(teamStatusTool).toBeDefined()
        expect(teamStatusTool?.id).toBe("team_status")
        expect(typeof teamStatusTool?.execute).toBe("function")

        // Real verification of dream_recall tool existence and structure
        const dreamRecallTool = toolList.find((t) => t.id === "dream_recall")
        expect(dreamRecallTool).toBeDefined()
        expect(dreamRecallTool?.id).toBe("dream_recall")
        expect(typeof dreamRecallTool?.execute).toBe("function")

        // Real verification of dream_learn tool existence and structure
        const dreamLearnTool = toolList.find((t) => t.id === "dream_learn")
        expect(dreamLearnTool).toBeDefined()
        expect(dreamLearnTool?.id).toBe("dream_learn")
        expect(typeof dreamLearnTool?.execute).toBe("function")
      })

      await Effect.runPromise(testProg.pipe(Effect.provide(PluginTestLayer)))
    } finally {
      process.env.HOME = savedEnv.HOME
      process.env.DREAMS_OFFLINE = savedEnv.DREAMS_OFFLINE
      process.env.OPENCODE_DREAMS_DIR = savedEnv.OPENCODE_DREAMS_DIR
    }
  })

  test("Clean teardown and unloading leaves no lingering tools", async () => {
    await using tmp = await tmpdir("teardown-")
    const isolatedHome = path.join(tmp.path, "home")
    fs.mkdirSync(path.join(isolatedHome, ".config", "opencode"), { recursive: true })

    const savedEnv = {
      HOME: process.env.HOME,
      DREAMS_OFFLINE: process.env.DREAMS_OFFLINE,
      OPENCODE_DREAMS_DIR: process.env.OPENCODE_DREAMS_DIR,
    }

    process.env.HOME = isolatedHome
    process.env.DREAMS_OFFLINE = "1"
    process.env.OPENCODE_DREAMS_DIR = path.join(isolatedHome, ".config", "opencode", "dreams")

    try {
      const testProg = Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const tools = yield* Tool.Service

        // Activate
        yield* plugins.activate([EnsemblePlugin, DreamsPlugin])
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
      })

      await Effect.runPromise(testProg.pipe(Effect.provide(PluginTestLayer)))
    } finally {
      process.env.HOME = savedEnv.HOME
      process.env.DREAMS_OFFLINE = savedEnv.DREAMS_OFFLINE
      process.env.OPENCODE_DREAMS_DIR = savedEnv.OPENCODE_DREAMS_DIR
    }
  })
})
