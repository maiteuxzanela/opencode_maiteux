#!/usr/bin/env bash
# scripts/sync-plugins.sh
# Sincronização e bump automatizado de plugins bundled:
# - @maiteuxzanela/ensemble-room-lowcost
# - opencode-plugin-dreams (chamber_dream)
#
# Governança:
# - Anti-early-commit: mantem mudancas unstaged para inspecao de Quality Gate
# - Protecao de memoria: proibido typecheck global ou tsgo

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CORE_PKG_JSON="$ROOT_DIR/packages/core/package.json"

ENSEMBLE_REPO="https://github.com/maiteuxzanela/ensemble-room-lowcost.git"
DREAMS_REPO="https://github.com/maiteuxzanela/chamber_dream.git"

ENSEMBLE_PKG_NAME="@maiteuxzanela/ensemble-room-lowcost"
DREAMS_PKG_NAME="opencode-plugin-dreams"

DRY_RUN=false
CHECK_MODE=false
ENSEMBLE_REF=""
DREAMS_REF=""

print_usage() {
  cat <<EOF
Uso: $0 [opções]

Opções:
  --dry-run          Inspeciona refs remotas e exibe o que seria atualizado sem modificar arquivos
  --check            Modo auditoria/CI: verifica se package.json está alinhado com upstream (exit 0 ok, exit 1 drift)
  --ensemble <ref>   Define ref/tag/commit manual para @maiteuxzanela/ensemble-room-lowcost
  --dreams <ref>     Define ref/tag/commit manual para opencode-plugin-dreams (chamber_dream)
  -h, --help         Exibe esta mensagem de ajuda
EOF
}

# Parse argumentos
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --check)
      CHECK_MODE=true
      shift
      ;;
    --ensemble)
      ENSEMBLE_REF="$2"
      shift 2
      ;;
    --dreams)
      DREAMS_REF="$2"
      shift 2
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      echo "Erro: Opção desconhecida '$1'" >&2
      print_usage
      exit 1
      ;;
  esac
done

if [[ ! -f "$CORE_PKG_JSON" ]]; then
  echo "Erro: $CORE_PKG_JSON não encontrado." >&2
  exit 1
fi

echo "=== Sincronização de Plugins Bundled OpenCode Core ==="
echo "Raiz do repositório: $ROOT_DIR"

# Lê as dependências atuais
CURRENT_ENSEMBLE=$(node -e "const p = require('$CORE_PKG_JSON'); console.log(p.dependencies['$ENSEMBLE_PKG_NAME'] || '');")
CURRENT_DREAMS=$(node -e "const p = require('$CORE_PKG_JSON'); console.log(p.dependencies['$DREAMS_PKG_NAME'] || '');")

echo "Versão atual $ENSEMBLE_PKG_NAME: ${CURRENT_ENSEMBLE:-não instalada}"
echo "Versão atual $DREAMS_PKG_NAME: ${CURRENT_DREAMS:-não instalada}"

fetch_latest_ref() {
  local repo_url="$1"
  local ref=""
  ref=$(git ls-remote "$repo_url" HEAD 2>/dev/null | awk '{print $1}')
  if [[ -z "$ref" ]]; then
    ref=$(git ls-remote "$repo_url" refs/heads/main 2>/dev/null | awk '{print $1}')
  fi
  if [[ -z "$ref" ]]; then
    ref=$(git ls-remote "$repo_url" refs/heads/master 2>/dev/null | awk '{print $1}')
  fi
  echo "$ref"
}

# Resolução de referências
if [[ -n "$ENSEMBLE_REF" ]]; then
  TARGET_ENSEMBLE_SPEC="github:maiteuxzanela/ensemble-room-lowcost#$ENSEMBLE_REF"
  TARGET_ENSEMBLE_DISPLAY="$ENSEMBLE_REF"
else
  echo "Consultando upstream remoto para ensemble-room-lowcost..."
  LATEST_ENSEMBLE=$(fetch_latest_ref "$ENSEMBLE_REPO")
  if [[ -z "$LATEST_ENSEMBLE" ]]; then
    echo "Aviso: Não foi possível obter ref remota para ensemble. Mantendo spec atual." >&2
    TARGET_ENSEMBLE_SPEC="${CURRENT_ENSEMBLE:-github:maiteuxzanela/ensemble-room-lowcost}"
    TARGET_ENSEMBLE_DISPLAY="$TARGET_ENSEMBLE_SPEC"
  else
    SHORT_ENSEMBLE="${LATEST_ENSEMBLE:0:7}"
    TARGET_ENSEMBLE_SPEC="github:maiteuxzanela/ensemble-room-lowcost#$SHORT_ENSEMBLE"
    TARGET_ENSEMBLE_DISPLAY="$LATEST_ENSEMBLE ($SHORT_ENSEMBLE)"
  fi
fi

if [[ -n "$DREAMS_REF" ]]; then
  TARGET_DREAMS_SPEC="github:maiteuxzanela/chamber_dream#$DREAMS_REF"
  TARGET_DREAMS_DISPLAY="$DREAMS_REF"
else
  echo "Consultando upstream remoto para opencode-plugin-dreams..."
  LATEST_DREAMS=$(fetch_latest_ref "$DREAMS_REPO")
  if [[ -z "$LATEST_DREAMS" ]]; then
    echo "Aviso: Não foi possível obter ref remota para dreams. Mantendo spec atual." >&2
    TARGET_DREAMS_SPEC="${CURRENT_DREAMS:-github:maiteuxzanela/chamber_dream}"
    TARGET_DREAMS_DISPLAY="$TARGET_DREAMS_SPEC"
  else
    SHORT_DREAMS="${LATEST_DREAMS:0:7}"
    TARGET_DREAMS_SPEC="github:maiteuxzanela/chamber_dream#$SHORT_DREAMS"
    TARGET_DREAMS_DISPLAY="$LATEST_DREAMS ($SHORT_DREAMS)"
  fi
fi

echo ""
echo "Alvos calculados:"
echo "  $ENSEMBLE_PKG_NAME -> $TARGET_ENSEMBLE_SPEC ($TARGET_ENSEMBLE_DISPLAY)"
echo "  $DREAMS_PKG_NAME -> $TARGET_DREAMS_SPEC ($TARGET_DREAMS_DISPLAY)"

# Modo --check (Auditoria / CI)
if [[ "$CHECK_MODE" = true ]]; then
  echo ""
  echo "--- Executando em modo --check ---"
  DRIFT=false

  # Normaliza specs para comparacao
  if [[ "$CURRENT_ENSEMBLE" != "$TARGET_ENSEMBLE_SPEC" && "$CURRENT_ENSEMBLE" != "github:maiteuxzanela/ensemble-room-lowcost" ]]; then
    echo "DRIFT DETECTADO em $ENSEMBLE_PKG_NAME:"
    echo "  Atual: $CURRENT_ENSEMBLE"
    echo "  Esperado: $TARGET_ENSEMBLE_SPEC"
    DRIFT=true
  fi

  if [[ "$CURRENT_DREAMS" != "$TARGET_DREAMS_SPEC" && "$CURRENT_DREAMS" != "github:maiteuxzanela/chamber_dream" ]]; then
    echo "DRIFT DETECTADO em $DREAMS_PKG_NAME:"
    echo "  Atual: $CURRENT_DREAMS"
    echo "  Esperado: $TARGET_DREAMS_SPEC"
    DRIFT=true
  fi

  if [[ "$DRIFT" = true ]]; then
    echo "Status: FALHA DE AUDITORIA (drift com upstream)." >&2
    exit 1
  else
    echo "Status: SUCESSO (plugins sincronizados e alinhados)."
    exit 0
  fi
fi

# Modo --dry-run
if [[ "$DRY_RUN" = true ]]; then
  echo ""
  echo "--- Executando em modo --dry-run (nenhuma alteração feita) ---"
  echo "Ações que seriam executadas:"
  echo "  1. Atualizar $CORE_PKG_JSON:"
  echo "     - $ENSEMBLE_PKG_NAME: '$CURRENT_ENSEMBLE' -> '$TARGET_ENSEMBLE_SPEC'"
  echo "     - $DREAMS_PKG_NAME: '$CURRENT_DREAMS' -> '$TARGET_DREAMS_SPEC'"
  echo "  2. Executar 'bun install --ignore-scripts' a partir de $ROOT_DIR"
  echo "  3. Executar 'bun test --cwd packages/core test/builtin-zero-config.test.ts test/builtin-cold-start-offline.test.ts'"
  echo "  4. Manter alterações unstaged (anti-early-commit)"
  exit 0
fi

# Execução real da sincronização
echo ""
echo "--- Aplicando atualizações no packages/core/package.json ---"
node -e "
const fs = require('fs');
const path = '$CORE_PKG_JSON';
const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
pkg.dependencies = pkg.dependencies || {};
pkg.dependencies['$ENSEMBLE_PKG_NAME'] = '$TARGET_ENSEMBLE_SPEC';
pkg.dependencies['$DREAMS_PKG_NAME'] = '$TARGET_DREAMS_SPEC';
fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
"
echo "package.json atualizado com sucesso."

echo ""
echo "--- Atualizando bun.lock (bun install --ignore-scripts) ---"
(cd "$ROOT_DIR" && bun install --ignore-scripts)

echo ""
echo "--- Executando validação fail-fast de integridade (anti-mock) ---"
(cd "$ROOT_DIR" && bun test --cwd packages/core test/builtin-zero-config.test.ts test/builtin-cold-start-offline.test.ts)

echo ""
echo "=== Sincronização concluída com sucesso! ==="
echo "Nota de Governança: Mudanças mantidas unstaged para inspeção do Quality Gate e auditoria da Diana."
