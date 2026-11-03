#!/bin/bash
# ================================================================
#  SALAS FF - Instalador VPS Completo
#  Ubuntu 20.04 / 22.04 / 24.04
#  Uso: sudo bash instalar_vps.sh
# ================================================================

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

RED='\033[0;31m'
GREEN='\033[0;92m'
YELLOW='\033[0;93m'
CYAN='\033[38;5;87m'
BOLD='\033[1m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}[OK]${NC} $1"; }
info() { echo -e "  ${YELLOW}[INFO]${NC} $1"; }
erro() { echo -e "  ${RED}[ERRO]${NC} $1"; exit 1; }

echo ""
echo -e "  ${CYAN}${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "  ${CYAN}${BOLD}║        SALAS FF - Instalador VPS (Ubuntu)               ║${NC}"
echo -e "  ${CYAN}${BOLD}║                    v2.3.0                               ║${NC}"
echo -e "  ${CYAN}${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""

# ── Verificar root ──────────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
    erro "Execute como root: sudo bash instalar_vps.sh"
fi

# ── 1. Atualizar sistema ────────────────────────────────────────
info "Atualizando sistema..."
apt-get update -qq
apt-get install -y -qq curl wget unzip git build-essential software-properties-common > /dev/null 2>&1
ok "Sistema atualizado"

# ── 2. Instalar Node.js 20 ──────────────────────────────────────
info "Verificando Node.js..."
if command -v node &>/dev/null && node -e "process.exit(parseInt(process.version.slice(1)) >= 18 ? 0 : 1)" 2>/dev/null; then
    ok "Node.js já instalado: $(node --version)"
else
    info "Instalando Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
    apt-get install -y -qq nodejs > /dev/null 2>&1
    ok "Node.js instalado: $(node --version)"
fi

# ── 3. Instalar Go 1.22 ─────────────────────────────────────────
info "Verificando Go..."
if command -v go &>/dev/null && go version | grep -q "go1.2[2-9]"; then
    ok "Go já instalado: $(go version)"
else
    info "Instalando Go 1.22..."
    # Usa o go1.22.1 que já vem no zip do projeto
    if [ -f "$SCRIPT_DIR/go1.22.1.linux-amd64.tar.gz" ]; then
        info "Usando Go do pacote local..."
        rm -rf /usr/local/go
        tar -C /usr/local -xzf "$SCRIPT_DIR/go1.22.1.linux-amd64.tar.gz"
    else
        info "Baixando Go 1.22.1..."
        wget -q https://go.dev/dl/go1.22.1.linux-amd64.tar.gz -O /tmp/go.tar.gz
        rm -rf /usr/local/go
        tar -C /usr/local -xzf /tmp/go.tar.gz
        rm /tmp/go.tar.gz
    fi
    # Adicionar ao PATH permanentemente
    echo 'export PATH=$PATH:/usr/local/go/bin' >> /etc/profile
    echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc
    export PATH=$PATH:/usr/local/go/bin
    ok "Go instalado: $(go version)"
fi
export PATH=$PATH:/usr/local/go/bin

# ── 4. Instalar Redis ───────────────────────────────────────────
info "Verificando Redis..."
if command -v redis-server &>/dev/null; then
    ok "Redis já instalado"
else
    apt-get install -y -qq redis-server > /dev/null 2>&1
    ok "Redis instalado"
fi
systemctl enable redis-server > /dev/null 2>&1
systemctl start redis-server 2>/dev/null || service redis-server start 2>/dev/null || true
sleep 1
if redis-cli ping 2>/dev/null | grep -q PONG; then
    ok "Redis rodando (PONG)"
else
    info "Redis pode precisar de ajuste manual — verifique depois"
fi

# Otimizar Redis
REDIS_CONF="/etc/redis/redis.conf"
if [ -f "$REDIS_CONF" ] && ! grep -q "# SalasFF" "$REDIS_CONF"; then
    cat >> "$REDIS_CONF" << 'EOF'

# SalasFF Redis Config
maxmemory 128mb
maxmemory-policy allkeys-lru
save ""
appendonly no
EOF
    systemctl restart redis-server 2>/dev/null || true
    ok "Redis otimizado (128MB, sem disco)"
fi

# ── 5. Instalar PostgreSQL ──────────────────────────────────────
info "Verificando PostgreSQL..."
if command -v psql &>/dev/null; then
    ok "PostgreSQL já instalado: $(psql --version)"
else
    apt-get install -y -qq postgresql postgresql-contrib > /dev/null 2>&1
    ok "PostgreSQL instalado: $(psql --version)"
fi
systemctl enable postgresql > /dev/null 2>&1
systemctl start postgresql 2>/dev/null || service postgresql start 2>/dev/null || true
sleep 2
pg_isready -q 2>/dev/null || erro "PostgreSQL não iniciou. Verifique: systemctl status postgresql"
ok "PostgreSQL rodando"

# ── 6. Configurar banco de dados ────────────────────────────────
info "Configurando banco de dados..."

PG_USER="${PG_USER:-salasbeta}"
PG_PASS="${PG_PASS:-}"
PG_DB="${PG_DB:-salasbeta}"

if [ -z "$PG_PASS" ]; then
    erro "Defina a variavel PG_PASS antes de rodar o instalador: export PG_PASS='sua_senha'"
fi

sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='$PG_USER'" | grep -q 1 || \
    sudo -u postgres psql -c "CREATE USER $PG_USER WITH PASSWORD '$PG_PASS';" 2>/dev/null
sudo -u postgres psql -c "ALTER USER $PG_USER WITH PASSWORD '$PG_PASS';" 2>/dev/null
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='$PG_DB'" | grep -q 1 || \
    sudo -u postgres psql -c "CREATE DATABASE $PG_DB OWNER $PG_USER;" 2>/dev/null
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE $PG_DB TO $PG_USER;" 2>/dev/null
sudo -u postgres psql -d "$PG_DB" -c "GRANT ALL ON SCHEMA public TO $PG_USER;" 2>/dev/null

# Permitir acesso local
PG_HBA=$(sudo -u postgres psql -t -c "SHOW hba_file;" 2>/dev/null | tr -d ' ')
if [ -n "$PG_HBA" ] && [ -f "$PG_HBA" ] && ! grep -q "$PG_USER" "$PG_HBA" 2>/dev/null; then
    echo "host    $PG_DB    $PG_USER    127.0.0.1/32    md5" >> "$PG_HBA"
    echo "host    $PG_DB    $PG_USER    ::1/128         md5" >> "$PG_HBA"
    sudo -u postgres psql -c "SELECT pg_reload_conf();" > /dev/null 2>&1
fi
ok "Banco: $PG_DB | Usuario: $PG_USER | Senha: $PG_PASS"

# ── 7. Importar dump SQL ────────────────────────────────────────
DUMP_FILE="$SCRIPT_DIR/pg_dump.sql"
if [ -f "$DUMP_FILE" ]; then
    info "Importando dados (pg_dump.sql)..."
    sudo -u postgres psql -c "DROP DATABASE IF EXISTS $PG_DB;" 2>/dev/null
    sudo -u postgres psql -c "CREATE DATABASE $PG_DB OWNER $PG_USER;" 2>/dev/null
    sudo -u postgres psql -d "$PG_DB" -c "GRANT ALL ON SCHEMA public TO $PG_USER;" 2>/dev/null
    sudo -u postgres psql -d "$PG_DB" -f "$DUMP_FILE" > /dev/null 2>&1
    # Transferir ownership
    sudo -u postgres psql -d "$PG_DB" -c "
        DO \$\$ DECLARE r RECORD; BEGIN
            FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
                EXECUTE 'ALTER TABLE public.' || r.tablename || ' OWNER TO $PG_USER';
            END LOOP;
        END \$\$;" 2>/dev/null
    sudo -u postgres psql -d "$PG_DB" -c "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO $PG_USER;" 2>/dev/null
    sudo -u postgres psql -d "$PG_DB" -c "GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO $PG_USER;" 2>/dev/null
    ok "Dump importado com sucesso"
else
    info "pg_dump.sql nao encontrado — tabelas serao criadas automaticamente ao iniciar"
fi

# ── 8. Compilar binario Go ──────────────────────────────────────
info "Verificando servidor Go..."
cd "$SCRIPT_DIR"
if [ -f "salas_ff_server" ]; then
    ok "Binario pre-compilado salas_ff_server encontrado, ignorando compilacao"
    chmod +x salas_ff_server
else
    info "Compilando servidor Go..."
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
        -ldflags="-s -w -X main.version=2.3.0" \
        -trimpath \
        -o salas_ff_server ./cmd/server/ 2>&1 || erro "Falha ao compilar Go. Verifique acima."
    chmod +x salas_ff_server
    ok "Binario compilado: salas_ff_server ($(du -sh salas_ff_server | cut -f1))"
fi

# ── 9. Instalar dependencias Node ──────────────────────────────
info "Instalando dependencias Node.js..."
cd "$SCRIPT_DIR"
npm install --production > /dev/null 2>&1
ok "Dependencias Node instaladas"

# ── 10. Criar servico systemd ──────────────────────────────────
info "Criando servico systemd (salaff)..."

cat > /etc/systemd/system/salaff.service << EOF
[Unit]
Description=Salas FF - Auto Start System
After=network.target postgresql.service redis-server.service
Requires=postgresql.service redis-server.service

[Service]
Type=simple
User=root
WorkingDirectory=$SCRIPT_DIR
ExecStart=/usr/bin/node $SCRIPT_DIR/tcpbot.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
Environment=NODE_ENV=production
Environment=PG_USER=$PG_USER
Environment=PG_PASS=$PG_PASS
Environment=PG_DB=$PG_DB
Environment=PG_HOST=127.0.0.1
Environment=REDIS_HOST=127.0.0.1

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/salaff-go.service << EOF
[Unit]
Description=Salas FF - Go HTTP Server
After=network.target postgresql.service redis-server.service salaff.service
Requires=postgresql.service redis-server.service

[Service]
Type=simple
User=root
WorkingDirectory=$SCRIPT_DIR
ExecStart=$SCRIPT_DIR/salas_ff_server
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
Environment=PORT=25565
Environment=BRIDGE_PORT=25566
Environment=PG_USER=$PG_USER
Environment=PG_PASS=$PG_PASS
Environment=PG_DB=$PG_DB
Environment=PG_HOST=127.0.0.1
Environment=REDIS_HOST=127.0.0.1

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable salaff salaff-go > /dev/null 2>&1
ok "Servicos criados: salaff (Node) + salaff-go (Go)"

# ── 11. Abrir portas ───────────────────────────────────────────
info "Abrindo porta 25565 no firewall..."
if command -v ufw &>/dev/null; then
    ufw allow 25565/tcp > /dev/null 2>&1 || true
    ok "Porta 25565 liberada (ufw)"
fi

# ── 12. Iniciar servicos ───────────────────────────────────────
info "Iniciando servicos..."
systemctl start salaff
sleep 3
systemctl start salaff-go
sleep 3

echo ""
echo -e "  ${CYAN}${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "  ${CYAN}${BOLD}║              INSTALACAO CONCLUIDA!                      ║${NC}"
echo -e "  ${CYAN}${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""

# Status final
GO_STATUS=$(systemctl is-active salaff-go 2>/dev/null || echo "inativo")
NODE_STATUS=$(systemctl is-active salaff 2>/dev/null || echo "inativo")
REDIS_STATUS=$(redis-cli ping 2>/dev/null || echo "ERRO")
PG_STATUS=$(pg_isready -q 2>/dev/null && echo "OK" || echo "ERRO")
IP_VPS=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')

echo -e "  ${BOLD}Status dos servicos:${NC}"
[ "$GO_STATUS" = "active" ]   && echo -e "    Go Server   ${GREEN}● RODANDO${NC}  (porta 25565)" || echo -e "    Go Server   ${RED}● PARADO${NC}"
[ "$NODE_STATUS" = "active" ] && echo -e "    Node Bridge  ${GREEN}● RODANDO${NC}  (porta 25566)" || echo -e "    Node Bridge  ${RED}● PARADO${NC}"
[ "$REDIS_STATUS" = "PONG" ]  && echo -e "    Redis        ${GREEN}● RODANDO${NC}" || echo -e "    Redis        ${RED}● PARADO${NC}"
[ "$PG_STATUS" = "OK" ]       && echo -e "    PostgreSQL   ${GREEN}● RODANDO${NC}" || echo -e "    PostgreSQL   ${RED}● PARADO${NC}"
echo ""
echo -e "  ${BOLD}Endereco da API:${NC}  http://${IP_VPS}:25565"
echo -e "  ${BOLD}Health check:${NC}     http://${IP_VPS}:25565/health"
echo -e "  ${BOLD}Ping:${NC}             http://${IP_VPS}:25565/ping"
echo ""
echo -e "  ${BOLD}Comandos uteis:${NC}"
echo "    Ver logs Go:    journalctl -u salaff-go -f"
echo "    Ver logs Node:  journalctl -u salaff -f"
echo "    Reiniciar:      systemctl restart salaff salaff-go"
echo "    Parar tudo:     systemctl stop salaff salaff-go"
echo ""
