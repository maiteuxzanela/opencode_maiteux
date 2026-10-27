#!/usr/bin/env bun
/**
 * Verificador determinístico dos pins de Node das GitHub Actions — TICKET-HARNESS-79.
 *
 * SEM MOCKS: lê os YAMLs REAIS com o parser real do runtime (Bun.YAML), percorre
 * a árvore `jobs → steps` de cada workflow e exige que TODO `actions/setup-node`
 * declare versão EXATA e endurecida. Rejeita:
 *   - pins flutuantes ("24", "22", "26") — resolução não determinística;
 *   - as versões vulneráveis que o ticket corrige (26.4.0, 24.15, 24.16).
 *
 * Também confirma que o pin do Bun (`packageManager`) permaneceu intocado.
 *
 * TICKET-HARNESS-89: os pins de Node em composite actions (action.yml sob
 * .github/actions/) passaram de relatório informativo a check BLOQUEANTE — o setup-bun
 * mantinha "24" flutuante e agora exige patch exato da allowlist.
 *
 * Uso:  bun script/verify-node-version-pins.mjs
 *       PINS_ROOT=/caminho/alternativo bun script/verify-node-version-pins.mjs
 *       (PINS_ROOT permite apontar para uma cópia mutada da árvore nos testes
 *        determinísticos de regressão sem tocar nos arquivos reais)
 * Exit: 0 = tudo conforme; 1 = há violação (lista no stderr).
 */
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const RAIZ = process.env.PINS_ROOT
  ? path.resolve(process.env.PINS_ROOT)
  : path.resolve(import.meta.dir, "..")
const DIR_WORKFLOWS = path.join(RAIZ, ".github", "workflows")
const DIR_ACOES = path.join(RAIZ, ".github", "actions")
const PERMITIDOS = new Set(["24.22.1", "26.12.1"])
const VULNERAVEIS = new Set(["26.4.0", "24.15", "24.16"])
const BUN_PIN = "bun@1.4.2"

const falhas = []
const ok = (cond, msg) => {
  if (!cond) falhas.push(msg)
}

const arquivos = readdirSync(DIR_WORKFLOWS)
  .filter((f) => /\.ya?ml$/.test(f))
  .sort()

let totalSetupNode = 0
let totalPassos = 0

for (const arquivo of arquivos) {
  const texto = readFileSync(path.join(DIR_WORKFLOWS, arquivo), "utf8")
  let doc
  try {
    doc = Bun.YAML.parse(texto)
  } catch (err) {
    falhas.push(`${arquivo}: YAML inválido — ${err.message}`)
    continue
  }
  ok(doc !== null && typeof doc === "object", `${arquivo}: raiz do YAML deve ser objeto`)
  ok(doc?.jobs !== null && typeof doc?.jobs === "object", `${arquivo}: deve declarar "jobs"`)

  for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
    ok(Boolean(job?.["runs-on"] || job?.uses), `${arquivo}: job "${jobId}" sem runs-on/uses`)
    const steps = job?.steps
    if (steps === undefined) continue
    ok(Array.isArray(steps), `${arquivo}: job "${jobId}" com steps fora de array`)
    for (const [idx, step] of (steps ?? []).entries()) {
      totalPassos++
      ok(
        Boolean(step?.uses || step?.run),
        `${arquivo}: job "${jobId}" step[${idx}] sem "uses" nem "run"`
      )
      const uses = String(step?.uses ?? "")
      if (!uses.startsWith("actions/setup-node")) continue
      totalSetupNode++
      const versao = step?.with?.["node-version"]
      const rotulo = `${arquivo} → ${jobId}[${idx}]`
      ok(typeof versao === "string" && versao.length > 0, `${rotulo}: setup-node sem node-version`)
      if (typeof versao === "string") {
        ok(
          PERMITIDOS.has(versao),
          `${rotulo}: node-version "${versao}" fora da allowlist endurecida (${[...PERMITIDOS].join(", ")})`
        )
        ok(!VULNERAVEIS.has(versao), `${rotulo}: node-version vulnerável "${versao}"`)
      }
      ok(
        !/^\d+(\.\d+)?$/.test(String(versao)) || /^\d+\.\d+\.\d+$/.test(String(versao)),
        `${rotulo}: node-version deve ser patch exato X.Y.Z`
      )
    }
  }
}

ok(totalSetupNode >= 7, `esperado ao menos 7 passos setup-node nos workflows, encontrado ${totalSetupNode}`)
ok(totalPassos > 0, "nenhum step encontrado nos workflows")

const pkg = JSON.parse(readFileSync(path.join(RAIZ, "package.json"), "utf8"))
ok(pkg.packageManager === BUN_PIN, `packageManager deve continuar "${BUN_PIN}" (atual: "${pkg.packageManager}")`)

// Pins de Node em composite actions (.github/actions/**/action.yml).
// TICKET-HARNESS-89: o residual "24" flutuante do setup-bun foi pinado em
// 24.22.1 e este bloco deixou de ser apenas relatório: agora BLOQUEIA, para
// impedir a reintrodução de versão flutuante fora das workflows.
const blocosAcao = []
const acoes = readdirSync(DIR_ACOES, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => path.join(DIR_ACOES, e.name, "action.yml"))
for (const caminho of acoes) {
  let conteudo
  try {
    conteudo = readFileSync(caminho, "utf8")
  } catch {
    continue
  }
  for (const linha of conteudo.split("\n")) {
    const m = /^\s*node-version:\s*["']?([^"'#\s]+)/.exec(linha)
    if (!m) continue
    blocosAcao.push(path.relative(RAIZ, caminho))
    const rotulo = `${path.relative(RAIZ, caminho)}`
    ok(
      PERMITIDOS.has(m[1]),
      `${rotulo}: node-version "${m[1]}" fora da allowlist endurecida (${[...PERMITIDOS].join(", ")})`
    )
    ok(!VULNERAVEIS.has(m[1]), `${rotulo}: node-version vulnerável "${m[1]}"`)
    ok(
      /^\d+\.\d+\.\d+$/.test(m[1]),
      `${rotulo}: node-version "${m[1]}" deve ser patch exato X.Y.Z (sem pin flutuante)`
    )
  }
}

if (falhas.length > 0) {
  console.error(`FALHOU — ${falhas.length} violação(ões):`)
  for (const f of falhas) console.error(`  ✗ ${f}`)
  process.exit(1)
}

console.log(
  `OK — ${arquivos.length} workflows parseados; ${totalSetupNode} passos setup-node, todos em {${[...PERMITIDOS].join(", ")}}; ${blocosAcao.length} pin(s) de composite action também exatos; ${totalPassos} steps estruturais válidos; packageManager ${BUN_PIN} intocado.`
)
