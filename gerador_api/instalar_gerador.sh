#!/bin/bash
# ================================================================
#  Gerador de Contas FF - Instalador VPS Automatizado
#  Uso: sudo bash instalar_gerador.sh
# ================================================================

set -e

GREEN='\033[0;92m'
RED='\033[0;31m'
YELLOW='\033[0;93m'
CYAN='\033[38;5;87m'
BOLD='\033[1m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}[OK]${NC} $1"; }
info() { echo -e "  ${YELLOW}[INFO]${NC} $1"; }
erro() { echo -e "  ${RED}[ERRO]${NC} $1"; exit 1; }

echo ""
echo -e "  ${CYAN}${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "  ${CYAN}${BOLD}║       Gerador de Contas FF - Instalador VPS              ║${NC}"
echo -e "  ${CYAN}${BOLD}║                    v1.1.0 (Otimizado)                    ║${NC}"
echo -e "  ${CYAN}${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""

# ── Verificar root ──────────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
    erro "Por favor, execute este instalador como root: sudo bash instalar_gerador.sh"
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_DIR="/root/gerador_api"

# ── 1. Instalar/Verificar Node.js ────────────────────────────────
info "Verificando Node.js..."
if command -v node &>/dev/null && node -e "process.exit(parseInt(process.version.slice(1)) >= 18 ? 0 : 1)" 2>/dev/null; then
    ok "Node.js já instalado: $(node --version)"
else
    info "Instalando Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
    apt-get install -y -qq nodejs > /dev/null 2>&1
    ok "Node.js instalado com sucesso: $(node --version)"
fi

# ── 2. Copiar arquivos para o diretório final ──────────────────
info "Configurando diretório do gerador em $TARGET_DIR..."
mkdir -p "$TARGET_DIR"

if [ "$SCRIPT_DIR" != "$TARGET_DIR" ]; then
    if [ -f "$SCRIPT_DIR/server.js" ]; then
        cp "$SCRIPT_DIR/server.js" "$TARGET_DIR/"
        cp "$SCRIPT_DIR/package.json" "$TARGET_DIR/"
    else
        erro "Arquivos do gerador (server.js/package.json) não foram encontrados em: $SCRIPT_DIR"
    fi
else
    info "Você já está executando o script dentro da pasta de destino ($TARGET_DIR). Pulando cópia."
fi
ok "Arquivos configurados com sucesso"

# ── 3. Instalar Dependências do Node.js ─────────────────────────
info "Instalando dependências Node.js no gerador..."
cd "$TARGET_DIR"
npm install --production > /dev/null 2>&1 || npm install --production
ok "Dependências instaladas com sucesso"

# ── 4. Criar e Configurar o Serviço Systemd ─────────────────────
info "Criando serviço systemd (gerador-ff.service)..."

cat > /etc/systemd/system/gerador-ff.service << EOF
[Unit]
Description=Gerador de Contas FF - API
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$TARGET_DIR
ExecStart=/usr/bin/node $TARGET_DIR/server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
Environment=PORT=3000
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable gerador-ff > /dev/null 2>&1
systemctl restart gerador-ff
sleep 2

# Verificar se o serviço está de fato ativo
STATUS=$(systemctl is-active gerador-ff 2>/dev/null || echo "inactive")
if [ "$STATUS" = "active" ]; then
    ok "Serviço systemd gerador-ff ativo e rodando"
else
    erro "O serviço gerador-ff falhou ao iniciar. Verifique com: journalctl -u gerador-ff -n 20"
fi

# ── 5. Liberar porta no Firewall ───────────────────────────────
info "Liberando porta 3000 no firewall..."
if command -v ufw &>/dev/null; then
    ufw allow 3000/tcp > /dev/null 2>&1 || true
    ok "Porta 3000 liberada no UFW"
fi

# ── 6. Integrar com o Bot de Salas ──────────────────────────────
info "Buscando configuração do Bot de Salas..."
CONFIG_ACHADA=false
BOT_PATHS=(
    "/root/salasff"
    "/root/salasjspost"
    "$SCRIPT_DIR/../salasff"
    "/root/FF_SALAS_BOT/salasff"
)

for path in "${BOT_PATHS[@]}"; do
    if [ -f "$path/config.json" ]; then
        CONFIG_FILE="$path/config.json"
        info "Configuração do bot encontrada em: $CONFIG_FILE"
        
        # Fazer backup da configuração
        cp "$CONFIG_FILE" "${CONFIG_FILE}.bak"
        
        # Atualizar a URL da API geradora para localhost porta 3000
        if grep -q "gerador_api_url" "$CONFIG_FILE"; then
            sed -i 's|"gerador_api_url": *"[^"]*"|"gerador_api_url": "http://127.0.0.1:3000"|g' "$CONFIG_FILE"
        else
            # Inserir após a abertura do JSON caso não exista
            sed -i 's|{|{\n  "gerador_api_url": "http://127.0.0.1:3000",|' "$CONFIG_FILE"
        fi
        
        ok "config.json atualizado!"
        CONFIG_ACHADA=true
        
        # Reiniciar o bot de salas para carregar a nova configuração
        info "Reiniciando serviços do bot de salas..."
        systemctl restart salaff 2>/dev/null || true
        systemctl restart salaff-go 2>/dev/null || true
        ok "Serviços salaff e salaff-go reiniciados"
        break
    fi
done

if [ "$CONFIG_ACHADA" = false ]; then
    info "Não foi possível encontrar a pasta 'salasff' automaticamente para configurar a URL do gerador."
    info "Por favor, verifique manualmente o arquivo 'config.json' do seu bot e ajuste para:"
    echo -e "    ${CYAN}\"gerador_api_url\": \"http://127.0.0.1:3000\"${NC}"
fi

# ── 7. Resumo e Testes ──────────────────────────────────────────
HEALTH=$(curl -s http://127.0.0.1:3000/health || echo "ERROR")

echo ""
echo -e "  ${CYAN}${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "  ${CYAN}${BOLD}║           INSTALAÇÃO DO GERADOR CONCLUÍDA!               ║${NC}"
echo -e "  ${CYAN}${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Status do Serviço:  ${GREEN}● RODANDO${NC} (porta 3000)"

if [ "$HEALTH" = "ERROR" ]; then
    echo -e "  Teste Local (/health):  ${RED}FALHA (Sem resposta da API)${NC}"
else
    echo -e "  Teste Local (/health):  ${GREEN}SUCESSO ($HEALTH)${NC}"
fi

echo ""
echo -e "  ${BOLD}Comandos úteis:${NC}"
echo "    Ver logs do gerador:   journalctl -u gerador-ff -f"
echo "    Reiniciar o gerador:   systemctl restart gerador-ff"
echo "    Parar o gerador:       systemctl stop gerador-ff"
echo ""

