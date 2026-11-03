#!/bin/bash
# ============================================================
#  Salas FF - Setup Completo PostgreSQL + Importação de Dados
#  Uso: chmod +x setup_postgres.sh && sudo ./setup_postgres.sh
#  Após rodar, basta: npm install && npm run start-all
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PG_USER="${PG_USER:-salasbeta}"
PG_PASS="${PG_PASS:-}"
PG_DB="${PG_DB:-salasbeta}"
DUMP_FILE="$SCRIPT_DIR/pg_dump.sql"

if [ -z "$PG_PASS" ]; then
    echo "  [ERRO] Senha do PostgreSQL (PG_PASS) nao definida."
    echo "  Defina via: export PG_PASS='sua_senha'"
    exit 1
fi

echo ""
echo "  ╔══════════════════════════════════════════════════════════╗"
echo "  ║   Salas FF - Setup PostgreSQL + Redis + Dados (v2.3.0)   ║"
echo "  ╚══════════════════════════════════════════════════════════╝"
echo ""

# ─── 0. Instalar Redis ───────────────────────────────────────
echo "  [0/7] Verificando Redis..."
if command -v redis-server &> /dev/null; then
    echo "  [OK] Redis já instalado: $(redis-server --version | head -1)"
else
    echo "  [INFO] Instalando Redis..."
    apt-get update -qq
    apt-get install -y -qq redis-server > /dev/null 2>&1
    echo "  [OK] Redis instalado: $(redis-server --version | head -1)"
fi

# Iniciar e habilitar Redis
systemctl start redis-server 2>/dev/null || service redis-server start 2>/dev/null || true
systemctl enable redis-server 2>/dev/null || true
sleep 1

if redis-cli ping 2>/dev/null | grep -q PONG; then
    echo "  [OK] Redis rodando (PONG)"
else
    echo "  [AVISO] Redis pode não estar rodando, verifique manualmente"
fi

# Otimizar Redis para performance
REDIS_CONF="/etc/redis/redis.conf"
if [ -f "$REDIS_CONF" ]; then
    if ! grep -q "# Salas FF Redis Config" "$REDIS_CONF" 2>/dev/null; then
        cp "$REDIS_CONF" "${REDIS_CONF}.bak" 2>/dev/null || true
        cat >> "$REDIS_CONF" << 'REDISEOF'

# Salas FF Redis Config
maxmemory 128mb
maxmemory-policy allkeys-lru
save ""
appendonly no
REDISEOF
        systemctl restart redis-server 2>/dev/null || service redis-server restart 2>/dev/null || true
        sleep 1
        echo "  [OK] Redis otimizado (128MB, sem persistencia em disco)"
    else
        echo "  [OK] Redis já otimizado"
    fi
fi

# ─── 1. Instalar PostgreSQL ───────────────────────────────────
echo "  [1/7] Verificando PostgreSQL..."
if command -v psql &> /dev/null; then
    echo "  [OK] PostgreSQL já instalado: $(psql --version)"
else
    echo "  [INFO] Instalando PostgreSQL..."
    apt-get update -qq
    apt-get install -y -qq postgresql postgresql-contrib > /dev/null 2>&1
    echo "  [OK] PostgreSQL instalado: $(psql --version)"
fi

# ─── 2. Iniciar PostgreSQL ────────────────────────────────────
echo "  [2/7] Iniciando PostgreSQL..."
systemctl start postgresql 2>/dev/null || service postgresql start 2>/dev/null || true
systemctl enable postgresql 2>/dev/null || true
sleep 2

if ! pg_isready -q 2>/dev/null; then
    echo "  [ERRO] PostgreSQL não está rodando!"
    exit 1
fi
echo "  [OK] PostgreSQL rodando"

# ─── 3. Criar usuário e banco ─────────────────────────────────
echo "  [3/7] Criando usuario e banco de dados..."

sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='$PG_USER'" | grep -q 1 || \
    sudo -u postgres psql -c "CREATE USER $PG_USER WITH PASSWORD '$PG_PASS';" 2>/dev/null

sudo -u postgres psql -c "ALTER USER $PG_USER WITH PASSWORD '$PG_PASS';" 2>/dev/null

sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='$PG_DB'" | grep -q 1 || \
    sudo -u postgres psql -c "CREATE DATABASE $PG_DB OWNER $PG_USER;" 2>/dev/null

sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE $PG_DB TO $PG_USER;" 2>/dev/null
sudo -u postgres psql -d "$PG_DB" -c "GRANT ALL ON SCHEMA public TO $PG_USER;" 2>/dev/null

echo "  [OK] Usuario: $PG_USER | Banco: $PG_DB"

# ─── 4. Configurar acesso local ───────────────────────────────
echo "  [4/7] Configurando acesso local..."

PG_HBA=$(sudo -u postgres psql -t -c "SHOW hba_file;" 2>/dev/null | tr -d ' ')

if [ -n "$PG_HBA" ] && [ -f "$PG_HBA" ]; then
    if ! grep -q "$PG_USER" "$PG_HBA" 2>/dev/null; then
        echo "# Salas FF - acesso local" >> "$PG_HBA"
        echo "host    $PG_DB    $PG_USER    127.0.0.1/32    md5" >> "$PG_HBA"
        echo "host    $PG_DB    $PG_USER    ::1/128         md5" >> "$PG_HBA"
        sudo -u postgres psql -c "SELECT pg_reload_conf();" > /dev/null 2>&1
        echo "  [OK] Regras de acesso adicionadas"
    else
        echo "  [OK] Regras de acesso já configuradas"
    fi
else
    echo "  [AVISO] pg_hba.conf não encontrado, pulando"
fi

# ─── 5. Otimizar para alto volume ─────────────────────────────
echo "  [5/7] Otimizando configuracao para alto volume..."

PG_CONF=$(sudo -u postgres psql -t -c "SHOW config_file;" 2>/dev/null | tr -d ' ')

if [ -n "$PG_CONF" ] && [ -f "$PG_CONF" ]; then
    if ! grep -q "# Salas FF Optimizations" "$PG_CONF" 2>/dev/null; then
        cp "$PG_CONF" "${PG_CONF}.bak" 2>/dev/null || true
        cat >> "$PG_CONF" << 'EOF'

# Salas FF Optimizations
shared_buffers = 256MB
effective_cache_size = 512MB
work_mem = 4MB
maintenance_work_mem = 64MB
max_connections = 100
checkpoint_completion_target = 0.9
wal_buffers = 16MB
random_page_cost = 1.1
effective_io_concurrency = 200
EOF
        systemctl restart postgresql 2>/dev/null || service postgresql restart 2>/dev/null
        sleep 2
        echo "  [OK] Configuracao otimizada e PostgreSQL reiniciado"
    else
        echo "  [OK] Otimizacoes já aplicadas"
    fi
else
    echo "  [AVISO] postgresql.conf não encontrado, pulando otimizacoes"
fi

# ─── 6. Importar dados ────────────────────────────────────────
echo "  [6/7] Importando dados do dump..."

if [ ! -f "$DUMP_FILE" ]; then
    echo "  [ERRO] Arquivo pg_dump.sql não encontrado em: $DUMP_FILE"
    echo "  [INFO] O sistema vai criar as tabelas vazias na primeira execução."
    echo ""
else
    # Drop e recria banco limpo para evitar conflitos
    sudo -u postgres psql -c "DROP DATABASE IF EXISTS $PG_DB;" 2>/dev/null
    sudo -u postgres psql -c "CREATE DATABASE $PG_DB OWNER $PG_USER;" 2>/dev/null
    sudo -u postgres psql -d "$PG_DB" -c "GRANT ALL ON SCHEMA public TO $PG_USER;" 2>/dev/null

    # Importar como usuario postgres e depois transferir ownership
    sudo -u postgres psql -d "$PG_DB" -f "$DUMP_FILE" > /dev/null 2>&1

    # Transferir ownership de todas as tabelas para o usuario configurado
    sudo -u postgres psql -d "$PG_DB" -c "DO \$\$ DECLARE r RECORD; BEGIN FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP EXECUTE 'ALTER TABLE public.' || r.tablename || ' OWNER TO $PG_USER'; END LOOP; END \$\$;" 2>/dev/null
    sudo -u postgres psql -d "$PG_DB" -c "DO \$\$ DECLARE r RECORD; BEGIN FOR r IN SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema='public' LOOP EXECUTE 'ALTER SEQUENCE public.' || r.sequence_name || ' OWNER TO $PG_USER'; END LOOP; END \$\$;" 2>/dev/null
    sudo -u postgres psql -d "$PG_DB" -c "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO $PG_USER;" 2>/dev/null
    sudo -u postgres psql -d "$PG_DB" -c "GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO $PG_USER;" 2>/dev/null
    sudo -u postgres psql -d "$PG_DB" -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO $PG_USER;" 2>/dev/null

    KEYS_COUNT=$(PGPASSWORD="$PG_PASS" psql -h 127.0.0.1 -U "$PG_USER" -d "$PG_DB" -t -c "SELECT COUNT(*) FROM keys_info;" 2>/dev/null | tr -d ' ')
    USERS_COUNT=$(PGPASSWORD="$PG_PASS" psql -h 127.0.0.1 -U "$PG_USER" -d "$PG_DB" -t -c "SELECT COUNT(*) FROM usuarios;" 2>/dev/null | tr -d ' ')
    ACCOUNTS_COUNT=$(PGPASSWORD="$PG_PASS" psql -h 127.0.0.1 -U "$PG_USER" -d "$PG_DB" -t -c "SELECT COUNT(*) FROM info_accounts;" 2>/dev/null | tr -d ' ')
    SALDOS_COUNT=$(PGPASSWORD="$PG_PASS" psql -h 127.0.0.1 -U "$PG_USER" -d "$PG_DB" -t -c "SELECT COUNT(*) FROM saldos;" 2>/dev/null | tr -d ' ')

    echo ""
    echo "  ╔══════════════════════════════════════════════════════════╗"
    echo "  ║                  SETUP COMPLETO!                        ║"
    echo "  ╚══════════════════════════════════════════════════════════╝"
    echo ""
    echo "  Dados importados com sucesso:"
    echo "    Keys:           $KEYS_COUNT"
    echo "    Usuarios:       $USERS_COUNT"
    echo "    Contas (bots):  $ACCOUNTS_COUNT"
    echo "    Saldos:         $SALDOS_COUNT"
    echo ""
fi

echo ""
echo "  [7/7] Instalando dependencias Node.js..."
if [ -f "$SCRIPT_DIR/package.json" ]; then
    cd "$SCRIPT_DIR" && npm install --production > /dev/null 2>&1
    echo "  [OK] Dependencias instaladas (incluindo ioredis)"
else
    echo "  [AVISO] package.json nao encontrado, rode npm install manualmente"
fi

echo ""
echo "  Conexão Redis:"
echo "    Host:     127.0.0.1"
echo "    Porta:    6379"
echo "    Uso:      Salas/partidas em tempo real"
echo ""
echo "  Conexão PostgreSQL:"
echo "    Host:     127.0.0.1"
echo "    Porta:    5432"
echo "    Usuario:  $PG_USER"
echo "    Senha:    $PG_PASS"
echo "    Banco:    $PG_DB"
echo ""
echo "  ╔══════════════════════════════════════════════════════════╗"
echo "  ║  Próximos passos:                                       ║"
echo "  ║    1. npm install                                       ║"
echo "  ║    2. chmod +x build.sh && ./build.sh                   ║"
echo "  ║    3. npm run start-all                                 ║"
echo "  ╚══════════════════════════════════════════════════════════╝"
echo ""
