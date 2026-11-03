set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "  ╔══════════════════════════════════════════════════════════╗"
echo "  ║    Salas FF - Go HTTP Server Build (v2.3.0-PG+Redis)    ║"
echo "  ╚══════════════════════════════════════════════════════════╝"
echo ""

if ! command -v go &> /dev/null; then
    echo "  [ERRO] Go nao encontrado. Instale Go 1.22+ primeiro."
    echo "  Baixe em: https://go.dev/dl/"
    exit 1
fi

echo "  [INFO] Go version: $(go version)"
echo "  [INFO] Compilando com otimizacoes (PostgreSQL + Redis, sem CGO)..."

cd "$SCRIPT_DIR"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags="-s -w -X main.version=2.3.0" \
    -trimpath \
    -o salas_ff_server ./cmd/server/

if [ $? -eq 0 ]; then
    echo "  [OK] Binario compilado: salas_ff_server"
    chmod +x salas_ff_server
    ls -lh salas_ff_server
    echo ""
    echo "  Banco de dados: PostgreSQL (dados permanentes) + Redis (salas em tempo real)"
    echo "  Portas configuradas:"
    echo "    - Go HTTP Server: 25565 (PORT)"
    echo "    - Bridge Node.js: 25566 (BRIDGE_PORT)"
    echo ""
    echo "  Variaveis de ambiente PostgreSQL:"
    echo "    PG_HOST (default: 127.0.0.1)"
    echo "    PG_PORT (default: 5432)"
    echo "    PG_USER (default: salasbeta)"
    echo "    PG_PASS (definir via variavel de ambiente)"
    echo "    PG_DB   (default: salasbeta)"
    echo ""
    echo "  Variaveis de ambiente Redis:"
    echo "    REDIS_HOST (default: 127.0.0.1)"
    echo "    REDIS_PORT (default: 6379)"
    echo "    REDIS_DB   (default: 0)"
    echo ""
    echo "  Para iniciar tudo: npm run start-all"
    echo "  Ou separadamente:"
    echo "    - Go Server:  ./salas_ff_server"
    echo "    - TCPBot:     node tcpbot.js"
    echo ""
else
    echo "  [ERRO] Falha na compilacao!"
    exit 1
fi
