#!/bin/bash
# ================================================================
#  SALAS FF - Script de Verificacao
#  Uso: bash verificar.sh
# ================================================================

GREEN='\033[0;92m'
RED='\033[0;31m'
YELLOW='\033[0;93m'
CYAN='\033[38;5;87m'
BOLD='\033[1m'
NC='\033[0m'

IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')

echo ""
echo -e "  ${CYAN}${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "  ${CYAN}${BOLD}║         SALAS FF - Verificacao do Sistema               ║${NC}"
echo -e "  ${CYAN}${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""

# ── Servicos ───────────────────────────────────────────────────
echo -e "  ${BOLD}[1] Servicos systemd:${NC}"

for svc in salaff salaff-go redis-server postgresql; do
    STATUS=$(systemctl is-active "$svc" 2>/dev/null || echo "nao instalado")
    if [ "$STATUS" = "active" ]; then
        echo -e "    ${GREEN}●${NC} $svc  ${GREEN}RODANDO${NC}"
    else
        echo -e "    ${RED}●${NC} $svc  ${RED}$STATUS${NC}"
    fi
done

# ── Portas ─────────────────────────────────────────────────────
echo ""
echo -e "  ${BOLD}[2] Portas abertas:${NC}"

for porta in 25565 25566 5432 6379; do
    if ss -tlnp 2>/dev/null | grep -q ":$porta " || netstat -tlnp 2>/dev/null | grep -q ":$porta "; then
        echo -e "    ${GREEN}●${NC} Porta $porta  ${GREEN}ABERTA${NC}"
    else
        echo -e "    ${RED}●${NC} Porta $porta  ${RED}FECHADA${NC}"
    fi
done

# ── Redis ──────────────────────────────────────────────────────
echo ""
echo -e "  ${BOLD}[3] Redis:${NC}"
REDIS=$(redis-cli ping 2>/dev/null)
if [ "$REDIS" = "PONG" ]; then
    echo -e "    ${GREEN}● Conectado (PONG)${NC}"
    KEYS=$(redis-cli dbsize 2>/dev/null)
    echo -e "    Keys no redis: $KEYS"
else
    echo -e "    ${RED}● Sem resposta${NC}"
fi

# ── PostgreSQL ─────────────────────────────────────────────────
echo ""
echo -e "  ${BOLD}[4] PostgreSQL:${NC}"
if pg_isready -q 2>/dev/null; then
    echo -e "    ${GREEN}● Rodando${NC}"
    TABLES=$(PGPASSWORD="${PG_PASS:-}" psql -h "${PG_HOST:-127.0.0.1}" -U "${PG_USER:-salasbeta}" -d "${PG_DB:-salasbeta}" -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null | tr -d ' ')
    KEYS_COUNT=$(PGPASSWORD="${PG_PASS:-}" psql -h "${PG_HOST:-127.0.0.1}" -U "${PG_USER:-salasbeta}" -d "${PG_DB:-salasbeta}" -t -c "SELECT COUNT(*) FROM keys_info;" 2>/dev/null | tr -d ' ')
    echo -e "    Tabelas: $TABLES | Keys cadastradas: $KEYS_COUNT"
else
    echo -e "    ${RED}● Nao responde${NC}"
fi

# ── HTTP endpoints ─────────────────────────────────────────────
echo ""
echo -e "  ${BOLD}[5] API HTTP (Go Server):${NC}"

PING=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:25565/ping 2>/dev/null)
HEALTH=$(curl -s http://127.0.0.1:25565/health 2>/dev/null)

if [ "$PING" = "200" ]; then
    echo -e "    ${GREEN}● /ping  200 OK${NC}"
else
    echo -e "    ${RED}● /ping  $PING (servidor pode estar iniciando)${NC}"
fi

if echo "$HEALTH" | grep -q "ok\|status"; then
    echo -e "    ${GREEN}● /health respondeu${NC}"
    echo "    $HEALTH" | head -c 200
    echo ""
else
    echo -e "    ${RED}● /health sem resposta${NC}"
fi

# ── Contas FF ──────────────────────────────────────────────────
echo ""
echo -e "  ${BOLD}[6] Contas Free Fire:${NC}"
CONTAS_FILE="$(dirname "$0")/Contas/room-accounts.txt"
if [ -f "$CONTAS_FILE" ]; then
    TOTAL=$(wc -l < "$CONTAS_FILE")
    echo -e "    ${GREEN}● room-accounts.txt: $TOTAL contas${NC}"
else
    echo -e "    ${RED}● room-accounts.txt nao encontrado${NC}"
fi

# ── Resumo final ───────────────────────────────────────────────
echo ""
echo -e "  ${BOLD}[7] Acesso externo:${NC}"
echo -e "    IP da VPS:    ${CYAN}$IP${NC}"
echo -e "    API:          ${CYAN}http://$IP:25565${NC}"
echo -e "    Ping:         ${CYAN}http://$IP:25565/ping${NC}"
echo -e "    Health:       ${CYAN}http://$IP:25565/health${NC}"
echo -e "    Status salas: ${CYAN}http://$IP:25565/api/v1/status${NC}"
echo ""
echo -e "  ${BOLD}Logs em tempo real:${NC}"
echo "    Go:   journalctl -u salaff-go -f --no-pager"
echo "    Node: journalctl -u salaff -f --no-pager"
echo ""
