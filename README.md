# API-SALAS-FREE-FIRE
API DE CRIAÇÃO DE SALAS NO FREE FIRE COM GERADOR DE CONTAS. USEM E ABUSEM!

# Guia de Configuração e Injeção de Credenciais

Este documento detalha onde e como preencher as credenciais, variáveis de ambiente, certificados e arquivos de contas do projeto (`salasff` e `gerador_api`).

---

## 1. Variáveis de Ambiente (.env)

Crie ou edite o arquivo `.env` na raiz de `salasff/` e em `salasff/web/`.

Exemplo de template `.env`:

```env
# --- Banco de Dados PostgreSQL ---
PG_HOST=127.0.0.1
PG_PORT=5432
PG_USER=salasbeta
PG_PASS=sua_senha_postgres_aqui
PG_DB=salasbeta

# --- Redis ---
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_DB=0
# REDIS_PASSWORD=  # opcional, se houver senha

# --- Servidor e Bridge ---
PORT=25565
BRIDGE_PORT=25566
BRIDGE_HOST=127.0.0.1

# --- Chaves de Sessão e Criptografia ---
FLASK_SECRET_KEY=gere_uma_chave_longa_aleatoria_aqui_com_no_minimo_32_chars
KALLIDADE_AES_KEY=chave_hex_64_caracteres_aqui
KALLIDADE_AES_SALT=salt_qualquer_aqui

# --- Proxy (salasff) ---
PROXY_ENABLED=false
PROXY_HOST=gw.dataimpulse.com
PROXY_PORT=823
PROXY_USER=seu_usuario_proxy
PROXY_PASS=sua_senha_proxy

# --- Efí Bank (PIX) ---
EFI_CLIENT_ID=Client_Id_gerado_no_painel_efi
EFI_CLIENT_SECRET=Client_Secret_gerado_no_painel_efi
EFI_PIX_KEY=sua_chave_pix_evp_aqui

# --- Turbofy Pay ---
TURBOFY_CLIENT_ID=rf_seu_client_id_turbofy
TURBOFY_CLIENT_SECRET=seu_client_secret_turbofy

# --- Discord OAuth2 ---
DISCORD_CLIENT_ID=id_da_sua_aplicacao_discord
DISCORD_CLIENT_SECRET=secret_da_sua_aplicacao_discord
DISCORD_BASE_URL=https://seudominio.com
ADMIN_DISCORD_IDS=1059959131580153866,1356281361610047699

# --- Telegram Bot ---
TELEGRAM_BOT_TOKEN=token_do_botfather_aqui
```

---

## 2. Certificados Efí Bank (mTLS PIX)

Para emitir cobranças PIX e consultar status via Efí Bank / Gerencianet, são necessários os arquivos `.pem` no diretório:

```
salasff/certefibank671/
├── certificado.pem
└── chave.pem
```

### Como extrair do arquivo `.p12` emitido pela Efí:

1. Baixe o arquivo `.p12` (ex.: `producao.p12`) da sua conta na Efí.
2. Extraia o certificado público:
   ```bash
   openssl pkcs12 -in producao.p12 -out certificado.pem -clcerts -nokeys
   ```
3. Extraia a chave privada desprotegida:
   ```bash
   openssl pkcs12 -in producao.p12 -out chave.pem -nocerts -nodes
   ```
4. Mova `certificado.pem` e `chave.pem` para a pasta `salasff/certefibank671/`.

---

## 3. Proxies

### salasff
Pode ser configurado de duas formas:
- **Via variáveis de ambiente (.env)**:
  `PROXY_ENABLED=true`, `PROXY_HOST`, `PROXY_PORT`, `PROXY_USER`, `PROXY_PASS`.
- **Via arquivo txt**:
  Em `salasff/web/handlers/proxy.txt`, insira uma linha no formato:
  ```text
  usuario:senha@gw.dataimpulse.com:823
  ```

### gerador_api
Pode ser configurado via variáveis no ambiente ou no arquivo `gerador_api/server.js`:
- Variáveis: `PROXY_ENABLED=true`, `PROXY_HOST`, `PROXY_PORT`, `PROXY_USER`, `PROXY_PASS`.
- Ou na array `LISTA_PROXIES` em `gerador_api/server.js`:
  ```javascript
  const LISTA_PROXIES = [
      {
          host: 'gw.dataimpulse.com',
          port: '823',
          user: 'usuario_proxy',
          pass: 'senha_proxy',
          region: 'BR'
      }
  ];
  ```

---

## 4. Contas Free Fire (Bots criadores de salas)

Os arquivos de contas esperam linhas no formato `UID:SENHA`:

- `salasff/Contas/room-accounts.txt`: Contas ativas que o bot carrega para entrar em fila e criar as salas.
- `salasff/Contas/guardar.txt`: Estoque/reserva de contas para substituição automática.
- `gerador_api/contas_geradas.txt`: Arquivo alimentado automaticamente quando a API geradora de contas cria novas credenciais.

Exemplo de formato:
```text
8326084710:0DC8011CFC4E4DD37C6EB87C6F505370F4E5A3E6EDAE6FFDB0F81F79BAB82CE6
8326084724:E722804CE5F01FAF79E8FFD2158D6BE18FE55D0C8195082727EFD5A8DCF5222B
```

---

## 5. Scripts de Instalação e Execução na VPS

### setup_postgres.sh
Antes de executar o instalador do PostgreSQL:
```bash
export PG_USER="salasbeta"
export PG_PASS="sua_senha_forte_aqui"
export PG_DB="salasbeta"
sudo -E bash setup_postgres.sh
```

### instalar_vps.sh
Antes de rodar a instalação geral:
```bash
export PG_USER="salasbeta"
export PG_PASS="sua_senha_forte_aqui"
export PG_DB="salasbeta"
sudo -E bash instalar_vps.sh
```
O script configurará os serviços systemd (`salaff` e `salaff-go`) repassando as credenciais definidas.

### verificar.sh
Para testar a saúde do sistema:
```bash
export PG_PASS="sua_senha_forte_aqui"
bash verificar.sh
```

---

## 6. Painel Web Admin (src_web)

Arquivo: `salasff/src_web/config/config.json`
```json
{
  "admin_user_id": "admin_local",
  "auth": {
    "type": "local",
    "username": "SalasFF"
  },
  "session_secret": "sua_chave_secreta_de_sessao_aqui"
}
```
Preencha `session_secret` com uma string arbitrária para assinar as sessões de cookies locais do admin.

