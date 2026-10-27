import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { ensureEnsembleConfigDirectory, resolveEnsembleHomeDirectory } from "../src/plugin/builtin/ensemble.js"
import { tmpdir } from "./fixture/tmpdir"

/**
 * TICKET-HARNESS-87 (Item 1) — fallback de HOME do plugin embutido `ensemble`.
 *
 * Defeito original: `ensureEnsembleConfigDirectory` usava
 * `process.env.HOME ?? process.env.USERPROFILE ?? "~"`. Com HOME ausente,
 * `path.join("~", ".config", "opencode")` criava um diretório LITERAL
 * `./~/.config/opencode` relativo ao cwd em vez do home real.
 *
 * Defeito residual (achado do SDET): o primeiro fix devolvia `os.homedir()` quando
 * o valor era `"~"`, mas em POSIX o `os.homedir()` de Node E de Bun lê `$HOME`
 * primeiro — com `HOME="~"` ele devolve `"~"`. O guard virava no-op.
 *
 * Contrato sob teste (sem mocks, sem stub):
 *   H1  HOME e USERPROFILE ausentes → os.homedir() real, jamais "~".
 *   H2  HOME literal "~" → home REAL do SO (medido por um oracle Node/passwd
 *       independente), nunca "~" e nunca caminho relativo.
 *   H2b HOME "~/sub" → também não vira caminho relativo literal.
 *   H3  HOME vazio é ignorado (string vazia é falsy, `||` não `??`).
 *   H4  ensureEnsembleConfigDirectory provisiona <home>/.config/opencode e
 *       NUNCA cria um diretório literal "~" no cwd.
 */

const ORIGINAL = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  cwd: process.cwd(),
}

const restore = () => {
  if (ORIGINAL.HOME === undefined) delete process.env.HOME
  else process.env.HOME = ORIGINAL.HOME
  if (ORIGINAL.USERPROFILE === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = ORIGINAL.USERPROFILE
  process.chdir(ORIGINAL.cwd)
}

afterEach(restore)

/**
 * Oracle INDEPENDENTE do home real: `os.userInfo()` do Node é passwd-based e ignora
 * `$HOME`, então mesmo com HOME="~" ele devolve o home da conta. O Bun segue `$HOME`
 * em `os.userInfo()`, por isso a medição roda em um processo Node separado.
 */
const passwdHomeViaNode = (): string | undefined => {
  const probe = spawnSync(
    process.execPath.replace(/bun$/, "node"),
    ["-e", "process.stdout.write(require('node:os').userInfo().homedir)"],
    { encoding: "utf8", env: { ...process.env, HOME: "~" } },
  )
  const home = (probe.stdout ?? "").trim()
  return probe.status === 0 && home.startsWith("/") ? home : undefined
}

describe("TICKET-HARNESS-87 Item 1: HOME fallback do EnsembleBuiltin", () => {
  test("H1 HOME ausente cai em os.homedir() e nunca no literal '~'", () => {
    delete process.env.HOME
    delete process.env.USERPROFILE

    const home = resolveEnsembleHomeDirectory()

    expect(home).toBe(os.homedir())
    expect(home).not.toBe("~")
    expect(home.startsWith("~")).toBe(false)
  })

  test("H2 HOME literal '~' é expandido para o home REAL (nunca '~', nunca relativo)", () => {
    process.env.HOME = "~"
    delete process.env.USERPROFILE

    const home = resolveEnsembleHomeDirectory()

    // Invariantes que NÃO dependem de como o home foi descoberto.
    expect(home).not.toBe("~")
    expect(home.startsWith("~")).toBe(false)
    expect(path.isAbsolute(home)).toBe(true)

    // Oracle independente (Node/passwd): com HOME="~" o Node ignora o env e
    // responde o home da conta. Sem o oracle (node ausente), as invariantes acima
    // continuam valendo e o teste não fica vacuoso.
    const realHome = passwdHomeViaNode()
    if (realHome) expect(home).toBe(realHome)

    // "~/sub" também é um caminho RELATIVO literal se não for expandido.
    process.env.HOME = "~/sub"
    const nested = resolveEnsembleHomeDirectory()
    expect(nested.startsWith("~")).toBe(false)
    expect(path.isAbsolute(nested)).toBe(true)
    expect(nested).not.toBe("~/sub")
  })

  test("H3 HOME vazio é ignorado em favor de USERPROFILE (||, não ??)", () => {
    process.env.HOME = ""
    process.env.USERPROFILE = "/tmp/harness87-userprofile"

    expect(resolveEnsembleHomeDirectory()).toBe("/tmp/harness87-userprofile")
  })

  test("H4 ensureEnsembleConfigDirectory nunca cria ./~ literal no cwd", async () => {
    await using tmp = await tmpdir("harness87-cwd-")
    process.chdir(tmp.path)
    // HOME ausente + USERPROFILE válido: mantém a suíte hermética (não escreve no
    // home real mesmo quando executada fora de script/test.ts).
    process.env.HOME = ""
    process.env.USERPROFILE = tmp.path

    const configDir = ensureEnsembleConfigDirectory()

    expect(configDir).toBe(path.join(tmp.path, ".config", "opencode"))
    expect(fs.existsSync(configDir)).toBe(true)
    expect(fs.existsSync(path.join(tmp.path, "~"))).toBe(false)
    expect(configDir.split(path.sep)).not.toContain("~")

    restore()
  })
})
