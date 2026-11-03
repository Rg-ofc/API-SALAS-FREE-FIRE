'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

let BaseDir = process.env.KALLIDADE_BASE_DIR || process.cwd();
let Port = process.env.PORT || '25565';
let BridgePort = process.env.BRIDGE_PORT || '25566';
let AESKey = process.env.KALLIDADE_AES_KEY || '';
const AESSalt = process.env.KALLIDADE_AES_SALT || '';
const AESDefault = '';

let EfiClientID = process.env.EFI_CLIENT_ID || '0';
let EfiClientSecret = process.env.EFI_CLIENT_SECRET || '0';
let EfiPixKey = process.env.EFI_PIX_KEY || '';
const EfiAPIURL = 'https://pix.api.efipay.com.br';

let SecretKey = '';

function carregarOuGerarSecretKey() {
    const chaveEnv = process.env.FLASK_SECRET_KEY || '';
    if (chaveEnv.length >= 32) return chaveEnv;

    const envFile = path.join(BaseDir, '.env');
    if (fs.existsSync(envFile)) {
        try {
            const conteudo = fs.readFileSync(envFile, 'utf-8');
            for (const linha of conteudo.split('\n')) {
                const trimmed = linha.trim();
                if (trimmed.startsWith('FLASK_SECRET_KEY=')) {
                    let valor = trimmed.split('=').slice(1).join('=');
                    valor = valor.replace(/^["']|["']$/g, '');
                    if (valor.length >= 32) {
                        process.env.FLASK_SECRET_KEY = valor;
                        return valor;
                    }
                }
            }
        } catch (e) { /* ignore */ }
    }

    const nova = crypto.randomBytes(48).toString('base64url');
    let existentes = [];
    if (fs.existsSync(envFile)) {
        try {
            existentes = fs.readFileSync(envFile, 'utf-8').split('\n')
                .filter(l => !l.trim().startsWith('FLASK_SECRET_KEY='));
        } catch (e) { /* ignore */ }
    }
    existentes.push(`FLASK_SECRET_KEY="${nova}"`);
    fs.writeFileSync(envFile, existentes.join('\n') + '\n', { mode: 0o600 });
    process.env.FLASK_SECRET_KEY = nova;
    return nova;
}

function init(baseDir) {
    if (baseDir) BaseDir = baseDir;
    Port = process.env.PORT || '25565';
    BridgePort = process.env.BRIDGE_PORT || '25566';
    AESKey = process.env.KALLIDADE_AES_KEY || AESDefault;
    EfiClientID = process.env.EFI_CLIENT_ID || EfiClientID;
    EfiClientSecret = process.env.EFI_CLIENT_SECRET || EfiClientSecret;
    EfiPixKey = process.env.EFI_PIX_KEY || '';
    SecretKey = carregarOuGerarSecretKey();
}

// Diretórios e Arquivos — Sistema
const DBDir = () => path.join(BaseDir, 'DB_SYSTEM');
const DBRoomsFile = () => path.join(DBDir(), 'db-rooms.json');
const DBStatsFile = () => path.join(DBDir(), 'db-stats.json');
const UploadsDir = () => path.join(BaseDir, 'uploads');
const CertsDir = () => path.join(BaseDir, 'certefibank671');

// Diretórios e Arquivos — Admin (src_web)
const SrcWebDir = () => path.join(BaseDir, 'src_web');
const KeysFile = () => path.join(SrcWebDir(), 'database', 'keys-info.json');
const AdminInfoFile = () => path.join(SrcWebDir(), 'database', 'info-admin.json');
const ConfigFile = () => path.join(SrcWebDir(), 'config', 'config.json');

// Diretórios e Arquivos — Dashboard
const DashboardDir = () => path.join(BaseDir, 'src_dashboard-web');
const DashboardDBDir = () => path.join(DashboardDir(), 'database');
const AdminsDashboardFile = () => path.join(DashboardDBDir(), 'admins_dashboard.json');
const AdminSessionsFile = () => path.join(DashboardDBDir(), 'admin_sessions.json');
const AdminSessionStoreFile = () => path.join(DashboardDBDir(), 'admin_session_store.json');
const SessoesFile = () => path.join(DashboardDBDir(), 'sessoes.json');
const UsuariosFile = () => path.join(DashboardDBDir(), 'usuarios.json');
const PagamentosFile = () => path.join(DashboardDBDir(), 'pagamentos.json');
const PagamentosConfigFile = () => path.join(DashboardDBDir(), 'pagamentos-config.json');
const SaldosFile = () => path.join(DashboardDBDir(), 'saldos.json');
const FornecedoresFile = () => path.join(DashboardDBDir(), 'fornecedores.json');
const AvisosFile = () => path.join(DashboardDBDir(), 'avisos.json');
const TelegramVipsFile = () => path.join(DashboardDBDir(), 'telegram_vips.json');

// Diretórios e Arquivos — Telegram
const SrcTelegramDir = () => path.join(BaseDir, 'src_telegram');
const SrcWebTelegramDir = () => path.join(BaseDir, 'src_web_telegram');
const TelegramUsersFile = () => path.join(SrcTelegramDir(), 'database', 'users-bot.json');
const TelegramUserKeysFile = () => path.join(SrcTelegramDir(), 'database', 'user_keys.json');
const TelegramUserConfigFile = () => path.join(SrcTelegramDir(), 'database', 'user_config.json');
const TelegramUserBotInfoFile = () => path.join(SrcTelegramDir(), 'database', 'user-bot-info.json');
const TelegramTransmissoesFile = () => path.join(SrcTelegramDir(), 'database', 'transmissoes.json');

module.exports = {
    get BaseDir() { return BaseDir; },
    get Port() { return Port; },
    get BridgePort() { return BridgePort; },
    get AESKey() { return AESKey; },
    AESSalt, AESDefault,
    get EfiClientID() { return EfiClientID; },
    get EfiClientSecret() { return EfiClientSecret; },
    get EfiPixKey() { return EfiPixKey; },
    EfiAPIURL,
    get SecretKey() { return SecretKey; },
    init,
    DBDir, DBRoomsFile, DBStatsFile, UploadsDir, CertsDir,
    SrcWebDir, KeysFile, AdminInfoFile, ConfigFile,
    DashboardDir, DashboardDBDir, AdminsDashboardFile, AdminSessionsFile,
    AdminSessionStoreFile, SessoesFile, UsuariosFile, PagamentosFile,
    PagamentosConfigFile, SaldosFile, FornecedoresFile, AvisosFile, TelegramVipsFile,
    SrcTelegramDir, SrcWebTelegramDir, TelegramUsersFile, TelegramUserKeysFile,
    TelegramUserConfigFile, TelegramUserBotInfoFile, TelegramTransmissoesFile,
};
