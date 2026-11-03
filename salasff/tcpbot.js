/**
 * tcpbot.js - Main entry point (conversao de tcpbot.py)
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const {
    Logger, loadRoomAccountsData, saveRoomAccountsData,
    roomAccountsData, marcarRoomDirty, carregarRoomAccountsTxt
} = require('./utils');
const { iniciarBackupAutomatico, executarBackup, limparTmpOrfaos } = require('./safe_io');
const { RoomClient, invalidarTodosTokensCache } = require('./cliente');
const roomBridge = require('./room_bridge');

const configManager = require('./config_manager');

let gerarContaCompleta = null;
try { gerarContaCompleta = require('./gerador_contas').gerarContaCompleta; } catch (e) { /* not available */ }

const https = require('https');
const http = require('http');

// ============================================================
// GERADOR DE CONTAS VIA API EXTERNA
// ============================================================
// Gerador de contas - valores agora vem do config_manager (hot-reload)
// Use: configManager.get('gerador_api_url'), configManager.get('gerador_workers'), etc.
let _geradorApiEmAndamento = false;
let _geradorApiUltimaExecucao = 0;
let _contasSubstituidas = 0;

const _BASE_DIR = __dirname;

// ============================================================
// STATE
// ============================================================
let contasOnline = 0;
let contasErro = 0;
let _goProcess = null;
let _shutdownRequested = false;

// _MAX_FALHAS_DESATIVAR agora vem do config_manager: configManager.get('max_falhas_desativar')
const _contasDesativadas = new Set();
const _contasBlacklist = new Set(); // blacklist permanente - nunca mais tenta
const _contasBlacklistPendentes = new Map();
const _contasNivelBaixo = new Set(); // contas descartadas por nível < 5
const _contaFalhas = {}; // uid -> number of login failures
// _MAX_RESTART_RAPIDO agora vem do config_manager: configManager.get('max_restart_rapido')
let _restartCount = 0;
let _lastRestartTime = 0;
let _blacklistCount = 0; // contador de contas na blacklist

// (Renovacao diaria removida - substituida por auto-reposicao de contas mortas via API)

// ============================================================
// ANTI-LOOP DE SUBSTITUICAO
// ============================================================
const _contasRecemGeradas = new Set();
let _geradorPausado = false;
let _geradorPauseAte = 0;
// Anti-loop agora vem do config_manager
const _substituicoesRecentes = [];

// ============================================================
// WATCHDOG
// ============================================================
let _watchdogUltimoOnline = 0;
let _watchdogUltimoPoolOk = 0;
let _watchdogReiniciando = false;
// Watchdog timeouts agora vem do config_manager
let _watchdogGoRestarts = 0;
// _MAX_GO_RESTARTS agora vem do config_manager: configManager.get('max_go_restarts')

// ============================================================
// ROTACAO DE CONTAS
// ============================================================
// MAX_CONCURRENT agora vem do config_manager: configManager.get('max_concurrent')
let MAX_CONCURRENT = 600; // valor inicial, atualizado pelo config_manager
const _standbyQueue = [];
const _standbySet = new Set(); // UID set para garantir fila sem duplicatas
const _contasConectando = new Set(); // UIDs atualmente no processo de handshake/login
const _rotatedAccounts = new Set();
let _rotationActive = true;

function _adicionarStandby(uid, password) {
    if (!uid || !password) return false;
    if (_contasBlacklist.has(uid) || _contasDesativadas.has(uid)) return false;
    if (_standbySet.has(uid)) return false;
    _standbySet.add(uid);
    _standbyQueue.push([uid, password]);
    return true;
}

function _obterProximoStandby() {
    while (_standbyQueue.length > 0) {
        const [uid, password] = _standbyQueue.shift();
        _standbySet.delete(uid);
        if (_contasBlacklist.has(uid) || _contasDesativadas.has(uid)) {
            continue;
        }
        return [uid, password];
    }
    return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function _removerContaBlacklistDoArquivo(uid, password) {
    _contasBlacklistPendentes.set(uid, password);
    const arquivo = path.join(_BASE_DIR, 'Contas', 'room-accounts.txt');
    try {
        const linhas = fs.readFileSync(arquivo, 'utf-8').split('\n');
        const linhasFiltradas = linhas.filter(linha => {
            const trimmed = linha.trim();
            const separador = trimmed.includes(':') ? ':' : '|';
            return trimmed.split(separador, 1)[0].trim() !== uid;
        });
        if (linhasFiltradas.length !== linhas.length) {
            fs.writeFileSync(arquivo, linhasFiltradas.join('\n'));
            Logger.sistema(`[BLACKLIST] Conta ${uid} removida de room-accounts.txt`);
        }
    } catch (e) {
        Logger.erro(uid, `[BLACKLIST] Erro ao remover conta de room-accounts.txt: ${e.message}`);
    }
}

let _fileOpLock = Promise.resolve();

function _removerContaNivelBaixo(uid, password, nivel) {
    _contasNivelBaixo.add(uid);
    _contasDesativadas.add(uid);
    _contasBlacklist.add(uid);
    delete _contaFalhas[uid];
    _contasRecemGeradas.delete(uid);

    // Remover da fila de standby se estiver presente
    const idx = _standbyQueue.findIndex(([u]) => u === uid);
    if (idx !== -1) _standbyQueue.splice(idx, 1);

    const pool = roomBridge.roomClientsPool;
    if (pool && pool[uid]) {
        try { pool[uid].pararConexoes(); } catch (_) {}
        delete pool[uid];
    }
    if (uid in roomAccountsData) {
        delete roomAccountsData[uid];
        marcarRoomDirty();
        try { saveRoomAccountsData(); } catch (_) {}
    }

    _fileOpLock = _fileOpLock.then(() => {
        const arquivo = path.join(_BASE_DIR, 'Contas', 'room-accounts.txt');
        try {
            if (!fs.existsSync(arquivo)) return;
            const conteudo = fs.readFileSync(arquivo, 'utf-8');
            const linhas = conteudo.split(/\r?\n/);
            const linhasFiltradas = linhas.filter(linha => {
                const trimmed = linha.trim();
                if (!trimmed) return false;
                const separador = trimmed.includes(':') ? ':' : '|';
                return trimmed.split(separador, 1)[0].trim() !== String(uid).trim();
            });
            if (linhasFiltradas.length !== linhas.length) {
                fs.writeFileSync(arquivo, linhasFiltradas.join('\n') + (linhasFiltradas.length > 0 ? '\n' : ''));
                Logger.sistema(`[NIVEL] 🗑️ Conta ${uid} (nível ${nivel} < 5) deletada com sucesso de room-accounts.txt`);
            }
        } catch (e) {
            Logger.erro(uid, `[NIVEL] Erro ao deletar conta de room-accounts.txt: ${e.message}`);
        }
    }).catch(e => {
        Logger.erro(uid, `[NIVEL] Erro na fila de remoção de room-accounts.txt: ${e.message}`);
    });

    return _fileOpLock;
}

// ============================================================
// BANNER
// ============================================================
function _banner() {
    console.log();
    console.log("  \x1b[38;5;87m\x1b[1m╔══════════════════════════════════════════════════════════╗\x1b[0m");
    console.log("  \x1b[38;5;87m\x1b[1m║            Salas FF - Auto Start System              ║\x1b[0m");
    console.log("  \x1b[38;5;87m\x1b[1m║        Versao 4.0.0 (Rotacao + Chat Disabled)          ║\x1b[0m");
    console.log("  \x1b[38;5;87m\x1b[1m╚══════════════════════════════════════════════════════════╝\x1b[0m");
    console.log();
}

// ============================================================
// DISCONNECT ALL
// ============================================================
function _desconectarTodasContas() {
    const pool = roomBridge.roomClientsPool;
    if (!pool || Object.keys(pool).length === 0) return;
    Logger.sistema(`[CLEANUP] Desconectando ${Object.keys(pool).length} contas TCP...`);
    for (const uid of Object.keys(pool)) {
        try {
            const client = pool[uid];
            if (client) {
                client.running = false;
                if (client.onlineSocket && !client.onlineSocket.destroyed) {
                    try { client.onlineSocket.destroy(); } catch (e) { /* ignore */ }
                }
                if (client.mainSocket && !client.mainSocket.destroyed) {
                    try { client.mainSocket.destroy(); } catch (e) { /* ignore */ }
                }
            }
        } catch (e) { /* ignore */ }
    }
    Logger.sistema("[CLEANUP] Todas as contas sinalizadas para desconexao.");
}

async function _desconectarTodasContasAsync() {
    const pool = roomBridge.roomClientsPool;
    if (!pool || Object.keys(pool).length === 0) return;
    Logger.sistema(`[CLEANUP] Desconectando ${Object.keys(pool).length} contas TCP (async)...`);
    for (const uid of Object.keys(pool)) {
        try {
            const client = pool[uid];
            if (client) {
                try {
                    await Promise.race([client.pararConexoes(), sleep(5000)]);
                } catch (e) {
                    client.running = false;
                    if (client.onlineSocket && !client.onlineSocket.destroyed) {
                        try { client.onlineSocket.destroy(); } catch (e2) { /* ignore */ }
                    }
                }
            }
            delete pool[uid];
        } catch (e) { /* ignore */ }
    }
    Logger.sistema("[CLEANUP] Todas as contas desconectadas (async).");
}

// ============================================================
// SIGNAL HANDLERS
// ============================================================
// v33c: FIX BUG-TB1 - Signal handler async com cleanup completo antes de exit
let _shutdownInProgress = false;
async function _signalHandler(signal) {
    if (_shutdownInProgress) return; // evitar duplo shutdown
    _shutdownInProgress = true;
    Logger.sistema(`Sinal ${signal} recebido. Iniciando shutdown graceful...`);
    _shutdownRequested = true;
    try {
        // 1. Salvar dados de contas em disco
        Logger.sistema('[SHUTDOWN] Salvando room accounts...');
        try { saveRoomAccountsData(); } catch (e) { Logger.erro('SHUTDOWN', `Erro ao salvar accounts: ${e.message}`); }
        // 2. Salvar salas ativas no Redis
        Logger.sistema('[SHUTDOWN] Salvando salas no Redis...');
        try {
            const salasAtivas = roomBridge.salasAtivas || {};
            const dbRedis = require('./db_redis');
            dbRedis.salvarTodasSalas(salasAtivas);
        } catch (e) { Logger.erro('SHUTDOWN', `Erro ao salvar Redis: ${e.message}`); }
        // 3. Desconectar bots (com timeout de 10s)
        Logger.sistema('[SHUTDOWN] Desconectando bots...');
        try {
            await Promise.race([_desconectarTodasContasAsync(), sleep(10000)]);
        } catch (e) {
            _desconectarTodasContas(); // fallback sincrono
        }
        // 4. Matar Go server
        if (_goProcess) {
            try { _goProcess.kill(); } catch (e) { /* ignore */ }
        }
        Logger.sistema('[SHUTDOWN] Cleanup completo. Saindo...');
    } catch (e) {
        Logger.erro('SHUTDOWN', `Erro no cleanup: ${e.message}`);
    }
    process.exit(0);
}
process.on('SIGINT', () => _signalHandler('SIGINT'));
process.on('SIGTERM', () => _signalHandler('SIGTERM'));
process.on('uncaughtException', (err) => {
    try { Logger.erro('PROCESS', `uncaughtException: ${err.message}\n${err.stack}`); } catch (e) { }
    // NAO crashar - logar e continuar
});
process.on('unhandledRejection', (reason, promise) => {
    try { Logger.erro('PROCESS', `unhandledRejection: ${reason}`); } catch (e) { }
    // NAO crashar - logar e continuar
});

// ============================================================
// ROTACAO
// ============================================================
async function ativarContaStandby() {
    try {
        if (_contarPoolComConectando() >= MAX_CONCURRENT) {
            return false;
        }
        const prox = _obterProximoStandby();
        if (!prox) return false;
        const [uid, password] = prox;
        Logger.sistema(`[STANDBY] Ativando conta standby: ${uid} (restam ${_standbyQueue.length} na fila)`);
        loginRoomConta(uid, password);
        return true;
    } catch (e) {
        Logger.erro("system", `[STANDBY] Erro ao ativar standby: ${e.message}`);
        return false;
    }
}

async function rotacionarConta(uid) {
    if (_rotatedAccounts.has(uid)) return;
    _rotatedAccounts.add(uid);
    Logger.sistema(`[ROTACAO] Conta ${uid} sera desconectada apos GO`);
    const pool = roomBridge.roomClientsPool;
    if (uid in pool) {
        const client = pool[uid];
        try { await client.pararConexoes(); } catch (e) { /* ignore */ }
        delete pool[uid];
        if (uid in roomAccountsData) {
            roomAccountsData[uid].status_jogo = 'rotacionado';
            roomAccountsData[uid].status_api = 'livre';
            marcarRoomDirty();
        }
    }
    contasOnline = Math.max(0, contasOnline - 1);
    await ativarContaStandby();
}

// ============================================================
// LOGIN
// ============================================================
function _contarPoolReal() {
    const pool = roomBridge.roomClientsPool;
    return Object.values(pool).filter(c => c.running && !c.reconectando && c.isConnected()).length;
}

function _contarPoolComConectando() {
    return _contarPoolReal() + _contasConectando.size;
}

async function loginRoomConta(uid, password) {
    const pool = roomBridge.roomClientsPool;
    if (_contasDesativadas.has(uid)) return;
    if (_shutdownRequested) return;

    // Blacklist check - conta ja morta, nao tenta nada
    if (_contasBlacklist.has(uid)) return;

    let falhas = _contaFalhas[uid] || 0;
    if (falhas >= configManager.get('max_falhas_desativar')) {
        _contasDesativadas.add(uid);
        _contasBlacklist.add(uid);
        _removerContaBlacklistDoArquivo(uid, password);
        _blacklistCount++;
        contasErro++;
        _contasRecemGeradas.delete(uid);
        delete _contaFalhas[uid];
        // Log unico - nao spama mais
        if (_blacklistCount <= 50 || _blacklistCount % 100 === 0) {
            Logger.erro(uid, `[BLACKLIST] Conta morta apos ${falhas} falhas. Blacklist permanente. (total: ${_blacklistCount})`);
        }
        ativarContaStandby();
        return;
    }

    // Check concurrent limit (contando ativas + conectando)
    if (_contarPoolComConectando() >= MAX_CONCURRENT && !pool[uid]) {
        Logger.info(`[ROTACAO] Conta ${uid} em standby (pool=${_contarPoolReal()}+conectando=${_contasConectando.size}/${MAX_CONCURRENT})`);
        _adicionarStandby(uid, password);
        return;
    }

    _contasConectando.add(uid);

    const maxRetries = 3;
    let loginSuccess = false;
    for (let tentativa = 0; tentativa < maxRetries; tentativa++) {
        try {
            const client = new RoomClient(uid, password);
            const [accessToken, openId] = await client.obterTokenGuest();
            if (!accessToken || !openId) {
                if (tentativa < maxRetries - 1) { await sleep(500 * (tentativa + 1)); continue; }
                break;
            }
            const success = await client.criarToken(accessToken, openId);
            if (!success) {
                if (tentativa < maxRetries - 1) { await sleep(500 * (tentativa + 1)); continue; }
                break;
            }

            // Garena agora exige que a conta criadora da sala seja nível 5+.
            // Se for nível 1, 2, 3 ou 4, exclui imediatamente de room-accounts.txt e do sistema.
            let nivel = null;
            try {
                nivel = await client.obterNivelConta();
            } catch (errNivel) {
                Logger.erro(uid, `[NIVEL] Erro ao obter nível de ${uid}: ${errNivel.message}`);
            }

            if (nivel !== null && nivel < 5) {
                Logger.sistema(`[NIVEL] ❌ Conta ${uid} (${client.nickname || 'N/A'}) é nível ${nivel} (< 5). Removendo de room-accounts.txt e descartando do sistema...`);
                await _removerContaNivelBaixo(uid, password, nivel);
                _contasConectando.delete(uid);
                ativarContaStandby();
                return;
            }

            if (nivel !== null) {
                Logger.sistema(`[NIVEL] ✅ Conta ${uid} (${client.nickname || 'N/A'}) verificada: Nível ${nivel} (Apta para criar salas)`);
            }

            // Login OK
            _contaFalhas[uid] = 0;
            roomAccountsData[uid] = {
                nick: client.nickname,
                account_id: client.accountId,
                uid: uid,
                pass: password,
                level: nivel,
                status_api: "livre",
                status_jogo: "online",
                jwt_exp: client.jwtExp,
                chave_atual: client.chave,
                iv_atual: client.iv,
                main_ip: client.mainIp,
                main_porta: client.mainPorta,
                online_ip: client.onlineIp,
                online_porta: client.onlinePorta
            };
            pool[uid] = client;
            contasOnline++;
            loginSuccess = true;
            _contasConectando.delete(uid);
            const tempoLogin = Date.now() / 1000;
            await client.iniciarConexoes();

            // Monitor loop
            const monitorLoop = async () => {
                while (true) {
                    while (client.running) { await sleep(30000); }
                    if (client._emReconexaoCompleta || client.reconectando) {
                        Logger.info(`[ROOM] Conta ${uid} em reconexao completa, aguardando resultado...`);
                        try {
                            await Promise.race([client._reconexaoSucesso.wait(), sleep(180000)]);
                            if (client.running) {
                                Logger.info(`[ROOM] Conta ${uid} reconectou com sucesso, continuando monitoramento`);
                                client._reconexaoSucesso._recreate();
                                continue;
                            }
                        } catch (e) {
                            Logger.erro(uid, `[ROOM] Timeout 180s aguardando reconexao de ${uid}`);
                        }
                    } else if (client._retryEmAndamento) {
                        Logger.info(`[ROOM] Conta ${uid} com retry tardio em andamento, aguardando...`);
                        try {
                            await Promise.race([client._reconexaoSucesso.wait(), sleep(180000)]);
                            if (client.running) {
                                Logger.info(`[ROOM] Conta ${uid} reconectou via retry tardio!`);
                                client._reconexaoSucesso._recreate();
                                continue;
                            }
                        } catch (e) {
                            Logger.erro(uid, `[ROOM] Timeout 180s aguardando retry tardio de ${uid}`);
                        }
                    }
                    break;
                }

                contasOnline = Math.max(0, contasOnline - 1);
                const tempoOnline = Date.now() / 1000 - tempoLogin;

                // v29: Check rotacao PRIMEIRO - antes do check de desconexao rapida
                // Senao o return do desconexao rapida pula a compensacao do contasOnline
                if (_rotatedAccounts.has(uid)) {
                    _rotatedAccounts.delete(uid);
                    contasOnline++; // v29: Compensar decrement duplo (rotacionarConta ja decrementou)
                    Logger.info(`[ROTACAO] Conta ${uid} movida para standby apos rotacao`);
                    _adicionarStandby(uid, password);
                    return;
                }

                if (tempoOnline < 30) {
                    const falhasUid = (_contaFalhas[uid] || 0) + 1;
                    _contaFalhas[uid] = falhasUid;
                    Logger.erro(uid, `[ROOM] Desconexao rapida (${Math.floor(tempoOnline)}s) - falha #${falhasUid}/${configManager.get('max_falhas_desativar')}`);
                    if (falhasUid >= configManager.get('max_falhas_desativar')) {
                        _contasDesativadas.add(uid);
                        _contasBlacklist.add(uid);
                        _removerContaBlacklistDoArquivo(uid, password);
                        _blacklistCount++;
                        contasErro++;
                        delete pool[uid];
                        delete _contaFalhas[uid];
                        _contasRecemGeradas.delete(uid);
                        if (uid in roomAccountsData) {
                            roomAccountsData[uid].status_jogo = 'blacklist';
                            marcarRoomDirty();
                        }
                        if (_blacklistCount <= 50 || _blacklistCount % 100 === 0) {
                            Logger.erro(uid, `[BLACKLIST] Desconexao rapida ${falhasUid}x. Blacklist permanente. (total: ${_blacklistCount})`);
                        }
                        ativarContaStandby();
                        return;
                    } else {
                        Logger.info(`[ROOM] Tentando relogar mesma conta ${uid} (falha #${falhasUid})...`);
                        await sleep(5000 * falhasUid);
                        delete pool[uid];
                        loginRoomConta(uid, password);
                        return;
                    }
                } else {
                    _contaFalhas[uid] = 0;
                }

                Logger.info(`[ROOM] Conta ${uid} encerrou apos ${Math.floor(tempoOnline)}s. Tentando relogar...`);
                delete pool[uid];
                await sleep(3000);
                loginRoomConta(uid, password);
            };
            // Run monitor in background
            monitorLoop().catch(e => Logger.erro(uid, `[ROOM] Monitor loop erro: ${e.message}`));
            return;
        } catch (e) {
            if (tentativa < maxRetries - 1) { await sleep(500 * (tentativa + 1)); continue; }
            Logger.erro(uid, `Erro: ${e.message}`);
            break;
        }
    }

    if (!loginSuccess) {
        _contasConectando.delete(uid);
        contasErro++;
        delete pool[uid];
        if (uid in roomAccountsData) {
            delete roomAccountsData[uid];
            marcarRoomDirty();
        }
        _contasRecemGeradas.delete(uid);
        const falhasUid = (_contaFalhas[uid] || 0) + 1;
        _contaFalhas[uid] = falhasUid;
        if (falhasUid >= configManager.get('max_falhas_desativar')) {
            // Blacklist permanente: nao tenta novamente; o gerador pode substituir depois.
            _contasDesativadas.add(uid);
            _contasBlacklist.add(uid);
            _removerContaBlacklistDoArquivo(uid, password);
            _blacklistCount++;
            delete _contaFalhas[uid];
            if (_blacklistCount <= 50 || _blacklistCount % 100 === 0) {
                Logger.erro(uid, `[BLACKLIST] Conta morta apos ${falhasUid} falhas. Blacklist permanente. (total: ${_blacklistCount})`);
            }
            ativarContaStandby();
        } else {
            // Ainda tem tentativas, tenta 1x mais com delay maior
            if (falhasUid <= 2) {
                Logger.erro(uid, `[ROOM] Falhou login 3x (falha global #${falhasUid}/${configManager.get('max_falhas_desativar')}). Relogar em 30s...`);
                await sleep(30000);
                if (!_shutdownRequested && !_contasBlacklist.has(uid)) loginRoomConta(uid, password);
            } else {
                // 3a ou 4a falha global - delay bem maior
                Logger.erro(uid, `[ROOM] Falhou login 3x (falha global #${falhasUid}/${configManager.get('max_falhas_desativar')}). Relogar em 60s...`);
                await sleep(60000);
                if (!_shutdownRequested && !_contasBlacklist.has(uid)) loginRoomConta(uid, password);
            }
        }
    }
}

// ============================================================
// SUBSTITUICAO
// ============================================================
function _solicitarSubstituicao(uid, password) {
    const agora = Date.now() / 1000;
    // Clean old entries
    while (_substituicoesRecentes.length > 0 && agora - _substituicoesRecentes[0] >= configManager.get('substituicoes_janela')) {
        _substituicoesRecentes.shift();
    }
    if (_geradorPausado) {
        if (agora < _geradorPauseAte) {
            const restante = Math.floor(_geradorPauseAte - agora);
            Logger.erro(uid, `[GERADOR] Gerador PAUSADO por falha em massa. Restam ${restante}s.`);
            return;
        } else {
            _geradorPausado = false;
            Logger.sistema("[GERADOR] Pausa por falha em massa EXPIROU. Retomando geracoes...");
        }
    }
    _substituicoesRecentes.push(agora);
    if (_substituicoesRecentes.length >= configManager.get('substituicoes_limite')) {
        _geradorPausado = true;
        _geradorPauseAte = agora + configManager.get('gerador_pause_tempo');
        Logger.erro("GERADOR", `[GERADOR] FALHA EM MASSA DETECTADA! ${_substituicoesRecentes.length} substituicoes em ${configManager.get('substituicoes_janela')}s. Pausando gerador por ${configManager.get('gerador_pause_tempo')}s.`);
        return;
    }
    _substituirContaDesativada(uid, password);
}

async function _substituirContaDesativada(uidAntigo, passwordAntigo) {
    if (!configManager.get('gerador_ativo')) {
        Logger.info(`[GERADOR] Gerador desativado. Ativando standby para repor ${uidAntigo}...`);
        await ativarContaStandby();
        return;
    }
    if (!gerarContaCompleta) {
        Logger.erro(uidAntigo, "[GERADOR] modulo gerador_contas nao encontrado");
        return;
    }
    try {
        const pool = roomBridge.roomClientsPool;
        if (uidAntigo in pool) {
            try { await pool[uidAntigo].pararConexoes(); } catch (e) { /* ignore */ }
            delete pool[uidAntigo];
            Logger.sistema(`[GERADOR] Conta antiga ${uidAntigo} removida do pool`);
        }
        if (uidAntigo in roomAccountsData) {
            delete roomAccountsData[uidAntigo];
            marcarRoomDirty();
        }
        const nova = await gerarContaCompleta();
        if (!nova) {
            Logger.erro(uidAntigo, "[GERADOR] Falha ao gerar conta substituta");
            return;
        }
        const novoUid = String(nova.uid);
        const novoPassword = nova.password;
        _contasRecemGeradas.add(novoUid);
        // Update room-accounts.txt
        try {
            const arquivo = path.join(_BASE_DIR, 'Contas', 'room-accounts.txt');
            if (fs.existsSync(arquivo)) {
                let linhas = fs.readFileSync(arquivo, 'utf-8').split('\n');
                linhas = linhas.map(linha => {
                    const trimmed = linha.trim();
                    if (trimmed.startsWith(uidAntigo + ':') || trimmed.startsWith(uidAntigo + '|')) {
                        const sep = linha.includes(':') ? ':' : '|';
                        return `${novoUid}${sep}${novoPassword}`;
                    }
                    return linha;
                });
                fs.writeFileSync(arquivo, linhas.join('\n'));
                Logger.sistema(`[GERADOR] room-accounts.txt atualizado: ${uidAntigo} -> ${novoUid}`);
            }
        } catch (e) {
            Logger.erro(uidAntigo, `[GERADOR] Erro ao atualizar arquivo: ${e.message}`);
        }
        try { require('./db_postgres').deletarInfoAccount(uidAntigo); } catch (e) { /* ignore */ }
        _contasDesativadas.delete(uidAntigo);
        delete _contaFalhas[uidAntigo];
        Logger.sistema(`[GERADOR] Conta ${uidAntigo} substituida por ${novoUid}. Logando...`);
        await loginRoomConta(novoUid, novoPassword);
    } catch (e) {
        Logger.erro(uidAntigo, `[GERADOR] Erro ao substituir conta: ${e.message}`);
    }
}

// ============================================================
// AUTO-REPOSICAO DE CONTAS VIA API EXTERNA
// ============================================================
function _httpGet(url) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, { timeout: 30000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    if (res.headers['content-type']?.includes('json')) {
                        resolve({ status: res.statusCode, data: JSON.parse(data) });
                    } else {
                        resolve({ status: res.statusCode, data: data });
                    }
                } catch (e) {
                    resolve({ status: res.statusCode, data: data });
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

async function _gerarContasViaApi(quantidade) {
    const url = `${configManager.get('gerador_api_url')}/api/v1/gerar_contas?quantidade=${quantidade}&region=${configManager.get('gerador_region')}&workers=${configManager.get('gerador_workers')}`;
    Logger.sistema(`[GERADOR-API] Solicitando ${quantidade} contas novas...`);
    const resp = await _httpGet(url);
    if (resp.status !== 200 || !resp.data?.processId) {
        throw new Error(`Falha ao iniciar geracao: status=${resp.status}`);
    }
    const processId = resp.data.processId;
    Logger.sistema(`[GERADOR-API] Processo iniciado: ${processId.slice(0, 16)}...`);

    // Polling de status - esperar ate CONCLUIDO (max 10 min)
    const maxWait = 600; // 10 min
    const pollInterval = 10; // 10s
    let elapsed = 0;
    while (elapsed < maxWait) {
        await sleep(pollInterval * 1000);
        elapsed += pollInterval;
        try {
            const statusResp = await _httpGet(`${configManager.get('gerador_api_url')}/api/v2/status?processId=${processId}`);
            const statusData = statusResp.data;
            if (statusData?.status === 'CONCLUIDO') {
                Logger.sistema(`[GERADOR-API] Geracao concluida! ${statusData.total_accounts} contas geradas (${statusData.stats?.success_rate || '?'} sucesso)`);
                break;
            } else if (statusData?.status === 'ERRO' || statusData?.status === 'FALHA') {
                throw new Error(`Geracao falhou: ${statusData.status}`);
            }
            if (elapsed % 30 === 0) {
                Logger.info(`[GERADOR-API] Aguardando... status=${statusData?.status} | ${statusData?.stats?.total_delivered || 0} prontas | ${elapsed}s`);
            }
        } catch (e) {
            if (e.message.includes('Geracao falhou')) throw e;
            // Erro de rede, continua tentando
        }
    }
    if (elapsed >= maxWait) {
        throw new Error('Timeout esperando geracao de contas (10min)');
    }

    // Baixar o .txt
    const downloadUrl = `${configManager.get('gerador_api_url')}/api/v2/download-accounts?processId=${processId}`;
    const dlResp = await _httpGet(downloadUrl);
    if (dlResp.status !== 200 || !dlResp.data) {
        throw new Error(`Falha ao baixar contas: status=${dlResp.status}`);
    }
    const txtContent = typeof dlResp.data === 'string' ? dlResp.data : JSON.stringify(dlResp.data);
    const contas = [];
    for (const line of txtContent.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.includes(':')) {
            const [uid, password] = trimmed.split(':', 2);
            if (uid && password) contas.push([uid.trim(), password.trim()]);
        }
    }
    Logger.sistema(`[GERADOR-API] ${contas.length} contas baixadas do .txt`);
    return contas;
}

async function _autoReporContasMortas() {
    if (_geradorApiEmAndamento || _shutdownRequested) {
        Logger.info(`[GERADOR-API] Check ignorado: emAndamento=${_geradorApiEmAndamento} shutdown=${_shutdownRequested}`);
        return;
    }
    const agora = Date.now() / 1000;
    if (agora - _geradorApiUltimaExecucao < configManager.get('gerador_check_interval')) return;

    // Se o gerador estiver desativado, usar as contas de Standby para repor
    if (!configManager.get('gerador_ativo')) {
        // Se a fila de standby estiver vazia, tentar ler novas contas inseridas no room-accounts.txt
        if (_standbyQueue.length === 0) {
            try {
                const contasTxt = carregarRoomAccountsTxt();
                const pool = roomBridge.roomClientsPool || {};
                for (const [u, p] of contasTxt) {
                    if (!pool[u] && !_contasBlacklist.has(u) && !_contasDesativadas.has(u)) {
                        _adicionarStandby(u, p);
                    }
                }
            } catch (e) { /* ignore */ }
        }

        let poolComConectando = _contarPoolComConectando();
        if (poolComConectando < MAX_CONCURRENT && _standbyQueue.length > 0) {
            let ativadas = 0;
            while (_standbyQueue.length > 0 && _contarPoolComConectando() < MAX_CONCURRENT) {
                const ok = await ativarContaStandby();
                if (ok) {
                    ativadas++;
                    await sleep(500);
                } else {
                    break;
                }
            }
            if (ativadas > 0) {
                Logger.sistema(`[STANDBY-REPOSICAO] Repostas ${ativadas} contas pelo Standby (Blacklist: ${_contasBlacklist.size} | Standby restante: ${_standbyQueue.length})`);
            }
        }
        return;
    }

    Logger.info(`[GERADOR-API] Verificando contas mortas... blacklist=${_contasBlacklist.size}`);

    const contasMortas = [..._contasBlacklistPendentes.entries()];

    Logger.info(`[GERADOR-API] Contas mortas pendentes: ${contasMortas.length} (min: ${configManager.get('gerador_min_blacklist')})`);

    if (contasMortas.length < configManager.get('gerador_min_blacklist')) {
        return; // Poucas mortas, nao vale a pena
    }

    _geradorApiEmAndamento = true;
    _geradorApiUltimaExecucao = agora;
    Logger.sistema(`[GERADOR-API] Detectadas ${contasMortas.length} contas mortas na blacklist. Gerando substitutas...`);

    try {
        const contasNovas = await _gerarContasViaApi(contasMortas.length);
        if (!contasNovas || contasNovas.length === 0) {
            Logger.erro('GERADOR-API', 'Nenhuma conta gerada pela API');
            return;
        }

        // Substituir contas mortas pelas novas no room-accounts.txt
        const arquivo = path.join(_BASE_DIR, 'Contas', 'room-accounts.txt');
        let linhas = [];
        try {
            linhas = fs.readFileSync(arquivo, 'utf-8').split('\n');
        } catch (e) {
            Logger.erro('GERADOR-API', `Erro ao ler room-accounts.txt: ${e.message}`);
            return;
        }

        const pool = roomBridge.roomClientsPool;
        const dbPostgres = require('./db_postgres');
        let substituidas = 0;
        const maxSubstituir = Math.min(contasMortas.length, contasNovas.length);
        const uidsSubstituidos = []; // acumular pra remover da blacklist DEPOIS do save
        const uidsNovosParaLogar = []; // acumular pra logar DEPOIS do save

        for (let i = 0; i < maxSubstituir; i++) {
            const [uidMorto, passMorto] = contasMortas[i];
            const [uidNovo, passNovo] = contasNovas[i];

            // Remover conta morta do pool
            if (uidMorto in pool) {
                try { await pool[uidMorto].pararConexoes(); } catch (e) { /* ignore */ }
                delete pool[uidMorto];
            }
            // Remover do roomAccountsData
            if (uidMorto in roomAccountsData) {
                delete roomAccountsData[uidMorto];
                marcarRoomDirty();
            }
            // Limpar falhas e desativadas (mas NAO remover da blacklist ainda)
            _contasDesativadas.delete(uidMorto);
            delete _contaFalhas[uidMorto];
            // Remover do banco
            try { dbPostgres.deletarInfoAccount(uidMorto); } catch (e) { /* ignore */ }

            // Substituir no room-accounts.txt caso a remoção da blacklist tenha falhado.
            let linhaSubstituida = false;
            linhas = linhas.map(linha => {
                const trimmed = linha.trim();
                if (trimmed.startsWith(uidMorto + ':') || trimmed.startsWith(uidMorto + '|')) {
                    linhaSubstituida = true;
                    return `${uidNovo}:${passNovo}`;
                }
                return linha;
            });
            if (!linhaSubstituida) linhas.push(`${uidNovo}:${passNovo}`);

            // Marcar como recem gerada
            _contasRecemGeradas.add(uidNovo);
            substituidas++;
            uidsSubstituidos.push(uidMorto);
            uidsNovosParaLogar.push([uidNovo, passNovo]);

            Logger.sistema(`[GERADOR-API] ${uidMorto} -> ${uidNovo} (${substituidas}/${maxSubstituir})`);
        }

        // Salvar room-accounts.txt atualizado ANTES de remover da blacklist
        try {
            fs.writeFileSync(arquivo, linhas.join('\n'));
            Logger.sistema(`[GERADOR-API] room-accounts.txt atualizado com ${substituidas} contas novas`);
        } catch (e) {
            Logger.erro('GERADOR-API', `Erro ao salvar room-accounts.txt: ${e.message}`);
            // Se falhou o save, nao remove da blacklist pra tentar de novo na proxima rodada
            return;
        }

        // AGORA sim remover da blacklist (txt ja foi salvo)
        for (const uidMorto of uidsSubstituidos) {
            _contasBlacklist.delete(uidMorto);
            _contasBlacklistPendentes.delete(uidMorto);
        }

        // Logar as contas novas com delay entre elas
        for (let i = 0; i < uidsNovosParaLogar.length; i++) {
            const [uidNovo, passNovo] = uidsNovosParaLogar[i];
            loginRoomConta(uidNovo, passNovo);
            if (i < uidsNovosParaLogar.length - 1) await sleep(500);
        }

        _contasSubstituidas += substituidas;
        Logger.sistema(`[GERADOR-API] Reposicao concluida: ${substituidas} contas substituidas | Blacklist restante: ${_contasBlacklist.size} (total historico: ${_contasSubstituidas})`);

    } catch (e) {
        Logger.erro('GERADOR-API', `Erro na auto-reposicao: ${e.message}`);
    } finally {
        _geradorApiEmAndamento = false;
    }
}

function _iniciarAutoReposicao() {
    const modo = configManager.get('gerador_ativo') ? 'GERADOR-API' : 'STANDBY';
    Logger.sistema(`[REPOSICAO] Auto-reposicao ativada (modo: ${modo}, check a cada ${configManager.get('gerador_check_interval')}s, min ${configManager.get('gerador_min_blacklist')} mortas)`);
    if (configManager.get('gerador_ativo')) {
        Logger.sistema(`[GERADOR-API] URL: ${configManager.get('gerador_api_url')} | Region: ${configManager.get('gerador_region')} | Workers: ${configManager.get('gerador_workers')}`);
    }
    Logger.sistema(`[GERADOR-API] _geradorApiEmAndamento=${_geradorApiEmAndamento} _shutdownRequested=${_shutdownRequested}`);
    setInterval(() => {
        _autoReporContasMortas().catch(e => Logger.erro('GERADOR-API', `Erro no loop: ${e.message}`));
    }, configManager.get('gerador_check_interval') * 1000);
    // Primeira verificacao apos 30s
    setTimeout(() => {
        Logger.sistema(`[GERADOR-API] Primeira verificacao iniciando... blacklist=${_contasBlacklist.size}`);
        _autoReporContasMortas().catch(e => Logger.erro('GERADOR-API', `Erro na primeira verificacao: ${e.message}`));
    }, 30000);
}

// ============================================================
// BATCH LOGIN
// ============================================================
async function loginRoomContasBatch() {
    contasOnline = 0;
    contasErro = 0;

    // Invalidate all token caches
    try {
        const count = invalidarTodosTokensCache();
        if (count > 0) {
            Logger.sistema(`[ROOM] ${count} tokens antigos invalidados (forcando tokens novos)`);
            Logger.sistema("[ROOM] Aguardando 15s para servidor FF liberar sessoes anteriores...");
            await sleep(15000);
            Logger.sistema("[ROOM] Delay concluido. Iniciando login...");
        }
    } catch (e) { /* ignore */ }

    const accounts = carregarRoomAccountsTxt();
    if (!accounts || accounts.length === 0) {
        Logger.erro("system", "Nenhuma conta em Contas/room-accounts.txt");
        return;
    }

    const total = accounts.length;
    Logger.sistema(`[ROOM] Logando ${total} contas (MAX_CONCURRENT=${MAX_CONCURRENT}, CHAT_DISABLED=True)...`);
    Logger.sistema(`[ROOM] Contas alem do limite serao colocadas em standby para rotacao`);

    // Priority: accounts with active rooms log in first
    try {
        const priorityUids = roomBridge.getPriorityUids ? roomBridge.getPriorityUids() : [];
        if (priorityUids && priorityUids.length > 0) {
            const priorityAccounts = accounts.filter(([u]) => priorityUids.includes(u));
            const otherAccounts = accounts.filter(([u]) => !priorityUids.includes(u));
            accounts.length = 0;
            accounts.push(...priorityAccounts, ...otherAccounts);
            Logger.sistema(`[ROOM] ${priorityAccounts.length} contas com salas ativas serao logadas PRIMEIRO`);
        }
    } catch (e) { Logger.erro("system", `Erro ao priorizar contas: ${e.message}`); }

    const BATCH_SIZE = 15;
    const BASE_BATCH_DELAY = 800;
    const BASE_INTRA_DELAY = 200;
    let _errosAnterior = 0;

    for (let i = 0; i < accounts.length; i++) {
        if (_shutdownRequested) break;
        const [uid, password] = accounts[i];

        // Pular contas na blacklist
        if (_contasBlacklist.has(uid)) continue;

        if (_contarPoolComConectando() >= MAX_CONCURRENT) {
            _adicionarStandby(uid, password);
            continue;
        }

        loginRoomConta(uid, password);

        if ((i + 1) % BATCH_SIZE === 0) {
            const batchNum = Math.floor((i + 1) / BATCH_SIZE);
            const errosNovos = contasErro - _errosAnterior;
            _errosAnterior = contasErro;
            const taxaErro = errosNovos / BATCH_SIZE;

            if (taxaErro > 0.5) {
                const extraDelay = Math.min(5000, taxaErro * 5000);
                Logger.sistema(`[ROOM] Batch ${batchNum}: ${i + 1}/${total} (${contasOnline} on, ${contasErro} err, ${_standbyQueue.length} stby) [SLOW: +${(extraDelay / 1000).toFixed(1)}s]`);
                await sleep(BASE_BATCH_DELAY + extraDelay);
            } else if (taxaErro > 0.2) {
                const extraDelay = taxaErro * 2000;
                Logger.sistema(`[ROOM] Batch ${batchNum}: ${i + 1}/${total} (${contasOnline} on, ${contasErro} err, ${_standbyQueue.length} stby) [+${(extraDelay / 1000).toFixed(1)}s]`);
                await sleep(BASE_BATCH_DELAY + extraDelay);
            } else {
                Logger.sistema(`[ROOM] Batch ${batchNum}: ${i + 1}/${total} (${contasOnline} on, ${contasErro} err, ${_standbyQueue.length} stby)`);
                await sleep(BASE_BATCH_DELAY);
            }
        } else {
            await sleep(BASE_INTRA_DELAY);
        }
    }

    Logger.sistema(`[ROOM] Todas as ${total} tasks criadas. ${_standbyQueue.length} contas em standby.`);

    // Wait for logins (timeout 2 min)
    let timeoutCount = 0;
    while (timeoutCount < 120) {
        const processadas = contasOnline + contasErro + _contasNivelBaixo.size + _standbyQueue.length;
        if (processadas >= total) break;
        await sleep(1000);
        timeoutCount++;
        if (timeoutCount % 30 === 0) {
            Logger.sistema(`[ROOM] Progresso: ${contasOnline} online, ${contasErro} erros, ${_contasNivelBaixo.size} descartadas (< nv 5), ${_standbyQueue.length} standby, ${total - processadas} pendentes`);
        }
    }
    Logger.sistema(`[ROOM] Login finalizado: ${contasOnline}/${total} online, ${contasErro} erros, ${_contasNivelBaixo.size} descartadas (< nv 5), ${_standbyQueue.length} standby`);

    // Auto-start pending rooms after 10s
    setTimeout(() => _autoStartSalasPendentesRestart().catch(e => Logger.erro('RESTART-GO', `Erro geral: ${e.message}`)), 10000);
}

// ============================================================
// AUTO-START SALAS PENDENTES
// ============================================================
async function _autoStartSalasPendentesRestart() {
    try {
        const salasParaIniciar = [];
        const salasAguardandoTimer = [];
        const agora = Date.now() / 1000;
        const quinzeMinutos = 15 * 60;
        const salasAtivas = roomBridge.salasAtivas || {};
        for (const [sshash, sala] of Object.entries(salasAtivas)) {
            const estado = sala.estado || '';
            if (estado !== 'ESPERANDO_COMECAR') continue;
            if (sala.partida_iniciada || sala.saldo_devolvido) continue;
            const createdTime = sala.created_timestamp || agora;
            const tdc = agora - createdTime;
            if (tdc > quinzeMinutos) continue;
            const uidConta = sala.uid_conta;
            const roomId = sala.room_id;
            if (!uidConta || !roomId) continue;
            // Respeitar o timer de auto_start_min: so iniciar se o tempo ja passou
            const autoStartMin = sala.auto_start_min || 5.0;
            const autoStartSeconds = autoStartMin * 60;
            if (tdc >= autoStartSeconds) {
                salasParaIniciar.push([sshash, roomId, uidConta]);
            } else {
                const faltam = Math.ceil(autoStartSeconds - tdc);
                salasAguardandoTimer.push([sshash, faltam]);
                Logger.info(`[RESTART-GO] Sala ${sshash.slice(0, 8)}: faltam ${faltam}s para auto-start, aguardando timer`);
            }
        }
        if (salasParaIniciar.length === 0 && salasAguardandoTimer.length === 0) {
            Logger.sistema('[RESTART-GO] Nenhuma sala pendente para auto-start');
            return;
        }
        if (salasAguardandoTimer.length > 0) {
            Logger.sistema(`[RESTART-GO] ${salasAguardandoTimer.length} sala(s) aguardando timer de auto-start (timeoutCheckerLoop vai cuidar)`);
        }
        if (salasParaIniciar.length === 0) {
            Logger.sistema('[RESTART-GO] Nenhuma sala pronta para iniciar agora');
            return;
        }
        Logger.sistema(`[RESTART-GO] Iniciando ${salasParaIniciar.length} sala(s) pendente(s) pos-restart...`);
        let iniciadas = 0, falhas = 0;
        const pool = roomBridge.roomClientsPool;
        for (const [sshash, roomId, uidConta] of salasParaIniciar) {
            try {
                const client = pool[uidConta];
                if (!client || !client.isConnected()) {
                    Logger.info(`[RESTART-GO] Bot ${uidConta} nao conectado, pulando sala ${sshash.slice(0, 8)}`);
                    falhas++;
                    continue;
                }
                if (!(sshash in salasAtivas)) continue;
                const sala = salasAtivas[sshash];
                if (sala.partida_iniciada || sala.estado === 'SALA_INICIADA') continue;
                salasAtivas[sshash].estado = 'COMECANDO';
                salasAtivas[sshash].last_update = Date.now() / 1000;
                salasAtivas[sshash].inicio_em_andamento = true;
                roomBridge.salvarSalasDb();
                await roomBridge.autoIniciarSala(client, roomId, sshash);
                iniciadas++;
                await sleep(2000);
            } catch (e) {
                Logger.erro('RESTART-GO', `Erro ao iniciar sala ${sshash.slice(0, 8)}: ${e.message}`);
                falhas++;
            }
        }
        Logger.sistema(`[RESTART-GO] Concluido: ${iniciadas} iniciadas, ${falhas} falhas`);
    } catch (e) {
        Logger.erro('RESTART-GO', `Erro geral: ${e.message}`);
    }
}

// ============================================================
// TOKEN RENEWAL
// ============================================================
async function renovarTokensRoom() {
    await sleep(10000);
    while (!_shutdownRequested) {
        try {
            await sleep(1 * 60 * 60 * 1000 + Math.floor(Math.random() * 300000)); // 1h + random(0-5min)
            const pool = roomBridge.roomClientsPool;
            const contasRenovar = [];
            for (const uid of Object.keys(pool)) {
                if (_contasDesativadas.has(uid)) continue;
                const client = pool[uid];
                if (client && client.running && !client.reconectando) {
                    if (client.jwtExp && (client.jwtExp - Date.now() / 1000) < 7200) { // renova se expira em < 2h
                        contasRenovar.push(uid);
                    }
                }
            }
            if (contasRenovar.length === 0) {
                Logger.sistema(`Renovacao de JWTs: nenhuma conta precisa renovar agora`);
                continue;
            }
            Logger.sistema(`Renovando JWTs de ${contasRenovar.length} contas...`);
            let sucesso = 0, falha = 0;
            for (const uid of contasRenovar) {
                if (uid in pool && !_contasDesativadas.has(uid)) {
                    try {
                        const result = await pool[uid].renovarTokenEReconectar(true);
                        if (result) sucesso++; else falha++;
                    } catch (e) { falha++; }
                    await sleep(3000);
                }
            }
            Logger.sistema(`Renovacao de JWTs concluida: ${sucesso} OK, ${falha} falhas`);
        } catch (e) {
            Logger.erro("system", `Erro renovacao: ${e.message}`);
        }
    }
}

// ============================================================
// POOL CLEANUP
// ============================================================
async function _limparPoolMortas() {
    const pool = roomBridge.roomClientsPool;
    const uidsRemover = [];
    for (const [uid, client] of Object.entries(pool)) {
        if (!client.running && !client.reconectando) {
            if (client._emReconexaoCompleta) continue;
            if (client._retryEmAndamento) continue;
            if (!client.temSalaAtiva) uidsRemover.push(uid);
        }
    }
    for (const uid of uidsRemover) delete pool[uid];
    // Clean disabled accounts
    for (const uid of [..._contasDesativadas]) {
        if (!(uid in pool)) _contasDesativadas.delete(uid);
    }
    // v29: NAO limpar _rotatedAccounts aqui - o monitorLoop precisa encontrar
    // o uid no set para compensar o decrement duplo de contasOnline.
    // O monitorLoop faz o delete corretamente na L347.
    if (uidsRemover.length > 0) {
        Logger.sistema(`[LIMPEZA] Removidas ${uidsRemover.length} contas mortas do pool. Pool: ${Object.keys(pool).length}`);
    }
}

// ============================================================
// ROTATION MONITOR
// ============================================================
async function monitorarRotacao() {
    while (!_shutdownRequested) {
        try {
            await sleep(15000);
            await _limparPoolMortas();
            let ativadas = 0;
            while (_standbyQueue.length > 0 && _contarPoolComConectando() < MAX_CONCURRENT) {
                const ok = await ativarContaStandby();
                if (ok) {
                    ativadas++;
                    await sleep(1000);
                    if (ativadas % 10 === 0) await sleep(3000);
                } else {
                    break;
                }
            }
            if (ativadas > 0) {
                Logger.sistema(`[ROTACAO] Ativadas ${ativadas} contas standby. Restam ${_standbyQueue.length} em fila. Pool: ${Object.keys(roomBridge.roomClientsPool).length}`);
            }
        } catch (e) { /* ignore */ }
    }
}

// ============================================================
// AUTO-SAVE
// ============================================================
function autoSave() {
    setInterval(() => {
        if (!_shutdownRequested) {
            try { saveRoomAccountsData(); } catch (e) { /* ignore */ }
        }
    }, 60000);
}

// ============================================================
// WATCHDOG
// ============================================================
function _watchdog() {
    _watchdogUltimoOnline = Date.now() / 1000;
    _watchdogUltimoPoolOk = Date.now() / 1000;

    setInterval(() => {
        if (_shutdownRequested) return;
        try {
            const agora = Date.now() / 1000;
            const poolSize = Object.keys(roomBridge.roomClientsPool).length;
            const poolReal = _contarPoolReal();
            const goOk = _goProcess && !_goProcess.killed;
            const goStatus = goOk ? "RODANDO" : "PARADO";

            // v30: Usar SOMENTE poolReal - contasOnline manual é bugado
            // poolReal conta bots REAIS conectados no pool, sem depender de contador manual
            if (poolReal > 0) {
                _watchdogUltimoOnline = agora;
                _watchdogUltimoPoolOk = agora;
            }
            // Sincronizar contasOnline com poolReal (so pra exibicao)
            contasOnline = poolReal;

            const tempoSemOnline = Math.floor(agora - _watchdogUltimoOnline);
            const tempoSemPool = Math.floor(agora - _watchdogUltimoPoolOk);

            Logger.info(`[WATCHDOG] Pool: ${poolSize} | Ativas: ${poolReal}/${MAX_CONCURRENT} | Online: ${poolReal} | Erros: ${contasErro} | Standby: ${_standbyQueue.length} | Blacklist: ${_contasBlacklist.size} | Substituidas: ${_contasSubstituidas} | GerandoAPI: ${_geradorApiEmAndamento ? 'SIM' : 'NAO'} | Go: ${goStatus} | Sem online: ${tempoSemOnline}s | Sem pool: ${tempoSemPool}s`);

            // Protection 2: No REAL bots in pool for too long
            if (poolReal === 0 && (agora - _watchdogUltimoOnline) > configManager.get('watchdog_timeout_contas')) {
                if (!_watchdogReiniciando) {
                    Logger.erro("WATCHDOG", `ALERTA: 0 bots ativos no pool ha ${tempoSemOnline}s! Reiniciando login...`);
                    _reiniciarLoginContas();
                    _watchdogUltimoOnline = agora;
                }
            }

            // Protection 3: Pool completely empty for too long
            if (poolReal === 0 && poolSize === 0 && (agora - _watchdogUltimoPoolOk) > configManager.get('watchdog_timeout_pool')) {
                if (!_watchdogReiniciando) {
                    Logger.erro("WATCHDOG", `CRITICO: Pool zerado ha ${tempoSemPool}s! Reiniciando TUDO...`);
                    _reiniciarLoginContas();
                    _watchdogUltimoPoolOk = agora;
                }
            }
        } catch (e) {
            Logger.erro("WATCHDOG", `Erro no watchdog: ${e.message}`);
        }
    }, configManager.get('watchdog_check_interval') * 1000);
}

async function _reiniciarLoginContas() {
    if (_watchdogReiniciando) return;
    _watchdogReiniciando = true;
    Logger.sistema("[WATCHDOG] Reiniciando login de contas...");
    try {
        await _desconectarTodasContasAsync();
        try {
            const count = invalidarTodosTokensCache();
            Logger.sistema(`[WATCHDOG] ${count} tokens invalidados no cache`);
        } catch (e) { /* ignore */ }
        // Clear pool and data (manter blacklist!)
        const pool = roomBridge.roomClientsPool;
        for (const uid of Object.keys(pool)) delete pool[uid];
        _contasDesativadas.clear();
        // Re-adicionar blacklist nas desativadas
        for (const uid of _contasBlacklist) _contasDesativadas.add(uid);
        for (const k of Object.keys(_contaFalhas)) delete _contaFalhas[k];
        Logger.sistema("[WATCHDOG] Aguardando 15s para servidor FF liberar sessoes antigas...");
        await sleep(15000);
        Logger.sistema("[WATCHDOG] Reiniciando login batch...");
        loginRoomContasBatch();
        Logger.sistema("[WATCHDOG] Login de contas reiniciado");
    } catch (e) {
        Logger.erro("WATCHDOG", `Falha ao reiniciar login: ${e.message}`);
    } finally {
        _watchdogReiniciando = false;
    }
}

// ============================================================
// GO HTTP SERVER
// ============================================================
function iniciarServidorGoHttp() {
    const goBinary = path.join(_BASE_DIR, "kallidade-api");
    if (!fs.existsSync(goBinary)) {
        Logger.erro("system", `Binario Go nao encontrado: ${goBinary}`);
        return;
    }
    fs.chmodSync(goBinary, 0o755);
    const env = { ...process.env, KALLIDADE_BASE_DIR: _BASE_DIR, PORT: "25568", BRIDGE_PORT: "25566" };
    Logger.sistema(`Iniciando servidor Go HTTP na porta 25565...`);
    _goProcess = spawn(goBinary, [], { env, cwd: _BASE_DIR, stdio: 'inherit' });
    Logger.sistema(`Servidor Go HTTP iniciado (PID: ${_goProcess.pid})`);
    _goProcess.on('exit', (code) => {
        if (!_shutdownRequested) Logger.erro("system", `Servidor Go HTTP encerrou inesperadamente! (code=${code})`);
    });
}

// ============================================================
// MAIN
// ============================================================
async function iniciarSistema() {
    _banner();

    const agora = Date.now() / 1000;
    if (agora - _lastRestartTime < 60) {
        _restartCount++;
    } else {
        _restartCount = 0;
    }
    _lastRestartTime = agora;

    if (_restartCount >= configManager.get('max_restart_rapido')) {
        Logger.erro("system", `Sistema reiniciou ${_restartCount}x em menos de 60s. Aguardando 5min para estabilizar...`);
        await sleep(300000);
        _restartCount = 0;
    }

    Logger.sistema("Inicializando sistema...");

    // Inicializar config manager (hot-reload)
    configManager.inicializar();
    MAX_CONCURRENT = configManager.get('max_concurrent');
    Logger.sistema(`[CONFIG] MAX_CONCURRENT=${MAX_CONCURRENT} | CHAT_DISABLED=True`);

    // Callback para atualizar MAX_CONCURRENT quando config muda
    configManager.onConfigChange((config, mudancas) => {
        MAX_CONCURRENT = config.max_concurrent;
        Logger.sistema(`[CONFIG-LIVE] Config atualizada: MAX_CONCURRENT=${MAX_CONCURRENT} | gerador_ativo=${config.gerador_ativo}`);
    });

    // Register rotation callback
    roomBridge.setRotacaoCallback(rotacionarConta);

    try {
        const dbSqlite = require('./db_postgres');
        await dbSqlite.inicializarSchema();
        await dbSqlite.carregarCacheCompleto();
    } catch (e) {
        Logger.erro("system", `Falha ao inicializar banco de dados: ${e.message}`);
        return;
    }

    Logger.sistema("Carregando contas de room...");
    loadRoomAccountsData();

    Logger.sistema("Limpando arquivos temporarios...");
    try { limparTmpOrfaos(); } catch (e) { /* ignore */ }

    Logger.sistema("Executando backup inicial...");
    try { executarBackup(); } catch (e) { /* ignore */ }

    Logger.sistema("Iniciando backup automatico (6h)...");
    try { iniciarBackupAutomatico(); } catch (e) { /* ignore */ }

    Logger.sistema(`Iniciando Bridge Python na porta 25566...`);
    await roomBridge.iniciarBridgeThread();

    Logger.sistema("Iniciando auto-save (60s)...");
    autoSave();

    Logger.sistema("Iniciando watchdog...");
    _watchdog();

    Logger.sistema("Iniciando auto-reposicao de contas mortas...");
    _iniciarAutoReposicao();

    Logger.sistema("Iniciando contas Room...");
    await loginRoomContasBatch();

    // Start token renewal and rotation monitor
    renovarTokensRoom();
    monitorarRotacao();

    Logger.sistema("Todos os modulos iniciados. Servidor Go deve ser iniciado manualmente.");
}

// ============================================================
// ENTRY POINT
// ============================================================
if (require.main === module) {
    iniciarSistema().catch(e => {
        Logger.erro("system", `CRASH DETECTADO: ${e.message}`);
        console.error(e.stack);
        _desconectarTodasContas();
        try { saveRoomAccountsData(); } catch (e2) { /* ignore */ }
        try { invalidarTodosTokensCache(); } catch (e2) { /* ignore */ }
        Logger.sistema("Reiniciando sistema em 15 segundos...");
        setTimeout(() => {
            iniciarSistema().catch(e2 => {
                Logger.erro("system", `CRASH FATAL: ${e2.message}`);
                process.exit(1);
            });
        }, 15000);
    });
}

module.exports = {
    loginRoomConta,
    loginRoomContasBatch,
    rotacionarConta,
    ativarContaStandby,
    iniciarSistema,
    MAX_CONCURRENT,
    getWatchdogStats: () => {
        return {
            geradorApiEmAndamento: _geradorApiEmAndamento,
            contasSubstituidas: _contasSubstituidas,
            contasBlacklistSize: _contasBlacklist.size,
            standbyQueueLength: _standbyQueue.length,
            contasErro: contasErro,
            maxConcurrent: MAX_CONCURRENT
        };
    }
};
