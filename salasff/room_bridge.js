const http = require('http');
const crypto = require('crypto');
const axios = require('axios').default || require('axios');
const { Logger, roomAccountsData, marcarRoomDirty } = require('./utils');
const dbSqlite = require('./db_postgres');
const dbRedis = require('./db_redis');

let imageRoom = null;
try {
    imageRoom = require('./image_room');
    Logger.sistema('[IMAGE_ROOM] Modulo image_room carregado com sucesso');
} catch (e) {
    Logger.info(`[IMAGE_ROOM] Modulo image_room NAO disponivel: ${e.message}`);
}

let clienteModule = null;
try {
    clienteModule = require('./cliente');
} catch (e) { }

let roomSkillsModule = null;
let renderSalaIniciadaModule = null;
try {
    roomSkillsModule = require('./lib/player_skills/room_skills');
    renderSalaIniciadaModule = require('./lib/render_sala_iniciada');
    Logger.sistema('[SKILLS_CARD] Modulos de renderizacao e habilidades carregados com sucesso');
} catch (e) {
    Logger.info(`[SKILLS_CARD] Modulo de habilidades NAO disponivel: ${e.message}`);
}

let _rotacionarContaFn = null;

function setRotacaoCallback(fn) {
    _rotacionarContaFn = fn;
}

const roomClientsPool = {};
let roomLoop = null;
const salasAtivas = {};
const systemStats = {
    start_time: Date.now() / 1000,
    total_requests_bot: 0,
    success_requests_bot: 0,
    total_requests_api: 0,
    success_requests_api: 0,
    total_salas_criadas: 0
};

const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || '25566');
const BRIDGE_BASE_URL = process.env.BRIDGE_BASE_URL || `http://${process.env.BRIDGE_HOST || '127.0.0.1'}:${BRIDGE_PORT}`;
const WEBHOOK_SALA_CRIADA = "";
const WEBHOOK_JOGADORES = process.env.WEBHOOK_JOGADORES || "";

const _webhooksPorSala = {};

let _salasDbDirty = false;
let _salasDbTimer = null;
let _persistentStats = null;
let _persistentStatsDirty = false;

const _autoStartEmAndamento = new Set();

let _statusCache = null;
let _statusCacheTime = 0;
let _infoCache = null;
let _infoCacheTime = 0;

const _priorityUids = new Set();

function _carregarPersistentStats() {
    try {
        const data = dbSqlite.carregarStats();
        if (data && typeof data === 'object') {
            _persistentStats = data;
        } else {
            _persistentStats = { total_salas_criadas: 0, total_salas_iniciadas: 0 };
        }
    } catch (e) {
        _persistentStats = { total_salas_criadas: 0, total_salas_iniciadas: 0 };
    }
}

function _salvarPersistentStats() {
    try {
        const dataCopy = { ..._persistentStats };
        dbSqlite.salvarStats(dataCopy);
    } catch (e) { /* ignore */ }
}

function incrementarStat(campo) {
    if (!_persistentStats) _carregarPersistentStats();
    _persistentStats[campo] = (_persistentStats[campo] || 0) + 1;
    _persistentStatsDirty = true;
}

function obterPersistentStats() {
    if (!_persistentStats) _carregarPersistentStats();
    return { ..._persistentStats };
}

function setRoomLoop(loop) {
    roomLoop = loop;
}

function obterHoraBrasilia() {
    const now = new Date();
    const offset = -3 * 60;
    const local = new Date(now.getTime() + offset * 60 * 1000);
    const y = local.getUTCFullYear();
    const m = String(local.getUTCMonth() + 1).padStart(2, '0');
    const d = String(local.getUTCDate()).padStart(2, '0');
    const h = String(local.getUTCHours()).padStart(2, '0');
    const min = String(local.getUTCMinutes()).padStart(2, '0');
    const s = String(local.getUTCSeconds()).padStart(2, '0');
    return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

function gerarSshash() {
    return crypto.randomBytes(16).toString('hex');
}

function getBase() {
    return process.env.KALLIDADE_BASE_DIR || __dirname;
}

function carregarKeysDb() {
    const data = dbSqlite.carregarKeysInfo();
    if (!data || !data.keys) return { keys: [] };
    return data;
}

function salvarKeysDb(dados) {
    dbSqlite.salvarTodasKeys(dados);
}

function salvarKeyUnica(keyInfo) {
    if (!keyInfo || !keyInfo.key) return;
    dbSqlite.salvarKeyInfo(keyInfo);
}

function _salvarSalasDbAgora() {
    try {
        const dataSnapshot = {};
        for (const [k, v] of Object.entries(salasAtivas)) {
            dataSnapshot[k] = { ...v };
        }
        dbRedis.salvarTodasSalas(dataSnapshot);
    } catch (e) { /* ignore */ }
    _salasDbDirty = false;
}

function salvarSalasDb() {
    _salasDbDirty = true;
    if (_salasDbTimer) clearTimeout(_salasDbTimer);
    _salasDbTimer = setTimeout(_salvarSalasDbAgora, 5000);
}

function salvarSalasDbSync() {
    if (_salasDbTimer) {
        clearTimeout(_salasDbTimer);
        _salasDbTimer = null;
    }
    _salvarSalasDbAgora();
}

function getPriorityUids() {
    return new Set(_priorityUids);
}

function carregarSalasDb() {
    let data = dbRedis.carregarTodasSalas();
    if (!data) data = {};
    if (typeof data === 'object' && !Array.isArray(data)) {
        Object.assign(salasAtivas, data);
    }
    const agora = Date.now() / 1000;
    const quinzeMinutos = 15 * 60;
    let salasRestauradas = 0;
    let salasExpiradas = 0;
    for (const [sshash, sala] of Object.entries(salasAtivas)) {
        const estado = sala.estado || "";
        if (sala.partida_iniciada || estado === "SALA_INICIADA") continue;
        if (sala.saldo_devolvido) continue;
        if (["TIMEOUT_15MIN", "CANCELADA", "FALHA_AO_COMECAR"].includes(estado)) continue;
        const createdTime = sala.created_timestamp || agora;
        const tempoDesdeCriacao = agora - createdTime;
        if (tempoDesdeCriacao > quinzeMinutos) {
            sala.estado = "TIMEOUT_15MIN";
            sala.msg_timeout = "Sala expirou durante reinicio do servidor";
            sala.saldo_devolvido = true;
            salasExpiradas++;
            continue;
        }
        sala.estado = "ESPERANDO_COMECAR";
        sala.iniciar_ao_reconectar = true;
        sala.aguardando_reconexao = true;
        sala.partida_iniciada = false;
        sala.inicio_em_andamento = false;
        sala.auto_iniciada = false;
        const uidConta = sala.uid_conta;
        if (uidConta) _priorityUids.add(uidConta);
        salasRestauradas++;
    }
    if (salasRestauradas > 0 || salasExpiradas > 0) {
        Logger.sistema(`[RESTART] Salas restauradas: ${salasRestauradas} pendentes, ${salasExpiradas} expiradas, ${_priorityUids.size} contas prioritarias`);
        salvarSalasDb();
    }
}

function obterContaDisponivel(excluirUids = null) {
    const contasDisponiveis = [];
    const agora = Date.now();
    for (const [uid, data] of Object.entries(roomAccountsData)) {
        if (excluirUids && (excluirUids.has(uid) || (Array.isArray(excluirUids) && excluirUids.includes(uid)))) continue;
        if (data.cooldown_ate && agora < data.cooldown_ate) continue;
        if (!(uid in roomClientsPool)) continue;
        const client = roomClientsPool[uid];
        if (client.reconectando) continue;
        if (!client.isConnected()) continue;
        // v30: Garantir que apenas contas da regiao BR criem salas (evita erro de conexao para jogadores brasileiros)
        if (client.clientRegion && client.clientRegion.toUpperCase() !== 'BR') continue;
        const statusApi = data.status_api || '';
        if (statusApi !== 'livre' && statusApi !== '') continue;
        if (statusApi === '') data.status_api = 'livre';
        contasDisponiveis.push(uid);
    }
    if (contasDisponiveis.length) {
        return contasDisponiveis[Math.floor(Math.random() * contasDisponiveis.length)];
    }
    return null;
}

function desbugarContaBackground(client, uid) {
    if (uid in roomAccountsData) {
        roomAccountsData[uid].cooldown_ate = Date.now() + 90000; // 90s cooldown para a conta respirar
        roomAccountsData[uid].status_api = 'desbugando';
    }
    setImmediate(async () => {
        try {
            if (client && client.onlineSocket && !client.onlineSocket.destroyed) {
                const { criarPacoteSairPartida, criarPacoteSairSala } = require('./pacotes');
                const pktPartida = criarPacoteSairPartida(client.chave, client.iv);
                client.onlineSocket.write(pktPartida);
                await new Promise(r => setTimeout(r, 500));
                const pktSala = criarPacoteSairSala(0, client.chave, client.iv);
                client.onlineSocket.write(pktSala);
                Logger.info(`[AUTO-DESBUGAR] Comandos de sair de partida/sala enviados para GuestUID ${uid}`);
            }
        } catch (e) {
            Logger.erro('AUTO-DESBUGAR', `Erro ao desbugar UID ${uid}: ${e.message}`);
        } finally {
            setTimeout(() => {
                if (uid in roomAccountsData && roomAccountsData[uid].status_api === 'desbugando') {
                    roomAccountsData[uid].status_api = 'livre';
                    delete roomAccountsData[uid].cooldown_ate;
                }
            }, 90000);
        }
    });
}

function marcarContaEmUso(uid) {
    if (uid in roomAccountsData) {
        roomAccountsData[uid].status_api = 'em_uso';
    }
}

function liberarConta(uid) {
    if (uid in roomClientsPool) {
        roomClientsPool[uid].temSalaAtiva = false;
    }
    if (uid in roomAccountsData) {
        roomAccountsData[uid].status_api = 'livre';
    }
}

function contarContasConectadas() {
    let count = 0;
    for (const uid of Object.keys(roomClientsPool)) {
        const client = roomClientsPool[uid];
        if (client && client.isConnected()) count++;
    }
    return count;
}

function devolverUsoKey(oauthKey) {
    const dados = carregarKeysDb();
    for (const keyInfo of (dados.keys || [])) {
        if (keyInfo.key === oauthKey) {
            const usos = keyInfo.usos_totais || keyInfo.total_usos || 0;
            if (usos > 0) {
                keyInfo.usos_totais = usos - 1;
                salvarKeyUnica(keyInfo);
            }
            return;
        }
    }
}

function devolverSaldoSalaSeguro(sshash) {
    if (!(sshash in salasAtivas)) return false;
    const sala = salasAtivas[sshash];
    if (sala.saldo_devolvido) return false;
    const oauthKey = sala.oauth_key;
    if (!oauthKey) return false;
    sala.saldo_devolvido = true;
    salvarSalasDb();
    devolverUsoKey(oauthKey);
    return true;
}

function enviarWebhookSalaCriada(roomId, modo, sshash, senha, nome, oauthKey = null) {
    try {
        const modoMap = { 1: "Sem Equipamento", 2: "Gelo Infinito", 3: "Full Capa", 4: "Com Carregamento", 5: "Full UMP/XM8 Gel Normal", 6: "Full UMP/XM8 Gel Infinito" };
        const modoTexto = modoMap[modo] || `Modo ${modo}`;
        const descricao = `**Room ID:** \`${roomId}\`\n**Modo:** \`${modoTexto}\`\n**Nome:** \`${nome || 'Sem nome'}\`\n**Senha:** \`${senha || 'Sem senha'}\``;
        let keyInfoTexto = "N/A";
        if (oauthKey) {
            const dados = carregarKeysDb();
            for (const ki of (dados.keys || [])) {
                if (ki.key === oauthKey) {
                    const limite = ki.limite_usos || 0;
                    const usos = ki.usos_totais || ki.total_usos || 0;
                    if (ki.ilimitada) {
                        keyInfoTexto = `\`${oauthKey}\`\n**Tipo:** Ilimitada`;
                    } else {
                        const restantes = limite - usos;
                        keyInfoTexto = `\`${oauthKey}\`\n**Usos Restantes:** ${restantes}/${limite}`;
                    }
                    break;
                }
            }
        }
        const embed = {
            title: "Nova Sala Criada",
            description: descricao,
            color: 0x57F287,
            fields: [
                { name: "Hash", value: `\`${sshash}\``, inline: false },
                { name: "Key Utilizada", value: keyInfoTexto, inline: false }
            ]
        };
        if (WEBHOOK_SALA_CRIADA) {
            axios.post(WEBHOOK_SALA_CRIADA, { embeds: [embed] }, { timeout: 5000 }).catch(() => { });
        }
    } catch (e) { /* ignore */ }
}

function enviarWebhookSalaIniciada(roomId, modo, sshash, jogadores) {
    try {
        const modoMap = { 1: "Sem Equipamento", 2: "Gelo Infinito", 3: "Full Capa", 4: "Com Carregamento", 5: "Full UMP/XM8 Gel Normal", 6: "Full UMP/XM8 Gel Infinito" };
        const modoTexto = modoMap[modo] || `Modo ${modo}`;
        const descricao = `**Room ID:** \`${roomId}\`\n**Modo:** \`${modoTexto}\``;
        const embed = {
            title: "Sala Iniciada",
            description: descricao,
            color: 0x5865F2,
            fields: [
                { name: "Hash", value: `\`${sshash}\``, inline: false },
                { name: "Jogadores", value: String(Array.isArray(jogadores) ? jogadores.length : (typeof jogadores === 'object' ? Object.keys(jogadores).length : 0)), inline: true }
            ]
        };
        if (WEBHOOK_SALA_CRIADA) {
            axios.post(WEBHOOK_SALA_CRIADA, { embeds: [embed] }, { timeout: 5000 }).catch(() => { });
        }
    } catch (e) { /* ignore */ }

    enviarStartInfo(roomId, modo, sshash, jogadores);
}

const START_INFO_URL = '';
const PLAYER_INFO_URL = '';

function enviarStartInfo(roomId, modo, sshash, jogadores) {
    if (!START_INFO_URL) return;
    try {
        const modoMap = { 1: "Sem Equipamento", 2: "Gelo Infinito", 3: "Full Capa", 4: "Com Carregamento", 5: "Full UMP/XM8 Gel Normal", 6: "Full UMP/XM8 Gel Infinito" };
        const sala = salasAtivas[sshash] || {};

        // Montar lista de jogadores
        let jogadoresArray = [];
        if (Array.isArray(jogadores)) {
            jogadoresArray = jogadores;
        } else if (jogadores && typeof jogadores === 'object') {
            jogadoresArray = Object.values(jogadores);
        }
        const playersList = jogadoresArray.map(p => ({
            uid: String(p.uid || p.accountId || 'N/A'),
            nick: p.nick || p.nickname || 'N/A',
            team: p.team || 0,
            slot: p.slot || 0
        }));

        const payload = {
            sshash: sshash,
            room_id: String(roomId),
            modo: modo,
            modo_texto: modoMap[modo] || `Modo ${modo}`,
            senha: sala.senha || '',
            nome: sala.nome || '',
            estado: 'SALA_INICIADA',
            created_at: sala.created_at || null,
            created_timestamp: sala.created_timestamp || null,
            partida_iniciada_timestamp: sala.partida_iniciada_timestamp || Date.now() / 1000,
            oauth_key: sala.oauth_key || null,
            auto_start_min: sala.auto_start_min || null,
            total_players: playersList.length,
            players: playersList
        };

        axios.post(START_INFO_URL, payload, {
            timeout: 10000,
            headers: { 'Content-Type': 'application/json' }
        }).then(() => {
            Logger.info(`[START-INFO] POST enviado com sucesso para ${START_INFO_URL} (sala ${sshash.slice(0, 8)})`);
        }).catch((err) => {
            Logger.erro('START-INFO', `Falha ao enviar POST para ${START_INFO_URL}: ${err.message}`);
        });
    } catch (e) {
        Logger.erro('START-INFO', `Erro ao montar payload start_info: ${e.message}`);
    }
}

function enviarPlayerInfo(sshash, evento) {
    if (!PLAYER_INFO_URL) return;
    try {
        const eventosPermitidos = ['player_join', 'player_leave', 'player_switch_team', 'player_switch_slot'];
        if (!eventosPermitidos.includes(evento.tipo)) return;

        const j = evento.jogador;
        if (!j) return;

        const sala = salasAtivas[sshash] || {};
        const modoMap = { 1: "Sem Equipamento", 2: "Gelo Infinito", 3: "Full Capa", 4: "Com Carregamento", 5: "Full UMP/XM8 Gel Normal", 6: "Full UMP/XM8 Gel Infinito" };
        const tipoMap = {
            'player_join': 'jogador_entrou',
            'player_leave': 'jogador_saiu',
            'player_switch_team': 'jogador_trocou_time',
            'player_switch_slot': 'jogador_trocou_slot'
        };

        const payload = {
            // Info da sala
            sshash: sshash,
            room_id: String(sala.room_id || ''),
            modo: sala.modo || 0,
            modo_texto: modoMap[sala.modo] || `Modo ${sala.modo || 0}`,
            senha: sala.senha || '',
            nome: sala.nome || '',
            oauth_key: sala.oauth_key || null,
            estado: sala.estado || '',
            // Info do evento
            evento: tipoMap[evento.tipo] || evento.tipo,
            evento_tipo_raw: evento.tipo,
            timestamp: evento.timestamp || Date.now() / 1000,
            timestamp_iso: new Date((evento.timestamp || Date.now() / 1000) * 1000).toISOString(),
            // Info do jogador
            jogador: {
                uid: String(j.uid || 'N/A'),
                nick: j.nick || 'N/A',
                plataforma: j.plataforma || 'mobile',
                versao_ff: j.versao_ff || 'desconhecido',
                emulator_score: j.emulator_score || 0,
                team: j.team || 0,
                team_name: j.team_name || '',
                slot: j.slot || 0
            }
        };

        // Detalhes extras para switch
        if (evento.de_team !== undefined) payload.de_team = evento.de_team;
        if (evento.para_team !== undefined) payload.para_team = evento.para_team;
        if (evento.de_slot !== undefined) payload.de_slot = evento.de_slot;
        if (evento.para_slot !== undefined) payload.para_slot = evento.para_slot;

        axios.post(PLAYER_INFO_URL, payload, {
            timeout: 10000,
            headers: { 'Content-Type': 'application/json' }
        }).then(() => {
            Logger.info(`[PLAYER-INFO] POST ${evento.tipo} enviado (sala ${sshash.slice(0, 8)})`);
        }).catch((err) => {
            Logger.erro('PLAYER-INFO', `Falha POST ${evento.tipo}: ${err.message}`);
        });
    } catch (e) {
        Logger.erro('PLAYER-INFO', `Erro ao montar payload player_info: ${e.message}`);
    }
}

function _enviarWebhookEvento(sshash, evento) {
    // POST para API externa (todos os eventos)
    enviarPlayerInfo(sshash, evento);

    const webhookUrl = _webhooksPorSala[sshash] || WEBHOOK_JOGADORES;
    if (!webhookUrl) return;
    try {
        const colorMap = {
            'player_join': 0x57F287,
            'player_leave': 0xED4245,
            'player_switch_team': 0xFEE75C,
            'player_switch_slot': 0x5865F2,
            'room_start': 0xFF4500
        };
        const tipoMap = {
            'player_join': 'Jogador Entrou',
            'player_leave': 'Jogador Saiu',
            'player_switch_team': 'Jogador Trocou de Time',
            'player_switch_slot': 'Jogador Trocou de Slot',
            'room_start': 'Sala Iniciada (GO)'
        };
        let embed;
        if (evento.tipo === 'room_start') {
            // v22: Evento de sala iniciada - formato especial
            const fields = [
                { name: 'Room ID', value: `\`${evento.room_id || 'N/A'}\``, inline: true },
                { name: 'Estado', value: `\`${evento.estado || 'SALA_INICIADA'}\``, inline: true },
                { name: 'Total Players', value: `\`${evento.total_players || 0}\``, inline: true }
            ];
            if (evento.players && evento.players.length > 0) {
                const playerList = evento.players.map(p =>
                    `\`${p.nick}\` (UID: \`${p.uid}\` | Time: \`${p.team}\` | Slot: \`${p.slot}\`)`
                ).join('\n');
                fields.push({ name: 'Jogadores na Sala', value: playerList.slice(0, 1024) });
            }
            embed = {
                title: tipoMap[evento.tipo] || evento.tipo,
                color: colorMap[evento.tipo] || 0x99AAB5,
                description: 'A partida foi iniciada com sucesso!',
                fields,
                footer: { text: `Sala: ${sshash.slice(0, 8)}` },
                timestamp: new Date(evento.timestamp * 1000).toISOString()
            };
        } else {
            // Eventos de jogador (join, leave, switch)
            const j = evento.jogador;
            if (!j) return;
            const fields = [
                { name: 'UID', value: `\`${j.uid}\``, inline: true },
                { name: 'Nick', value: `\`${j.nick}\``, inline: true },
                { name: 'Plataforma', value: `\`${j.plataforma}\``, inline: true }
            ];
            if (j.team) fields.push({ name: 'Time', value: `\`${j.team}\``, inline: true });
            if (j.slot) fields.push({ name: 'Slot', value: `\`${j.slot}\``, inline: true });
            if (evento.de_team && evento.para_team) {
                fields.push({ name: 'De Time', value: `\`${evento.de_team}\``, inline: true });
                fields.push({ name: 'Para Time', value: `\`${evento.para_team}\``, inline: true });
            }
            if (evento.de_slot && evento.para_slot) {
                fields.push({ name: 'De Slot', value: `\`${evento.de_slot}\``, inline: true });
                fields.push({ name: 'Para Slot', value: `\`${evento.para_slot}\``, inline: true });
            }
            embed = {
                title: tipoMap[evento.tipo] || evento.tipo,
                color: colorMap[evento.tipo] || 0x99AAB5,
                fields,
                footer: { text: `Sala: ${sshash.slice(0, 8)}` },
                timestamp: new Date(evento.timestamp * 1000).toISOString()
            };
        }
        axios.post(webhookUrl, { embeds: [embed] }, { timeout: 5000 }).catch(() => { });
    } catch (e) { /* ignore */ }
}

// Loop que coleta eventos de jogadores dos clients e envia webhooks
function _iniciarEventosLoop() {
    setInterval(() => {
        try {
            for (const [sshash, salaInfo] of Object.entries(salasAtivas)) {
                const uidConta = salaInfo.uid_conta;
                if (!(uidConta in roomClientsPool)) continue;
                const client = roomClientsPool[uidConta];
                if (!client.obterEventosJogadores) continue;
                const eventos = client.obterEventosJogadores();
                for (const evento of eventos) {
                    _enviarWebhookEvento(sshash, evento);
                }
            }
        } catch (e) { /* ignore */ }
    }, 1000);
}

function handleStatus(data) {
    const now = Date.now() / 1000;
    if (_statusCache && (now - _statusCacheTime) < 2) {
        systemStats.total_requests_api++;
        systemStats.success_requests_api++;
        return [_statusCache, 200];
    }
    const contasInfo = [];
    let contasReconectando = 0;
    for (const [uid, dataAcc] of Object.entries(roomAccountsData)) {
        let online = false, emSala = false, reconectando = false, chatConectado = false;
        if (uid in roomClientsPool) {
            const client = roomClientsPool[uid];
            online = client.running && !client.reconectando;
            emSala = dataAcc.status_api === 'em_uso';
            reconectando = client.reconectando || false;
            chatConectado = client.chatConectado || false;
            if (reconectando) contasReconectando++;
        }
        contasInfo.push({
            account_id: dataAcc.account_id || 'N/A',
            nickname: dataAcc.nick || 'N/A',
            online, em_sala: emSala, reconectando, chat_conectado: chatConectado
        });
    }
    const contasOnline = contasInfo.filter(c => c.online).length;
    const contasDisponiveis = contasInfo.filter(c => c.online && !c.em_sala).length;
    let botStatus = "online";
    let estimativaSegundos = 0;
    if (contasOnline === 0) {
        if (contasReconectando > 0) { botStatus = "reconectando"; estimativaSegundos = 30; }
        else { botStatus = "offline"; estimativaSegundos = 60; }
    } else if (contasDisponiveis === 0 && contasReconectando > 0) {
        botStatus = "parcial"; estimativaSegundos = 15;
    }

    // Obter estatísticas dinâmicas do watchdog (tcpbot)
    let watchdogStats = { geradorApiEmAndamento: false, contasSubstituidas: 0, contasBlacklistSize: 0, standbyQueueLength: 0, contasErro: 0, maxConcurrent: 0 };
    try {
        const tcpbot = require('./tcpbot');
        if (tcpbot && typeof tcpbot.getWatchdogStats === 'function') {
            watchdogStats = tcpbot.getWatchdogStats();
        }
    } catch (e) {
        Logger.erro("BRIDGE", "Erro ao obter getWatchdogStats do tcpbot: " + e.message);
    }

    systemStats.total_requests_api++;
    systemStats.success_requests_api++;
    const pstats = obterPersistentStats();
    const result = {
        status: "OK", bot_status: botStatus, estimativa_segundos: estimativaSegundos,
        total_contas: contasInfo.length, pool_total: Object.keys(roomClientsPool).length,
        contas_online: contasOnline, contas_disponiveis: contasDisponiveis,
        contas_reconectando: contasReconectando, contas_standby: watchdogStats.standbyQueueLength,
        total_salas_criadas: pstats.total_salas_criadas || 0,
        total_salas_iniciadas: pstats.total_salas_iniciadas || 0,
        salas_ativas_no_momento: contasInfo.filter(c => c.online && c.em_sala).length,
        contas_blacklist: watchdogStats.contasBlacklistSize,
        gerador_em_andamento: watchdogStats.geradorApiEmAndamento,
        contas_substituidas: watchdogStats.contasSubstituidas,
        max_concurrent: watchdogStats.maxConcurrent || 0,
        contas: contasInfo
    };
    _statusCache = result;
    _statusCacheTime = Date.now() / 1000;
    return [result, 200];
}

function handleInfoSystem(data) {
    const now = Date.now() / 1000;
    if (_infoCache && (now - _infoCacheTime) < 3) return [_infoCache, 200];
    const uptimeSeconds = Math.floor(now - systemStats.start_time);
    const dias = Math.floor(uptimeSeconds / 86400);
    const horas = Math.floor((uptimeSeconds % 86400) / 3600);
    const minutos = Math.floor((uptimeSeconds % 3600) / 60);
    const segundos = uptimeSeconds % 60;
    let uptimeStr;
    if (dias > 0) uptimeStr = `${dias}d ${horas}h ${minutos}m`;
    else if (horas > 0) uptimeStr = `${horas}h ${minutos}m ${segundos}s`;
    else uptimeStr = `${minutos}m ${segundos}s`;
    let botsOnline = 0, botsTotal = 0;
    const poolTotal = Object.keys(roomClientsPool).length;
    for (const [uid, dataAcc] of Object.entries(roomAccountsData)) {
        botsTotal++;
        if (uid in roomClientsPool && roomClientsPool[uid].isConnected()) botsOnline++;
    }
    const totalBot = systemStats.total_requests_bot;
    const successBot = systemStats.success_requests_bot;
    const totalApi = systemStats.total_requests_api;
    const successApi = systemStats.success_requests_api;
    const taxaBot = totalBot > 0 ? Math.round((successBot / totalBot) * 10000) / 100 : 100.0;
    const taxaApi = totalApi > 0 ? Math.round((successApi / totalApi) * 10000) / 100 : 100.0;
    const result = {
        status: "OK", bots_online: botsOnline, bots_total: botsTotal, pool_total: poolTotal,
        uptime: uptimeStr, uptime_seconds: uptimeSeconds,
        taxa_sucesso_bot: taxaBot, taxa_sucesso_api: taxaApi,
        bot_status: botsOnline > 0 ? "Funcionando" : "Offline", bot_ok: botsOnline > 0,
        api_status: "Funcionando", api_ok: true
    };
    _infoCache = result;
    _infoCacheTime = Date.now() / 1000;
    return [result, 200];
}

async function handleCreateRoom(data) {
    const oauthKey = data.oauth_key || "";
    let modo = data.modo || 1;
    let senha = data.senha || "";
    let nome = data.nome || "";
    const roomImage = data.room_image || false;
    const keyColorOnImage = data.keyColorOnImage || '#FFD700';
    if (!nome) nome = `Salinha${Math.floor(Math.random() * 999999) + 1}`;
    modo = parseInt(modo);
    if (isNaN(modo)) return [{ status: "MODO_INVALIDO", msg: "Modo deve ser um numero inteiro (1-7)" }, 400];
    if (![1, 2, 3, 4, 5, 6].includes(modo)) return [{ status: "MODO_INVALIDO", msg: "Modo deve ser de 1 a 6" }, 400];
    if (senha && !/^\d+$/.test(String(senha))) return [{ status: "SENHA_INVALIDA", msg: "Senha deve conter somente numeros" }, 400];
    senha = String(senha);
    systemStats.total_requests_bot++;
    const maxTentativas = Math.max(10, Object.keys(roomClientsPool).length);
    const contasTentadas = new Set();
    let ultimoErro = "sem_contas";
    for (let tentativa = 0; tentativa < maxTentativas; tentativa++) {
        const selectedUid = obterContaDisponivel(contasTentadas);
        if (!selectedUid) {
            if (tentativa < maxTentativas - 1 && contasTentadas.size < Object.keys(roomClientsPool).length) continue;
            break;
        }
        contasTentadas.add(selectedUid);
        const client = roomClientsPool[selectedUid];
        if (!client || !client.isConnected() || client.reconectando) continue;
        marcarContaEmUso(selectedUid);
        try {
            if (!client.isConnected()) {
                liberarConta(selectedUid);
                continue;
            }
            const [roomId, error] = await client.criarSala(modo, senha, nome);
            if (roomId) {
                const sshash = gerarSshash();
                const agora = Date.now() / 1000;
                let autoStartBr = 5.0;
                if (data.auto_start_min) {
                    const parsed = parseFloat(data.auto_start_min);
                    if (!isNaN(parsed) && parsed > 0) autoStartBr = parsed;
                }
                const modoCriadoMap = {
                    1: "Full Ouro",
                    2: "Gel Infinito",
                    3: "Full Capa",
                    4: "Com Carregamento",
                    5: "Full UMP/XM8 Normal",
                    6: "Full UMP/XM8 Infinito",
                    7: "Speed 7 rounds"
                };
                const nomeModo = data.mode_name || data.modo_nome || modoCriadoMap[modo] || `Modo ${modo}`;
                salasAtivas[sshash] = {
                    room_id: String(roomId), uid_conta: selectedUid, modo, modo_nome: nomeModo, senha, nome,
                    created_at: obterHoraBrasilia(), created_timestamp: agora,
                    estado: "ESPERANDO_COMECAR", last_update: agora,
                    partida_iniciada: false, partida_iniciada_timestamp: null,
                    oauth_key: oauthKey, saldo_devolvido: false,
                    auto_start_min: autoStartBr
                };
                salvarSalasDb();
                setImmediate(() => enviarWebhookSalaCriada(roomId, modo, sshash, senha, nome, oauthKey));
                let roomQrCode = null, roomCodeVal = null;
                for (let i = 0; i < 5; i++) {
                    roomQrCode = client.obterRoomQrCode ? client.obterRoomQrCode() : null;
                    if (roomQrCode) {
                        roomCodeVal = client.obterRoomCode ? client.obterRoomCode() : null;
                        break;
                    }
                    await new Promise(r => setTimeout(r, 100));
                }
                let roomLink = null;
                if (roomQrCode) {
                    roomLink = `https://ffshare.garena.com/?region=BR&lang=pt-br&action=qrcode_room_invite_link&room_id=${roomId}&qr_serect_code=${roomQrCode}&version=OB55`;
                }
                const resp = {
                    status: "SALA_CRIADA", msg: "sala criada com sucesso",
                    sshash, room_id: String(roomId), senha,
                    modoCriado: modoCriadoMap[modo] || "desconhecido",
                    room_qr_code: roomQrCode, room_link: roomLink,
                    auto_start_min: autoStartBr
                };
                if (roomImage && imageRoom) {
                    try {
                        await imageRoom.gerarImagemSala(String(roomId), senha, sshash, keyColorOnImage);
                        resp.image_url = `${BRIDGE_BASE_URL}/bridge/image-room/room_${sshash}.png`;
                        Logger.info(`[IMAGE_ROOM] Imagem gerada para sala ${sshash.slice(0, 8)}`);
                    } catch (imgErr) {
                        Logger.erro('IMAGE_ROOM', `Erro ao gerar imagem: ${imgErr.message}`);
                    }
                } else if (roomImage) {
                    resp.ImagemUrl = `/api/v2/image-room?sshash=${sshash}`;
                }
                systemStats.success_requests_bot++;
                systemStats.total_salas_criadas++;
                incrementarStat('total_salas_criadas');
                return [resp, 200];
            } else {
                ultimoErro = String(error);
                liberarConta(selectedUid);
                if (error && (String(error).includes('erro 4') || String(error).includes('partida'))) {
                    Logger.aviso('BRIDGE', `[AUTO-DESBUGAR] Conta ${selectedUid} tomou ${error}. Acionando desbugar em background e tentando outra conta...`);
                    desbugarContaBackground(client, selectedUid);
                }
                if (tentativa < maxTentativas - 1) continue;
                devolverUsoKey(oauthKey);
                return [{ status: "ERRO_BOTS", msg: `Falha ao criar sala: ${error}`, retry: true, devolvido: false }, 500];
            }
        } catch (e) {
            ultimoErro = e.message;
            liberarConta(selectedUid);
            if (tentativa < maxTentativas - 1) continue;
            devolverUsoKey(oauthKey);
            return [{ status: "ERRO_BOTS", msg: e.message }, 500];
        }
    }
    devolverUsoKey(oauthKey);
    return [{ status: "ERRO_BOTS", msg: `Falha apos multiplas tentativas: ${ultimoErro}` }, 500];
}

function handleInfoRoom(data) {
    const sshash = data.sshash || "";
    if (!sshash) return [{ status: "SSHASH_INVALIDO", msg: "Parametro 'sshash' e obrigatorio" }, 400];
    if (!(sshash in salasAtivas)) return [{ status: "SSHASH_INVALIDO", msg: "sshash nao encontrado" }, 404];
    const salaInfo = { ...salasAtivas[sshash] };
    const roomId = salaInfo.room_id;
    const uidConta = salaInfo.uid_conta;
    let jogadores = {};
    let roomQrCode = null, roomCode = null;
    if (uidConta in roomClientsPool) {
        const client = roomClientsPool[uidConta];
        jogadores = client.obterJogadores();
        roomQrCode = client.obterRoomQrCode ? client.obterRoomQrCode() : null;
        roomCode = client.obterRoomCode ? client.obterRoomCode() : null;
    }
    const playersList = [];
    for (const [playerId, playerData] of Object.entries(jogadores)) {
        if (typeof playerData === 'object' && playerData !== null) {
            playersList.push({
                id: String(playerId),
                nickname: playerData.nick || 'N/A',
                plataforma: playerData.plataforma || 'mobile',
                versao_ff: playerData.versao_ff || 'desconhecido',
                emulator_score: playerData.emulator_score || 0,
                team: playerData.team || 0,
                team_name: playerData.team_name || '',
                slot: playerData.slot || 0
            });
        } else {
            playersList.push({ id: String(playerId), nickname: String(playerData), plataforma: "desconhecido", versao_ff: "desconhecido", emulator_score: 0, team: 0, team_name: '', slot: 0 });
        }
    }
    let roomLink = null;
    if (roomId && roomQrCode) {
        roomLink = `https://ffshare.garena.com/?region=BR&lang=pt-br&action=qrcode_room_invite_link&room_id=${roomId}&qr_serect_code=${roomQrCode}&version=OB55`;
    }
    return [{
        status: "INFO_OBTIDA",
        room: {
            id: String(roomId), nome: salaInfo.nome || "Desconhecida",
            modo: salaInfo.modo, senha: salaInfo.senha || null,
            estado: salaInfo.estado, created_at: salaInfo.created_at,
            aguardando_reconexao: salaInfo.aguardando_reconexao || false,
            iniciar_ao_reconectar: salaInfo.iniciar_ao_reconectar || false,
            room_qr_code: roomQrCode, room_link: roomLink
        },
        players: playersList,
        totalPlayers: playersList.length
    }, 200];
}

function handleSetWebhook(data) {
    const sshash = data.sshash || "";
    const webhookUrl = data.webhook_url || "";
    const oauthKey = data.oauth_key || "";
    if (!sshash) return [{ status: "ERRO", msg: "Parametro 'sshash' e obrigatorio" }, 400];
    if (!(sshash in salasAtivas)) return [{ status: "SSHASH_INVALIDO", msg: "sshash nao encontrado" }, 404];
    if (oauthKey && salasAtivas[sshash].oauth_key && salasAtivas[sshash].oauth_key !== oauthKey) {
        return [{ status: "ERRO", msg: "Essa sala nao pertence a essa key" }, 403];
    }
    if (!webhookUrl) {
        delete _webhooksPorSala[sshash];
        return [{ status: "OK", msg: "Webhook removido da sala" }, 200];
    }
    _webhooksPorSala[sshash] = webhookUrl;
    return [{ status: "OK", msg: "Webhook configurado para a sala", sshash, webhook_url: webhookUrl }, 200];
}

function handleGetEvents(data) {
    const sshash = data.sshash || "";
    if (!sshash) return [{ status: "ERRO", msg: "Parametro 'sshash' e obrigatorio" }, 400];
    if (!(sshash in salasAtivas)) return [{ status: "SSHASH_INVALIDO", msg: "sshash nao encontrado" }, 404];
    const uidConta = salasAtivas[sshash].uid_conta;
    let eventos = [];
    if (uidConta in roomClientsPool) {
        const client = roomClientsPool[uidConta];
        if (client.obterEventosJogadores) {
            eventos = client.obterEventosJogadores();
        }
    }
    return [{ status: "OK", events: eventos, total: eventos.length }, 200];
}

async function handleStartRoom(data) {
    const sshash = data.sshash || "";
    if (!sshash) return [{ status: "SSHASH_INVALIDO", msg: "Parametro 'sshash' e obrigatorio" }, 400];
    if (!(sshash in salasAtivas)) return [{ status: "SSHASH_INVALIDO", msg: "sshash nao encontrado" }, 404];
    const salaInfo = salasAtivas[sshash];
    const estadoSala = salaInfo.estado || "";
    if (estadoSala === "SALA_INICIADA" && salaInfo.partida_iniciada) {
        const ts = salaInfo.partida_iniciada_timestamp;
        if (ts && (Date.now() / 1000) - ts < 300) {
            const tsFormatado = ts ? new Date(ts * 1000).toISOString() : "N/A";
            return [{ status: "JA_INICIADA", msg: "Partida ja foi iniciada anteriormente", iniciada_em: tsFormatado, timestamp: ts, success: "ok" }, 200];
        }
        salaInfo.estado = "ESPERANDO_COMECAR";
        salaInfo.partida_iniciada = false;
        salaInfo.inicio_em_andamento = false;
        Logger.sistema(`[GO-API] Sala ${sshash.slice(0, 8)}: estado SALA_INICIADA mas timestamp invalido, resetando`);
    }
    if (estadoSala === "COMECANDO" && salaInfo.inicio_em_andamento) {
        return [{ status: "INICIO_EM_ANDAMENTO", msg: "Sala esta sendo iniciada, aguarde..." }, 202];
    }
    if (salaInfo.saldo_devolvido) {
        return [{ status: "SALDO_DEVOLVIDO", msg: "Saldo desta sala ja foi devolvido, crie uma nova sala" }, 400];
    }
    const roomId = salaInfo.room_id;
    const uidConta = salaInfo.uid_conta;
    const createdTime = salaInfo.created_timestamp || Date.now() / 1000;
    const timeoutMinutos = 15;
    if ((Date.now() / 1000) - createdTime > timeoutMinutos * 60) {
        if (sshash in salasAtivas && !salasAtivas[sshash].saldo_devolvido) {
            salasAtivas[sshash].estado = "TIMEOUT_15MIN";
            salasAtivas[sshash].msg_timeout = `Sala expirou apos ${timeoutMinutos} minutos`;
            salasAtivas[sshash].saldo_devolvido = true;
        }
        salvarSalasDb();
        return [{ status: "TIMEOUT_15MIN", msg: `Sala expirou apos ${timeoutMinutos} minutos. Crie uma nova sala.` }, 400];
    }
    if (!(uidConta in roomClientsPool)) {
        salasAtivas[sshash].aguardando_reconexao = true;
        salasAtivas[sshash].iniciar_ao_reconectar = true;
        salvarSalasDb();
        return [{ status: "BOT_RECONECTANDO", msg: "Bot reconectando, sala sera iniciada automaticamente ao reconectar", aguardando_reconexao: true }, 202];
    }
    const client = roomClientsPool[uidConta];
    if (!client.isConnected() || client._emReconexaoCompleta || client.reconectando) {
        salasAtivas[sshash].aguardando_reconexao = true;
        salasAtivas[sshash].iniciar_ao_reconectar = true;
        salvarSalasDb();
        return [{ status: "BOT_RECONECTANDO", msg: "Bot reconectando, sala sera iniciada automaticamente ao reconectar", aguardando_reconexao: true }, 202];
    }
    let enviarMsg = data.enviar_msg !== undefined ? data.enviar_msg : true;
    if (typeof enviarMsg === 'string') enviarMsg = !['false', '0', 'no'].includes(enviarMsg.toLowerCase());
    const agora = Date.now() / 1000;
    salasAtivas[sshash].estado = "COMECANDO";
    salasAtivas[sshash].last_update = agora;
    salasAtivas[sshash].inicio_em_andamento = true;
    salvarSalasDb();

    // Execute background (fire and forget)
    (async () => {
        const maxTentativas = 5;
        let ultimaErro = null;
        const inicioGlobal = Date.now() / 1000;
        const timeoutGlobal = 120;
        for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
            try {
                if ((Date.now() / 1000) - inicioGlobal > timeoutGlobal) {
                    ultimaErro = `timeout global ${timeoutGlobal}s excedido`;
                    Logger.erro('auto-go', `Timeout global de ${timeoutGlobal}s para sala ${sshash.slice(0, 8)}`);
                    break;
                }
                if (!(sshash in salasAtivas)) return;
                const salaCheck = salasAtivas[sshash];
                if (salaCheck.partida_iniciada || salaCheck.estado === "SALA_INICIADA") return;
                if (salaCheck.saldo_devolvido || ["CANCELADA", "TIMEOUT_15MIN"].includes(salaCheck.estado)) return;
                Logger.info(`[AUTO-GO] Tentativa ${tentativa}/${maxTentativas} para sala ${sshash.slice(0, 8)} (room ${roomId})`);
                let cli = roomClientsPool[uidConta];
                if (!cli || !cli.isConnected() || !cli.running || cli._emReconexaoCompleta || cli.reconectando) {
                    Logger.info(`[AUTO-GO] Bot ${uidConta} desconectado/reconectando na tentativa ${tentativa}, aguardando reconexao 30s...`);
                    let reconectou = false;
                    for (let espera = 0; espera < 30; espera++) {
                        await new Promise(r => setTimeout(r, 1000));
                        cli = roomClientsPool[uidConta];
                        if (cli && cli.isConnected() && cli.running && !cli._emReconexaoCompleta && !cli.reconectando) {
                            Logger.info(`[AUTO-GO] Bot ${uidConta} reconectou apos ${espera + 1}s`);
                            reconectou = true;
                            break;
                        }
                    }
                    if (!reconectou) { ultimaErro = "bot_desconectado"; continue; }
                }
                if (cli._writerOk && !cli._writerOk()) {
                    Logger.info(`[AUTO-GO] Writer do bot morto na tentativa ${tentativa}, aguardando 10s...`);
                    await new Promise(r => setTimeout(r, 10000));
                    cli = roomClientsPool[uidConta];
                    if (!cli || (cli._writerOk && !cli._writerOk())) { ultimaErro = "writer_morto"; continue; }
                }
                // Pre-GO: verificar token e conexao antes de iniciar (TODA tentativa)
                if (cli.verificarEPreparar) {
                    try {
                        const pronto = await cli.verificarEPreparar();
                        if (!pronto) {
                            Logger.info(`[AUTO-GO] Pre-GO tentativa ${tentativa}: bot nao esta pronto, tentando continuar...`);
                        }
                        // Refresh client reference after possible reconnection
                        if (uidConta in roomClientsPool) cli = roomClientsPool[uidConta];
                    } catch (e) {
                        Logger.info(`[AUTO-GO] Pre-GO check falhou tentativa ${tentativa}: ${e.message}`);
                    }
                }
                const enviarContagemAgora = enviarMsg && (tentativa === 1);
                const [success, error] = await cli.iniciarPartida(roomId, enviarContagemAgora);
                if (success) {
                    if (sshash in salasAtivas) {
                        salasAtivas[sshash].estado = "SALA_INICIADA";
                        salasAtivas[sshash].last_update = Date.now() / 1000;
                        salasAtivas[sshash].partida_iniciada = true;
                        salasAtivas[sshash].partida_iniciada_timestamp = Date.now() / 1000;
                        salasAtivas[sshash].inicio_em_andamento = false;
                        if (clienteModule?.MATCH_BASELINES?.[String(roomId)]) {
                            salasAtivas[sshash].baseline_perfil = clienteModule.MATCH_BASELINES[String(roomId)];
                        }
                    }
                    salvarSalasDb();
                    incrementarStat('total_salas_iniciadas');
                    const jogadoresLista = cli ? cli.obterJogadores() : [];
                    setImmediate(() => enviarWebhookSalaIniciada(roomId, salasAtivas[sshash]?.modo || 0, sshash, jogadoresLista));
                    Logger.info(`[AUTO-GO] Sala ${sshash.slice(0, 8)} iniciada na tentativa ${tentativa}`);
                    // Aguardar 6s para os pacotes de saida da sala/partida serem enviados
                    setTimeout(() => {
                        liberarConta(uidConta);
                        if (_rotacionarContaFn) _rotacionarContaFn(uidConta);
                    }, 6000);
                    return;
                } else {
                    Logger.info(`[AUTO-GO] Falha na tentativa ${tentativa}: ${error}`);
                    ultimaErro = error;
                    if (tentativa < maxTentativas) await new Promise(r => setTimeout(r, 5000));
                }
            } catch (e) {
                Logger.erro('auto-go', `Excecao na tentativa ${tentativa}: ${e.message}`);
                ultimaErro = e.message;
                if (tentativa < maxTentativas) await new Promise(r => setTimeout(r, 5000));
            }
        }
        Logger.erro('auto-go', `Todas as ${maxTentativas} tentativas falharam para sala ${sshash.slice(0, 8)}: ${ultimaErro}`);
        if (sshash in salasAtivas) {
            const ct = salasAtivas[sshash].created_timestamp || Date.now() / 1000;
            const tdc = (Date.now() / 1000) - ct;
            if (tdc < 900) {
                salasAtivas[sshash].estado = "ESPERANDO_COMECAR";
                salasAtivas[sshash].partida_iniciada = false;
                salasAtivas[sshash].inicio_em_andamento = false;
                salasAtivas[sshash].auto_iniciada = false;
                Logger.sistema(`[AUTO-GO] Sala ${sshash.slice(0, 8)}: revertido para ESPERANDO_COMECAR, checker vai tentar de novo`);
            } else {
                salasAtivas[sshash].estado = "FALHA_AO_COMECAR";
                salasAtivas[sshash].last_update = Date.now() / 1000;
                salasAtivas[sshash].partida_iniciada = false;
                salasAtivas[sshash].inicio_em_andamento = false;
                salasAtivas[sshash].error = String(ultimaErro);
                liberarConta(uidConta);
                devolverSaldoSalaSeguro(sshash);
            }
        }
        salvarSalasDb();
    })();

    return [{ status: "PARTIDA_INICIADA", msg: "Partida comecou!", success: "ok" }, 200];
}

function handleCheckRoom(data) {
    const sshash = data.sshash || "";
    if (!sshash) return [{ status: "SSHASH_INVALIDO", msg: "Parametro 'sshash' e obrigatorio" }, 400];
    if (!(sshash in salasAtivas)) return [{ status: "SSHASH_INVALIDO", msg: "sshash nao encontrado" }, 404];
    const salaInfo = { ...salasAtivas[sshash] };
    const uidConta = salaInfo.uid_conta;
    let totalPlayers = 0, botConectado = false;
    if (uidConta in roomClientsPool) {
        const client = roomClientsPool[uidConta];
        botConectado = client.isConnected();
        totalPlayers = Object.keys(client.obterJogadores()).length;
    }
    const response = {
        status_atual: salaInfo.estado || "ESPERANDO_COMECAR",
        roomId: String(salaInfo.room_id || ""),
        totalPlayers, lastUpdate: salaInfo.last_update || 0,
        bot_conectado: botConectado,
        partida_iniciada: salaInfo.partida_iniciada || false,
        partida_iniciada_timestamp: salaInfo.partida_iniciada_timestamp || null,
        aguardando_reconexao: salaInfo.aguardando_reconexao || false,
        iniciar_ao_reconectar: salaInfo.iniciar_ao_reconectar || false
    };
    if (salaInfo.error) response.error = salaInfo.error;
    if (salaInfo.msg_timeout) response.msg_timeout = salaInfo.msg_timeout;
    return [response, 200];
}

async function handleExpulsar(data) {
    const sshash = data.sshash || "";
    let accountId = data.accountid || "";
    if (!accountId) return [{ status: "ERRO", msg: "Parametro 'accountid' e obrigatorio" }, 400];
    if (!sshash) return [{ status: "ERRO", msg: "Parametro 'sshash' e obrigatorio" }, 400];
    accountId = parseInt(accountId);
    if (isNaN(accountId)) return [{ status: "ERRO", msg: "accountid deve ser um numero" }, 400];
    if (!(sshash in salasAtivas)) return [{ status: "SSHASH_INVALIDO", msg: "sshash nao encontrado" }, 404];
    const salaInfo = salasAtivas[sshash];
    const roomId = salaInfo.room_id;
    const uidConta = salaInfo.uid_conta;
    if (!roomId) return [{ status: "ERRO", msg: "Sala sem room_id" }, 400];
    if (!(uidConta in roomClientsPool)) return [{ status: "ERRO", msg: "Bot nao encontrado" }, 400];
    const client = roomClientsPool[uidConta];
    if (!client.isConnected()) return [{ status: "ERRO", msg: "Bot desconectado" }, 400];
    try {
        const [success, error] = await client.expulsarPlayer(accountId, roomId);
        if (success) return [{ status: "EXPULSO", msg: `Jogador ${accountId} expulso da sala`, success: "ok" }, 200];
        else return [{ status: "ERRO", msg: error || "Falha ao expulsar" }, 400];
    } catch (e) {
        return [{ status: "ERRO", msg: e.message }, 500];
    }
}

async function handleCriarSalaSync(data) {
    const oauthKey = data.oauth_key || "";
    const modo = parseInt(data.modo || 1);
    let nome = data.nome || "";
    const senha = data.senha || "";
    let autoStartMin = 5.0;
    if (data.auto_start_min) {
        const parsed = parseFloat(data.auto_start_min);
        if (!isNaN(parsed)) autoStartMin = parsed;
    }
    if (!nome) nome = `Salinha${Math.floor(Math.random() * 999999) + 1}`;

    const maxTentativas = Math.max(10, Object.keys(roomClientsPool).length);
    const contasTentadas = new Set();
    let ultimoErro = "sem_contas";

    for (let tentativa = 0; tentativa < maxTentativas; tentativa++) {
        const selectedUid = obterContaDisponivel(contasTentadas);
        if (!selectedUid) break;
        contasTentadas.add(selectedUid);
        const client = roomClientsPool[selectedUid];
        if (!client || !client.isConnected()) continue;

        marcarContaEmUso(selectedUid);
        try {
            const [roomId, error] = await client.criarSala(modo, senha, nome);
            if (roomId) {
                const sshash = gerarSshash();
                const agora = Date.now() / 1000;
                salasAtivas[sshash] = {
                    room_id: String(roomId), uid_conta: selectedUid, modo, senha, nome,
                    created_at: obterHoraBrasilia(), created_timestamp: agora,
                    estado: "ESPERANDO_COMECAR", last_update: agora,
                    partida_iniciada: false, partida_iniciada_timestamp: null,
                    oauth_key: oauthKey, saldo_devolvido: false,
                    auto_start_min: autoStartMin
                };
                salvarSalasDb();
                setImmediate(() => enviarWebhookSalaCriada(roomId, modo, sshash, senha, nome, oauthKey));
                incrementarStat('total_salas_criadas');
                let roomQrCode = null, roomCodeVal = null;
                for (let i = 0; i < 5; i++) {
                    roomQrCode = client.obterRoomQrCode ? client.obterRoomQrCode() : null;
                    if (roomQrCode) {
                        roomCodeVal = client.obterRoomCode ? client.obterRoomCode() : null;
                        break;
                    }
                    await new Promise(r => setTimeout(r, 100));
                }
                let roomLink = null;
                if (roomQrCode) {
                    roomLink = `https://ffshare.garena.com/?region=BR&lang=pt-br&action=qrcode_room_invite_link&room_id=${roomId}&qr_serect_code=${roomQrCode}&version=OB55`;
                }
                return [{ sucesso: true, sshash, room_id: String(roomId), senha, room_qr_code: roomQrCode, room_link: roomLink, auto_start_min: autoStartMin }, 200];
            } else {
                ultimoErro = String(error);
                liberarConta(selectedUid);
                if (error && (String(error).includes('erro 4') || String(error).includes('partida'))) {
                    Logger.aviso('BRIDGE', `[AUTO-DESBUGAR] Conta ${selectedUid} tomou ${error}. Acionando desbugar em background e tentando outra conta...`);
                    desbugarContaBackground(client, selectedUid);
                }
                continue;
            }
        } catch (e) {
            ultimoErro = e.message;
            liberarConta(selectedUid);
            continue;
        }
    }

    devolverUsoKey(oauthKey);
    return [{ sucesso: false, erro: ultimoErro }, 500];
}

async function handleIniciarSalaSync(data) {
    const sshash = data.sshash || "";
    if (!(sshash in salasAtivas)) return [{ sucesso: false, erro: "sala_nao_encontrada" }, 404];
    const salaInfo = salasAtivas[sshash];
    if (salaInfo.estado === "SALA_INICIADA" && salaInfo.partida_iniciada) {
        const ts = salaInfo.partida_iniciada_timestamp || 0;
        if (ts && (Date.now() / 1000) - ts < 300) {
            return [{ sucesso: true, status: "INICIADA", msg: "ja_iniciada" }, 200];
        }
        salaInfo.estado = "ESPERANDO_COMECAR";
        salaInfo.partida_iniciada = false;
        salaInfo.inicio_em_andamento = false;
        Logger.sistema(`[GO-MANUAL] Sala ${sshash.slice(0, 8)}: estado SALA_INICIADA mas timestamp invalido, resetando`);
    }
    if (salaInfo.saldo_devolvido) return [{ sucesso: false, erro: "saldo_ja_devolvido" }, 400];
    const createdTime = salaInfo.created_timestamp || Date.now() / 1000;
    const timeoutMinSync = 15;
    if ((Date.now() / 1000) - createdTime > timeoutMinSync * 60) {
        salaInfo.estado = "TIMEOUT_15MIN";
        salaInfo.msg_timeout = `Sala expirou apos ${timeoutMinSync} minutos`;
        salaInfo.saldo_devolvido = true;
        salvarSalasDb();
        return [{ sucesso: false, status: "TIMEOUT_15MIN", msg: `Sala expirou apos ${timeoutMinSync} minutos` }, 400];
    }
    const roomId = salaInfo.room_id;
    const uidConta = salaInfo.uid_conta;
    if (!(uidConta in roomClientsPool)) {
        salasAtivas[sshash].aguardando_reconexao = true;
        salasAtivas[sshash].iniciar_ao_reconectar = true;
        salvarSalasDb();
        return [{ sucesso: false, status: "BOT_RECONECTANDO", msg: "Bot reconectando", aguardando_reconexao: true }, 202];
    }
    const client = roomClientsPool[uidConta];
    if (!client.isConnected()) {
        salasAtivas[sshash].aguardando_reconexao = true;
        salasAtivas[sshash].iniciar_ao_reconectar = true;
        salvarSalasDb();
        return [{ sucesso: false, status: "BOT_RECONECTANDO", msg: "Bot reconectando", aguardando_reconexao: true }, 202];
    }
    salasAtivas[sshash].estado = "COMECANDO";
    salasAtivas[sshash].last_update = Date.now() / 1000;
    salasAtivas[sshash].inicio_em_andamento = true;
    salvarSalasDb();
    // Pre-GO: verificar token e conexao
    if (client.verificarEPreparar) {
        try {
            const pronto = await client.verificarEPreparar();
            if (!pronto) Logger.info(`[GO-MANUAL] Pre-GO: bot nao esta pronto, tentando continuar...`);
        } catch (e) {
            Logger.info(`[GO-MANUAL] Pre-GO check falhou: ${e.message}`);
        }
    }
    const jogadoresSnapshot = client ? client.obterJogadores() : {};
    try {
        const [success, error] = await client.iniciarPartida(roomId, true);
        if (success) {
            salasAtivas[sshash].estado = "SALA_INICIADA";
            salasAtivas[sshash].last_update = Date.now() / 1000;
            salasAtivas[sshash].partida_iniciada = true;
            salasAtivas[sshash].partida_iniciada_timestamp = Date.now() / 1000;
            salasAtivas[sshash].inicio_em_andamento = false;
            if (clienteModule?.MATCH_BASELINES?.[String(roomId)]) {
                salasAtivas[sshash].baseline_perfil = clienteModule.MATCH_BASELINES[String(roomId)];
            }
            const salaModo = salasAtivas[sshash].modo || 0;
            salvarSalasDb();
            incrementarStat('total_salas_iniciadas');
            const jogadoresLista = client ? client.obterJogadores() : {};
            const jogadoresFinal = (jogadoresLista && Object.keys(jogadoresLista).length > 0)
                ? jogadoresLista
                : jogadoresSnapshot;
            setImmediate(() => enviarWebhookSalaIniciada(roomId, salaModo, sshash, jogadoresFinal));

            // Separar jogadores por time
            const time1 = [];
            const time2 = [];
            for (const [uidStr, p] of Object.entries(jogadoresFinal)) {
                if (client && String(client.accountId) === String(uidStr)) continue;
                const teamNum = Number(p.team) || (Number(p.slot) > 4 ? 2 : 1);
                const pObj = {
                    uid: uidStr,
                    nick: p.nick || p.nickname || 'Jogador',
                    plataforma: p.plataforma || 'mobile',
                    team: teamNum,
                    slot: p.slot || (teamNum === 2 ? time2.length + 5 : time1.length + 1)
                };
                if (teamNum === 2) time2.push(pObj);
                else time1.push(pObj);
            }

            let cardBase64 = null;
            let time1Enriched = time1;
            let time2Enriched = time2;
            let todosJogadoresEnriched = [...time1, ...time2];

            if (renderSalaIniciadaModule && roomSkillsModule) {
                try {
                    todosJogadoresEnriched = await roomSkillsModule.enrichRoomPlayers([...time1, ...time2], {
                        token: client.token,
                        clientUrl: client.clientUrl,
                        region: client.region || 'BR',
                        timeoutMs: 3500
                    });
                    const enrichedMap = new Map(todosJogadoresEnriched.map(p => [String(p.uid), p]));
                    time1Enriched = time1.map(p => enrichedMap.get(String(p.uid)) || p);
                    time2Enriched = time2.map(p => enrichedMap.get(String(p.uid)) || p);

                    const salaModo = salasAtivas[sshash]?.modo || 1;
                    const modoCriadoMap = {
                        1: "Full Ouro",
                        2: "Gel Infinito",
                        3: "Full Capa",
                        4: "Com Carregamento",
                        5: "Full UMP/XM8 Normal",
                        6: "Full UMP/XM8 Infinito",
                        7: "Speed 7 rounds"
                    };
                    const modeName = salasAtivas[sshash]?.modo_nome || modoCriadoMap[salaModo] || `Modo ${salaModo}`;
                    cardBase64 = await renderSalaIniciadaModule.renderSalaIniciadaImage({
                        roomId: String(roomId),
                        time1: time1Enriched,
                        time2: time2Enriched,
                        modeName: modeName,
                        systemName: 'NEON STORE'
                    });
                    salasAtivas[sshash].imagem_iniciada = cardBase64;
                } catch (cardErr) {
                    Logger.info(`[GO-MANUAL] Falha ao gerar card de habilidades: ${cardErr.message}`);
                }
            }

            // Sanitiza os dados dos jogadores para nao expor caminhos locais do Windows (C:\...) na API
            const cleanFn = (roomSkillsModule && roomSkillsModule.cleanPlayerForApi) ? roomSkillsModule.cleanPlayerForApi : (p => {
                if (!p || typeof p !== 'object') return p;
                const { avatar_icon_path, ...rest } = p;
                if (Array.isArray(rest.skills)) {
                    rest.skills = rest.skills.map(s => {
                        if (!s || typeof s !== 'object') return s;
                        const { icon_path, character_icon_path, source, ...sRest } = s;
                        return sRest;
                    });
                }
                if (rest.pet && typeof rest.pet === 'object') {
                    const { local_path, ...petRest } = rest.pet;
                    rest.pet = petRest;
                }
                return rest;
            });

            const cleanTime1 = time1Enriched.map(cleanFn);
            const cleanTime2 = time2Enriched.map(cleanFn);
            const cleanAll = todosJogadoresEnriched.map(cleanFn);

            salasAtivas[sshash].jogadores_iniciados = cleanAll;

            // Aguardar 6s para os pacotes de saida da sala/partida serem enviados
            setTimeout(() => {
                liberarConta(uidConta);
                if (_rotacionarContaFn) _rotacionarContaFn(uidConta);
            }, 6000);

            return [{
                sucesso: true,
                status: "INICIADA",
                room_id: roomId,
                modo: salaModo,
                modo_nome: salasAtivas[sshash]?.modo_nome || 'Padrão Apostado',
                total_players: cleanAll.length,
                imagem_base64: cardBase64,
                times: {
                    time_1: cleanTime1,
                    time_2: cleanTime2
                },
                players: cleanAll
            }, 200];
        } else {
            const ct = salasAtivas[sshash].created_timestamp || Date.now() / 1000;
            const tdc = (Date.now() / 1000) - ct;
            salasAtivas[sshash].partida_iniciada = false;
            salasAtivas[sshash].inicio_em_andamento = false;
            if (tdc < 840) {
                salasAtivas[sshash].estado = "ESPERANDO_COMECAR";
                salasAtivas[sshash].auto_iniciada = false;
                Logger.sistema(`[GO-MANUAL] Sala ${sshash.slice(0, 8)}: falhou mas revertido para ESPERANDO_COMECAR (${Math.floor(tdc)}s)`);
            } else {
                salasAtivas[sshash].estado = "FALHA_AO_COMECAR";
                salasAtivas[sshash].error = String(error);
                liberarConta(uidConta);
                devolverSaldoSalaSeguro(sshash);
            }
            salvarSalasDb();
            return [{ sucesso: false, erro: String(error) }, 500];
        }
    } catch (e) {
        const ct = salasAtivas[sshash]?.created_timestamp || Date.now() / 1000;
        const tdc = (Date.now() / 1000) - ct;
        if (sshash in salasAtivas) {
            salasAtivas[sshash].partida_iniciada = false;
            salasAtivas[sshash].inicio_em_andamento = false;
            if (tdc < 840) {
                salasAtivas[sshash].estado = "ESPERANDO_COMECAR";
                salasAtivas[sshash].auto_iniciada = false;
            } else {
                salasAtivas[sshash].estado = "FALHA_AO_COMECAR";
                liberarConta(uidConta);
                devolverSaldoSalaSeguro(sshash);
            }
        }
        salvarSalasDb();
        return [{ sucesso: false, erro: e.message }, 500];
    }
}

async function handleCancelRoom(data) {
    const sshash = data.sshash || "";
    if (!sshash) return [{ status: "SSHASH_INVALIDO", msg: "Parametro 'sshash' e obrigatorio" }, 400];
    if (!(sshash in salasAtivas)) return [{ status: "SSHASH_INVALIDO", msg: "sshash nao encontrado" }, 404];
    const salaInfo = salasAtivas[sshash];
    const estado = salaInfo.estado || "";
    if (estado === "SALA_INICIADA") return [{ status: "JA_INICIADA", msg: "Sala ja foi iniciada, nao pode cancelar" }, 400];
    if (estado === "CANCELADA") return [{ status: "JA_CANCELADA", msg: "Sala ja foi cancelada" }, 400];
    if (["TIMEOUT_15MIN", "FALHA_AO_COMECAR", "BOT_DESCONECTOU", "ERRO_BOTS"].includes(estado)) {
        return [{ status: "SALA_ENCERRADA", msg: `Sala ja encerrada com estado: ${estado}` }, 400];
    }
    const roomId = salaInfo.room_id;
    const uidConta = salaInfo.uid_conta;
    if (!roomId) return [{ status: "ERRO", msg: "Sala sem room_id" }, 400];
    if (!(uidConta in roomClientsPool)) {
        salasAtivas[sshash].estado = "CANCELADA";
        salasAtivas[sshash].last_update = Date.now() / 1000;
        salasAtivas[sshash].cancelada_em = Date.now() / 1000;
        salvarSalasDb();
        return [{ status: "CANCELADA", msg: "Sala cancelada (bot offline)", success: "ok" }, 200];
    }
    const client = roomClientsPool[uidConta];
    if (!client.isConnected()) {
        salasAtivas[sshash].estado = "CANCELADA";
        salasAtivas[sshash].last_update = Date.now() / 1000;
        salasAtivas[sshash].cancelada_em = Date.now() / 1000;
        salvarSalasDb();
        liberarConta(uidConta);
        return [{ status: "CANCELADA", msg: "Sala cancelada (bot desconectado)", success: "ok" }, 200];
    }
    try {
        const [success, error] = await client.cancelarSala(roomId);
        if (success) {
            salasAtivas[sshash].estado = "CANCELADA";
            salasAtivas[sshash].last_update = Date.now() / 1000;
            salasAtivas[sshash].cancelada_em = Date.now() / 1000;
            salvarSalasDb();
            liberarConta(uidConta);
            return [{ status: "CANCELADA", msg: "Sala cancelada com sucesso", success: "ok" }, 200];
        } else {
            return [{ status: "ERRO", msg: error || "Falha ao cancelar sala" }, 400];
        }
    } catch (e) {
        return [{ status: "ERRO", msg: e.message }, 500];
    }
}

/**
 * Protocolo de Resultado de Partida via Perfil / Diff (Baseline vs Now)
 * Rota: /bridge/match-scoreboard e /bridge/result-room
 */
async function handle_match_scoreboard(data) {
    try {
        const sshash = data.sshash || "";
        const roomIdInput = data.room_id ? String(data.room_id) : "";

        let salaInfo = null;
        let foundSshash = null;

        if (sshash && sshash in salasAtivas) {
            salaInfo = salasAtivas[sshash];
            foundSshash = sshash;
        } else if (roomIdInput) {
            for (const [hash, s] of Object.entries(salasAtivas)) {
                if (String(s.room_id) === roomIdInput) {
                    salaInfo = s;
                    foundSshash = hash;
                    break;
                }
            }
        } else if (sshash) {
            for (const [hash, s] of Object.entries(salasAtivas)) {
                if (hash.startsWith(sshash)) {
                    salaInfo = s;
                    foundSshash = hash;
                    break;
                }
            }
        }

        const roomId = salaInfo ? String(salaInfo.room_id) : roomIdInput;
        if (!roomId) {
            return [{ status: "ERRO", msg: "Parametro 'sshash' ou 'room_id' e obrigatorio" }, 400];
        }

        // 1. Obter a foto-base (baseline) da sala
        const MATCH_BASELINES = clienteModule?.MATCH_BASELINES || {};
        const baseline = MATCH_BASELINES[roomId] || salaInfo?.baseline_perfil || null;

        if (!baseline || !baseline.players || Object.keys(baseline.players).length === 0) {
            Logger.erro('SCOREBOARD', `Foto-base nao encontrada para sala ${roomId} (sshash: ${foundSshash || sshash})`);
            return [{
                status: "BASELINE_NAO_ENCONTRADA",
                msg: `Foto-base de perfil nao encontrada para a sala ${roomId}. A sala precisa ter sido iniciada pelo bot com a captura de baseline ativa.`,
                room_id: roomId
            }, 404];
        }

        // 2. Obter um client do pool conectado para consultar os stats pós-partida via rede
        let botClient = null;
        if (salaInfo && salaInfo.uid_conta && roomClientsPool[salaInfo.uid_conta]?.isConnected()) {
            botClient = roomClientsPool[salaInfo.uid_conta];
        } else {
            // Pega qualquer bot conectado do pool
            for (const c of Object.values(roomClientsPool)) {
                if (c && c.isConnected && c.isConnected()) {
                    botClient = c;
                    break;
                }
            }
        }

        if (!botClient) {
            return [{
                status: "BOT_INDISPONIVEL",
                msg: "Nenhum bot conectado no momento para consultar o perfil dos jogadores.",
                room_id: roomId
            }, 503];
        }

        // 3. Obter stats pós-partida (now) de cada jogador e calcular o Delta
        const modo = (salaInfo?.modo === 2) ? 'br' : 'cs';
        const playersOut = [];
        const vencedores = [];
        let totalJogaram = 0;

        const uids = Object.keys(baseline.players);
        for (const uid of uids) {
            const pBase = baseline.players[uid];
            const baseStats = pBase.flat_stats || {};

            // Foto 2 (Now) via chamada oficial /GetPlayerTCStats
            let nowStats = {};
            try {
                nowStats = await botClient.obter_stats_jogador(uid, modo);
            } catch (eStats) {
                Logger.erro('SCOREBOARD', `Erro ao buscar now_stats do player ${uid}: ${eStats.message}`);
                nowStats = baseStats;
            }

            // Cálculo do Delta (now - base) no formato K/D/A:
            // cs_4: Kills (K)
            // cs_2: Deaths (D)
            // cs_3: Assists (A)
            // cs_sub_5: Dano
            const kills = Math.max(0, (nowStats.cs_4 || 0) - (baseStats.cs_4 || 0));
            const deaths = Math.max(0, (nowStats.cs_2 || 0) - (baseStats.cs_2 || 0));
            const assists = Math.max(0, (nowStats.cs_3 || 0) - (baseStats.cs_3 || 0));
            const dano = Math.max(0, (nowStats.cs_sub_5 || 0) - (baseStats.cs_sub_5 || 0));
            const vitorias = Math.max(0, (nowStats.wins || 0) - (baseStats.wins || 0));
            const partidas = Math.max(0, (nowStats.games || 0) - (baseStats.games || 0));

            const jogou = (kills > 0 || deaths > 0 || assists > 0 || dano > 0 || partidas >= 1);
            if (jogou) totalJogaram++;
            if (vitorias >= 1) vencedores.push(String(uid));

            playersOut.push({
                uid: String(uid),
                nickname: pBase.nickname || 'N/A',
                team: pBase.team || 1,
                kills: kills,
                deaths: deaths,
                assists: assists,
                dano: dano,
                vitorias: vitorias,
                partidas: partidas,
                deltas: {
                    cs_4: kills,
                    cs_2: deaths,
                    cs_3: assists,
                    cs_sub_5: dano
                }
            });
        }

        let timeVencedor = null;
        let vitoria = null;

        // Se ninguém jogou ainda (partida em andamento ou acabou de iniciar), não define vencedor nem MVP
        if (totalJogaram === 0) {
            vencedores.length = 0;
            for (const p of playersOut) {
                p.vitorias = 0;
            }
        } else {
            // Partida finalizada: determinar time vencedor
            const winsPorTime = {};
            for (const p of playersOut) {
                if (p.vitorias >= 1) {
                    const t = p.team || 1;
                    winsPorTime[t] = (winsPorTime[t] || 0) + p.vitorias;
                }
            }

            if (Object.keys(winsPorTime).length > 0) {
                timeVencedor = Number(Object.keys(winsPorTime).reduce((a, b) => winsPorTime[a] > winsPorTime[b] ? a : b));
            } else {
                // Fallback de time vencedor por kills e dano
                const timeStats = {};
                for (const p of playersOut) {
                    const t = p.team || 1;
                    if (!timeStats[t]) timeStats[t] = { kills: 0, dano: 0 };
                    timeStats[t].kills += p.kills;
                    timeStats[t].dano += (p.deltas?.cs_sub_5 || 0);
                }
                let maiorKills = -1;
                let maiorDano = -1;
                for (const [t, s] of Object.entries(timeStats)) {
                    if (s.kills > maiorKills || (s.kills === maiorKills && s.dano > maiorDano)) {
                        maiorKills = s.kills;
                        maiorDano = s.dano;
                        timeVencedor = Number(t);
                    }
                }
            }

            if (timeVencedor !== null) {
                vitoria = `time ${timeVencedor}`;
                vencedores.length = 0;
                for (const p of playersOut) {
                    if ((p.team || 1) === timeVencedor) {
                        vencedores.push(p.uid);
                        p.vitorias = 1;
                    } else {
                        p.vitorias = 0;
                    }
                }
            }
        }

        // 4. Lógica de MVP:
        // Só calcula se a partida foi jogada
        let mvp = null;
        let mvpNickname = null;
        let mvpKills = 0;

        if (totalJogaram > 0) {
            const candidatosMvp = playersOut.filter(p => p.kills > 0);
            candidatosMvp.sort((a, b) => {
                if (b.kills !== a.kills) return b.kills - a.kills;
                return (b.deltas.cs_sub_5 || 0) - (a.deltas.cs_sub_5 || 0);
            });

            if (candidatosMvp.length > 0) {
                mvp = candidatosMvp[0].uid;
                mvpNickname = candidatosMvp[0].nickname;
                mvpKills = candidatosMvp[0].kills;
            }
        }

        let imagemBase64 = null;
        // A base64 só é gerada quando a partida realmente acabar
        if (totalJogaram > 0 && timeVencedor !== null) {
            try {
                const { gerarCanvasResultado } = require('./scoreboard_canvas');
                const imgRes = await gerarCanvasResultado({
                    vitoria: vitoria,
                    time_vencedor: timeVencedor,
                    room_id: String(roomId),
                    jogaram: totalJogaram,
                    mvp: mvp,
                    players: playersOut
                });
                imagemBase64 = imgRes.dataUri;
            } catch (eCanvas) {
                Logger.erro('SCOREBOARD', `Erro ao gerar canvas de resultado: ${eCanvas.message}`);
            }
        }

        const resultadoFinal = {
            status: "OK",
            vitoria: vitoria,
            time_vencedor: timeVencedor,
            imagem_base64: imagemBase64,
            room_id: String(roomId),
            total: playersOut.length,
            jogaram: totalJogaram,
            mvp: mvp,
            mvp_nickname: mvpNickname,
            mvp_kills: mvpKills,
            vencedores: vencedores,
            players: playersOut
        };

        if (salaInfo) {
            salaInfo.resultado_partida = resultadoFinal;
            salvarSalasDb();
        }

        Logger.executado(`[SCOREBOARD] Sala ${roomId}: Vitória=${vitoria || 'EM ANDAMENTO'}, MVP=${mvpNickname} (${mvpKills} kills), Vencedores=[${vencedores.join(', ')}]`);

        // Disparar webhook se solicitado
        if (data.send_webhook) {
            try {
                const whUrl = _webhooksPorSala[roomId] || salaInfo?.webhook_url || WEBHOOK_JOGADORES;
                if (whUrl) {
                    axios.post(whUrl, { evento: "match_scoreboard", resultado: resultadoFinal }).catch(() => { });
                }
            } catch (eWh) { /* ignore */ }
        }

        return [resultadoFinal, 200];
    } catch (e) {
        Logger.erro('SCOREBOARD', `Excecao ao processar scoreboard: ${e.message}`);
        return [{ status: "ERRO", msg: e.message }, 500];
    }
}

function autoSaveLoop() {
    setInterval(() => {
        try {
            salvarSalasDbSync();
            if (_persistentStatsDirty) {
                _salvarPersistentStats();
                _persistentStatsDirty = false;
            }
        } catch (e) { /* ignore */ }
    }, 60000);
}

async function sairSalaTimeout(client, roomId, uid) {
    try {
        const { criarPacoteSairSala } = require('./pacotes');
        const pacote = criarPacoteSairSala(roomId, client.chave, client.iv);
        if (client.onlineWriter && !client.onlineWriter.destroyed) {
            client.onlineWriter.write(pacote);
        }
    } catch (e) { /* ignore */ }
}

function timeoutCheckerLoop() {
    let healthCheckCounter = 0;
    setInterval(() => {
        try {
            healthCheckCounter++;
            const agora = Date.now() / 1000;
            const duasHoras = 2 * 60 * 60;
            const salasParaTimeout = [];
            const salasParaDeletar = [];
            const salasParaAutoIniciar = [];
            const salasParaSair = [];

            for (const [sshash, sala] of Object.entries(salasAtivas)) {
                const estado = sala.estado || "";
                const createdTime = sala.created_timestamp || agora;
                const tempoDesdeCriacao = agora - createdTime;
                const partidaIniciada = sala.partida_iniciada || false;
                const timeoutSala = 900;

                if (estado === "ESPERANDO_COMECAR" && !partidaIniciada) {
                    const autoStartMin = sala.auto_start_min || 5.0;
                    const autoStartSeconds = autoStartMin * 60;
                    if (tempoDesdeCriacao > timeoutSala) {
                        salasParaTimeout.push(sshash);
                        const uidC = sala.uid_conta;
                        const rid = sala.room_id;
                        if (uidC && rid) salasParaSair.push([uidC, rid]);
                        continue;
                    }
                    if (tempoDesdeCriacao > autoStartSeconds) {
                        const uidConta = sala.uid_conta;
                        const roomId = sala.room_id;
                        if (!roomId) continue;
                        if (sala.partida_iniciada || sala.auto_iniciada || sala.estado !== "ESPERANDO_COMECAR") continue;
                        if (_autoStartEmAndamento.has(sshash)) continue;
                        if (!uidConta || !(uidConta in roomClientsPool)) continue;
                        const cl = roomClientsPool[uidConta];
                        if (cl.isConnected() && !cl.reconectando && !cl._emReconexaoCompleta) {
                            sala.aguardando_reconexao = false;
                            sala.iniciar_ao_reconectar = false;
                            salasParaAutoIniciar.push([sshash, roomId, uidConta, tempoDesdeCriacao]);
                            Logger.info(`[AUTO-GO] Sala ${sshash.slice(0, 8)} room=${roomId} pronta (${Math.floor(tempoDesdeCriacao)}s > ${Math.floor(autoStartSeconds)}s) bot_owner=${uidConta}`);
                        }
                    }
                } else if (estado === "COMECANDO") {
                    if (sala.partida_iniciada) {
                        sala.estado = "SALA_INICIADA";
                        continue;
                    }
                    const partidaTs = sala.partida_iniciada_timestamp || sala.last_update || createdTime;
                    const tempoComecando = agora - partidaTs;
                    // Se o auto-start ou início ainda está em andamento, não interrompe em 30s
                    if (_autoStartEmAndamento.has(sshash) || sala.inicio_em_andamento) {
                        if (tempoComecando > 130) {
                            _autoStartEmAndamento.delete(sshash);
                            sala.inicio_em_andamento = false;
                            sala.estado = "ESPERANDO_COMECAR";
                        }
                        continue;
                    }
                    if (tempoComecando > 90 && tempoDesdeCriacao < timeoutSala) {
                        sala.estado = "ESPERANDO_COMECAR";
                        sala.partida_iniciada = false;
                        sala.partida_iniciada_timestamp = null;
                        sala.auto_iniciada = false;
                        sala.inicio_em_andamento = false;
                        sala.aguardando_reconexao = false;
                        Logger.sistema(`[AUTO-GO] Sala ${sshash.slice(0, 8)} travada em COMECANDO por ${Math.floor(tempoComecando)}s, resetando`);
                    } else if (tempoDesdeCriacao > timeoutSala) {
                        salasParaTimeout.push(sshash);
                    }
                } else if (["TIMEOUT_15MIN", "SALA_INICIADA", "FALHA_AO_COMECAR", "BOT_DESCONECTOU", "ERRO_BOTS"].includes(estado)) {
                    if (tempoDesdeCriacao > duasHoras) salasParaDeletar.push(sshash);
                }
            }

            for (const sshash of salasParaTimeout) {
                if (sshash in salasAtivas) {
                    salasAtivas[sshash].estado = "TIMEOUT_15MIN";
                    salasAtivas[sshash].msg_timeout = "Sala nao comecou nos ultimos 15 minutos";
                    liberarConta(salasAtivas[sshash].uid_conta);
                }
            }
            for (const sshash of salasParaDeletar) {
                if (sshash in salasAtivas) delete salasAtivas[sshash];
            }
            for (const [uidConta, roomId] of salasParaSair) {
                try {
                    if (uidConta in roomClientsPool) {
                        const client = roomClientsPool[uidConta];
                        if (client.isConnected()) sairSalaTimeout(client, roomId, uidConta);
                    }
                } catch (e) { /* ignore */ }
            }
            if (salasParaAutoIniciar.length) {
                Logger.sistema(`[AUTO-GO] Agendando ${salasParaAutoIniciar.length} sala(s) para auto-start`);
            }
            for (const [sshash, roomId, botUid, elapsed] of salasParaAutoIniciar) {
                try {
                    const client = roomClientsPool[botUid];
                    if (!client || !client.isConnected()) continue;
                    if (!(sshash in salasAtivas)) continue;
                    const sala = salasAtivas[sshash];
                    if (sala.partida_iniciada || sala.estado !== "ESPERANDO_COMECAR") continue;
                    salasAtivas[sshash].estado = "COMECANDO";
                    salasAtivas[sshash].last_update = agora;
                    salasAtivas[sshash].inicio_em_andamento = true;
                    salasAtivas[sshash].auto_iniciada = true;
                    salasAtivas[sshash].partida_iniciada_timestamp = agora;
                    _autoStartEmAndamento.add(sshash);
                    const elapsedMin = Math.round(elapsed / 6) / 10;
                    autoIniciarSala(client, roomId, sshash);
                    Logger.sistema(`[AUTO-GO] Agendado: sala ${sshash.slice(0, 8)} (RoomID=${roomId}) apos ${elapsedMin}min`);
                } catch (e) {
                    _autoStartEmAndamento.delete(sshash);
                    if (sshash in salasAtivas) {
                        salasAtivas[sshash].estado = "ESPERANDO_COMECAR";
                        salasAtivas[sshash].inicio_em_andamento = false;
                        salasAtivas[sshash].auto_iniciada = false;
                    }
                }
            }
            for (const sshash of salasParaTimeout) devolverSaldoSalaSeguro(sshash);
            salvarSalasDb();

            if (healthCheckCounter % 3 === 0) {
                for (const [sshash, sala] of Object.entries(salasAtivas)) {
                    try {
                        if (sala.estado !== "ESPERANDO_COMECAR" || sala.partida_iniciada) continue;
                        const uid = sala.uid_conta;
                        if (!uid || !(uid in roomClientsPool)) continue;
                        const cl = roomClientsPool[uid];
                        if (!cl || !cl.isConnected() || !cl.salaCriadaId) continue;
                        // v29: Só reenvia se por algum motivo ainda não tiver sido enviado na criação (evita flood e queda de conexão)
                        if (!cl.espectadorEnviado) {
                            cl.reenviarEspectador();
                        }
                    } catch (e) { /* ignore */ }
                }
            }

            if (healthCheckCounter % 30 === 0) {
                // Health check roda em async separado (setInterval callback nao e async)
                (async () => {
                    try {
                        const botsComSalas = new Set();
                        const agoraHC = Date.now() / 1000;
                        for (const [sshash, sala] of Object.entries(salasAtivas)) {
                            if (sala.estado === "ESPERANDO_COMECAR" && !sala.partida_iniciada && sala.uid_conta) {
                                botsComSalas.add(sala.uid_conta);
                            }
                        }
                        for (const uid of botsComSalas) {
                            try {
                                if (!(uid in roomClientsPool)) continue;
                                const cl = roomClientsPool[uid];
                                if (!cl || !cl.running) continue;
                                // Check 1: heartbeat stale?
                                const hbAge = agoraHC - (cl.lastHeartbeat || 0);
                                if (hbAge > 60) {
                                    Logger.info(`[HEALTH] Bot ${uid} com sala ativa: heartbeat stale (${Math.floor(hbAge)}s). Enviando keepalive...`);
                                    try {
                                        await cl.enviarHeartbeat();
                                    } catch (e) {
                                        Logger.info(`[HEALTH] Bot ${uid}: keepalive erro: ${e.message}`);
                                    }
                                }
                                // Check 2: token expiring soon?
                                if (cl.jwtExp) {
                                    const tempoRestante = cl.jwtExp - agoraHC;
                                    if (tempoRestante < 1800 && tempoRestante > 0) {
                                        // v30: NUNCA renovar token / reconectar enquanto o bot tiver sala ativa!
                                        // Reconectar troca a sessao TCP do anfitriao na Garena e gera "Erro de conexao" para os jogadores tentando entrar.
                                        Logger.info(`[HEALTH] Bot ${uid} com sala ativa: token expira em ${Math.floor(tempoRestante)}s (renovacao aguardando fim da partida)`);
                                    }
                                }
                            } catch (e) {
                                Logger.erro('HEALTH', `Erro no health check do bot ${uid}: ${e.message}`);
                            }
                        }
                        if (botsComSalas.size > 0) {
                            Logger.info(`[HEALTH] Check concluido: ${botsComSalas.size} bot(s) com salas ativas verificados`);
                        }
                    } catch (e) {
                        Logger.erro('HEALTH', `Erro geral no health check: ${e.message}`);
                    }
                })();
            }
        } catch (e) {
            Logger.erro('CHECKER', `Erro no timeout_checker_loop: ${e.message}`);
        }
    }, 10000);
}

async function autoIniciarSala(client, roomId, sshash) {
    let uidConta = null;
    try {
        await _autoIniciarSalaImpl(client, roomId, sshash);
    } finally {
        _autoStartEmAndamento.delete(sshash);
    }
}

async function _autoIniciarSalaImpl(client, roomId, sshash) {
    let uidConta = null;
    if (!(sshash in salasAtivas)) return;
    const sala = salasAtivas[sshash];
    uidConta = sala.uid_conta;
    if (sala.estado === "SALA_INICIADA" || sala.saldo_devolvido) return;
    const maxTentativas = 5;
    let ultimaErro = null;
    const inicioGlobal = Date.now() / 1000;
    const timeoutGlobal = 120;
    for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
        try {
            if ((Date.now() / 1000) - inicioGlobal > timeoutGlobal) {
                ultimaErro = `timeout global ${timeoutGlobal}s excedido`;
                break;
            }
            if (!(sshash in salasAtivas)) return;
            const salaAtual = salasAtivas[sshash];
            if (salaAtual.partida_iniciada || salaAtual.estado === "SALA_INICIADA") return;
            if (salaAtual.saldo_devolvido || ["CANCELADA", "TIMEOUT_15MIN"].includes(salaAtual.estado)) return;
            Logger.info(`[AUTO-START] Tentativa ${tentativa}/${maxTentativas} para sala ${sshash.slice(0, 8)} (room ${roomId})`);
            if (!client.isConnected() || !client.running || client._emReconexaoCompleta || client.reconectando) {
                Logger.info(`[AUTO-START] Bot ${uidConta} desconectado/reconectando, aguardando ate 60s...`);
                let reconectou = false;
                for (let espera = 0; espera < 60; espera++) {
                    await new Promise(r => setTimeout(r, 1000));
                    if (uidConta in roomClientsPool) {
                        const clientAtual = roomClientsPool[uidConta];
                        if (clientAtual.isConnected() && clientAtual.running && !clientAtual._emReconexaoCompleta && !clientAtual.reconectando) {
                            client = clientAtual;
                            Logger.info(`[AUTO-START] Bot ${uidConta} reconectou apos ${espera + 1}s`);
                            reconectou = true;
                            break;
                        }
                    }
                }
                if (!reconectou) { ultimaErro = "bot_owner_desconectado"; continue; }
            }
            if (client._writerOk && !client._writerOk()) {
                await new Promise(r => setTimeout(r, 15000));
                if (uidConta in roomClientsPool) client = roomClientsPool[uidConta];
                if (client._writerOk && !client._writerOk()) { ultimaErro = "writer_owner_morto"; continue; }
            }
            // Pre-GO: verificar token e conexao antes de iniciar (TODA tentativa)
            if (client.verificarEPreparar) {
                try {
                    const pronto = await client.verificarEPreparar();
                    if (!pronto) {
                        Logger.info(`[AUTO-START] Pre-GO tentativa ${tentativa}: bot nao esta pronto, tentando continuar...`);
                    }
                    if (uidConta in roomClientsPool) client = roomClientsPool[uidConta];
                } catch (e) {
                    Logger.info(`[AUTO-START] Pre-GO check falhou tentativa ${tentativa}: ${e.message}`);
                }
            }
            const [success, error] = await client.iniciarPartida(roomId, true);
            if (success) {
                if (sshash in salasAtivas) {
                    salasAtivas[sshash].estado = "SALA_INICIADA";
                    salasAtivas[sshash].last_update = Date.now() / 1000;
                    salasAtivas[sshash].partida_iniciada = true;
                    salasAtivas[sshash].partida_iniciada_timestamp = Date.now() / 1000;
                    salasAtivas[sshash].inicio_em_andamento = false;
                    salasAtivas[sshash].aguardando_reconexao = false;
                    salasAtivas[sshash].iniciar_ao_reconectar = false;
                }
                salvarSalasDb();
                incrementarStat('total_salas_iniciadas');
                const jogadoresLista = client ? client.obterJogadores() : [];
                setImmediate(() => enviarWebhookSalaIniciada(roomId, salasAtivas[sshash]?.modo || 0, sshash, jogadoresLista));
                Logger.sistema(`Auto-start concluido para sala ${sshash.slice(0, 8)} na tentativa ${tentativa}`);
                // Desconecta e libera a conta em 6s (tempo para enviar os pacotes de saida da sala/partida)
                setTimeout(() => {
                    if (uidConta) liberarConta(uidConta);
                    if (_rotacionarContaFn && uidConta) _rotacionarContaFn(uidConta);
                }, 6000);
                return;
            } else {
                Logger.info(`[AUTO-START] Falha na tentativa ${tentativa}: ${error}`);
                ultimaErro = error;
                if (tentativa < maxTentativas) await new Promise(r => setTimeout(r, 5000));
            }
        } catch (e) {
            Logger.erro('auto-start', `Excecao na tentativa ${tentativa}: ${e.message}`);
            ultimaErro = e.message;
            if (tentativa < maxTentativas) await new Promise(r => setTimeout(r, 5000));
        }
    }
    Logger.erro(sshash.slice(0, 8), `Auto-start: todas as ${maxTentativas} tentativas falharam: ${ultimaErro}`);
    if (sshash in salasAtivas) {
        const ct = salasAtivas[sshash].created_timestamp || Date.now() / 1000;
        const tdc = (Date.now() / 1000) - ct;
        if (tdc < 900) {
            salasAtivas[sshash].estado = "ESPERANDO_COMECAR";
            salasAtivas[sshash].partida_iniciada = false;
            salasAtivas[sshash].inicio_em_andamento = false;
            salasAtivas[sshash].auto_iniciada = true;
            salasAtivas[sshash].aguardando_reconexao = false;
            salasAtivas[sshash].iniciar_ao_reconectar = false;
        } else {
            salasAtivas[sshash].estado = "FALHA_AO_COMECAR";
            salasAtivas[sshash].partida_iniciada = false;
            salasAtivas[sshash].inicio_em_andamento = false;
            salasAtivas[sshash].erro = String(ultimaErro);
            salasAtivas[sshash].aguardando_reconexao = false;
            salasAtivas[sshash].iniciar_ao_reconectar = false;
            if (uidConta) liberarConta(uidConta);
        }
    }
    salvarSalasDb();
}

async function processarSalasPendentesReconexao(uidConta) {
    try {
        await new Promise(r => setTimeout(r, 2000));
        if (!(uidConta in roomClientsPool)) return;
        const client = roomClientsPool[uidConta];
        if (!client.isConnected()) return;
        const salasParaIniciar = [];
        const salasAguardandoTimer = [];
        const agora = Date.now() / 1000;
        const quinzeMinutos = 15 * 60;
        for (const [sshash, sala] of Object.entries(salasAtivas)) {
            if (sala.uid_conta !== uidConta) continue;
            if (!sala.iniciar_ao_reconectar) continue;
            if (sala.partida_iniciada && sala.estado === "SALA_INICIADA") continue;
            if (sala.saldo_devolvido) continue;
            const createdTime = sala.created_timestamp || agora;
            const tdc = agora - createdTime;
            if (tdc > quinzeMinutos) {
                sala.estado = "TIMEOUT_15MIN";
                sala.msg_timeout = "Sala expirou durante reconexao";
                sala.saldo_devolvido = true;
                sala.aguardando_reconexao = false;
                sala.iniciar_ao_reconectar = false;
                continue;
            }
            const autoStartMin = sala.auto_start_min || 5.0;
            const autoStartSeconds = autoStartMin * 60;
            if (tdc >= autoStartSeconds) {
                salasParaIniciar.push([sshash, sala.room_id]);
            } else {
                sala.iniciar_ao_reconectar = false;
                sala.aguardando_reconexao = false;
                salasAguardandoTimer.push([sshash, Math.ceil(autoStartSeconds - tdc)]);
                Logger.info(`[RECONEXAO] Sala ${sshash.slice(0, 8)}: faltam ${Math.ceil(autoStartSeconds - tdc)}s para auto-start, aguardando timer`);
            }
        }
        for (const [sshash, roomId] of salasParaIniciar) {
            if (!client.isConnected()) break;
            if (sshash in salasAtivas) {
                salasAtivas[sshash].estado = "COMECANDO";
                salasAtivas[sshash].last_update = agora;
                salasAtivas[sshash].inicio_em_andamento = true;
            }
            salvarSalasDb();
            try {
                await autoIniciarSala(client, roomId, sshash);
            } catch (e) {
                Logger.erro(uidConta, `Erro ao auto-iniciar sala ${sshash.slice(0, 8)}: ${e.message}`);
            }
            await new Promise(r => setTimeout(r, 1000));
        }
        salvarSalasDb();
        if (salasParaIniciar.length) {
            Logger.sistema(`[RECONEXAO] ${uidConta}: ${salasParaIniciar.length} sala(s) pendente(s) iniciada(s)`);
        }
        if (salasAguardandoTimer.length) {
            Logger.sistema(`[RECONEXAO] ${uidConta}: ${salasAguardandoTimer.length} sala(s) aguardando timer de auto-start`);
        }
    } catch (e) {
        Logger.erro(uidConta, `Erro ao processar salas pendentes: ${e.message}`);
    }
}

function validarEConsumirUsoCriarSala(oauthKey) {
    if (!oauthKey) return [false, 'key_invalida'];
    const dados = carregarKeysDb();
    const keys = dados.keys || [];
    for (const keyInfo of keys) {
        if (!keyInfo || typeof keyInfo !== 'object') continue;
        if (keyInfo.key === oauthKey) {
            if (!keyInfo.ativa) {
                return [false, 'key_inativa'];
            }
            if (keyInfo.ilimitada) {
                return [true, keyInfo];
            }
            const limite = parseInt(keyInfo.limite_usos || 0);
            if (limite <= 0) {
                return [true, keyInfo];
            }
            const usosAtuais = parseInt(keyInfo.usos_totais || keyInfo.total_usos || 0);
            if (usosAtuais >= limite) {
                return [false, 'limite_excedido'];
            }
            keyInfo.usos_totais = usosAtuais + 1;
            salvarKeyUnica(keyInfo);
            return [true, keyInfo];
        }
    }
    return [false, 'key_invalida'];
}

async function criarSalaSync(oauthKey, modo, nome = '', senha = '') {
    const [keyValida, resultado] = validarEConsumirUsoCriarSala(oauthKey);
    if (!keyValida) return { sucesso: false, erro: resultado };
    if (!nome) nome = `Salinha${Math.floor(Math.random() * 999999) + 1}`;
    const selectedUid = obterContaDisponivel();
    if (!selectedUid) { devolverUsoKey(oauthKey); return { sucesso: false, erro: 'sem_contas' }; }
    const client = roomClientsPool[selectedUid];
    if (!client || !client.isConnected()) { devolverUsoKey(oauthKey); return { sucesso: false, erro: 'bot_desconectado' }; }
    marcarContaEmUso(selectedUid);
    try {
        const [roomId, error] = await client.criarSala(modo, senha, nome);
        if (roomId) {
            const sshash = gerarSshash();
            const agora = Date.now() / 1000;
            salasAtivas[sshash] = {
                room_id: String(roomId), uid_conta: selectedUid, modo, senha, nome,
                created_at: obterHoraBrasilia(), created_timestamp: agora,
                estado: "ESPERANDO_COMECAR", last_update: agora,
                partida_iniciada: false, partida_iniciada_timestamp: null,
                oauth_key: oauthKey, saldo_devolvido: false,
                auto_start_min: 5.0
            };
            salvarSalasDb();
            setImmediate(() => enviarWebhookSalaCriada(roomId, modo, sshash, senha, nome, oauthKey));
            incrementarStat('total_salas_criadas');
            return { sucesso: true, sshash, room_id: String(roomId), senha };
        } else {
            liberarConta(selectedUid);
            devolverUsoKey(oauthKey);
            return { sucesso: false, erro: String(error) };
        }
    } catch (e) {
        liberarConta(selectedUid);
        devolverUsoKey(oauthKey);
        return { sucesso: false, erro: e.message };
    }
}

async function iniciarSalaSync(sshash) {
    const [result, code] = await handleIniciarSalaSync({ sshash });
    return result;
}

function handleListRooms() {
    return [salasAtivas, 200];
}

function handleSaveRooms(data) {
    if (data && typeof data === 'object') {
        for (const [sshash, salaData] of Object.entries(data)) {
            salasAtivas[sshash] = salaData;
            dbRedis.salvarSala(sshash, salaData);
        }
    }
    return [{ status: "OK" }, 200];
}

function handleSetAutoStart(data) {
    const sshash = data.sshash || "";
    const oauthKey = data.oauth_key || "";
    if (!sshash) return [{ status: "ERRO", msg: "Parametro 'sshash' e obrigatorio" }, 400];
    if (!(sshash in salasAtivas)) return [{ status: "SSHASH_INVALIDO", msg: "sshash nao encontrado" }, 404];
    const salaInfo = salasAtivas[sshash];
    if (oauthKey && salaInfo.oauth_key && salaInfo.oauth_key !== oauthKey) {
        return [{ status: "ERRO", msg: "Essa sala nao pertence a essa key" }, 403];
    }
    const parsed = parseFloat(data.auto_start_min);
    if (isNaN(parsed) || parsed <= 0 || parsed > 60) {
        return [{ status: "ERRO", msg: "auto_start_min deve ser um numero entre 0.1 e 60" }, 400];
    }
    salasAtivas[sshash].auto_start_min = parsed;
    salasAtivas[sshash].last_update = Date.now() / 1000;
    salvarSalasDb();
    Logger.info(`[SET-AUTO-START] Sala ${sshash.slice(0, 8)}: auto_start_min alterado para ${parsed} min`);
    return [{ status: "OK", msg: `Timer de auto-start alterado para ${parsed} minuto(s)`, sshash, auto_start_min: parsed }, 200];
}
async function handleObterCardSala(data) {
    const sshash = data.sshash || "";
    if (sshash && (sshash in salasAtivas)) {
        const sala = salasAtivas[sshash];
        if (sala.imagem_iniciada) {
            return [{
                sucesso: true,
                room_id: sala.room_id,
                imagem_base64: sala.imagem_iniciada,
                players: sala.jogadores_iniciados || []
            }, 200];
        }
    }

    if (renderSalaIniciadaModule) {
        try {
            const time1 = data.time1 || [];
            const time2 = data.time2 || [];
            const roomId = data.room_id || (sshash && salasAtivas[sshash]?.room_id) || '139873280';
            const sala = sshash && salasAtivas[sshash];
            const modoNum = sala?.modo || 1;
            const modoCriadoMap = {
                1: "Full Ouro",
                2: "Gel Infinito",
                3: "Full Capa",
                4: "Com Carregamento",
                5: "Full UMP/XM8 Normal",
                6: "Full UMP/XM8 Infinito",
                7: "Speed 7 rounds"
            };
            const modeName = data.mode_name || data.modo_nome || sala?.modo_nome || modoCriadoMap[modoNum] || `Modo ${modoNum}`;

            const card = await renderSalaIniciadaModule.renderSalaIniciadaImage({
                roomId: String(roomId),
                time1,
                time2,
                modeName,
                systemName: data.system_name || 'NEON STORE'
            });

            return [{
                sucesso: true,
                room_id: roomId,
                imagem_base64: card
            }, 200];
        } catch (e) {
            return [{ sucesso: false, erro: e.message }, 500];
        }
    }
    return [{ sucesso: false, erro: "modulo_render_indisponivel" }, 500];
}

const ROUTE_MAP = {
    "/bridge/status": handleStatus,
    "/bridge/info-system": handleInfoSystem,
    "/bridge/create-room": handleCreateRoom,
    "/bridge/start-room": handleStartRoom,
    "/bridge/info-room": handleInfoRoom,
    "/bridge/check-room": handleCheckRoom,
    "/bridge/expulsar": handleExpulsar,
    "/bridge/cancel-room": handleCancelRoom,
    "/bridge/criar-sala-sync": handleCriarSalaSync,
    "/bridge/iniciar-sala-sync": handleIniciarSalaSync,
    "/bridge/list-rooms": handleListRooms,
    "/bridge/save-rooms": handleSaveRooms,
    "/bridge/set-auto-start": handleSetAutoStart,
    "/bridge/set-webhook": handleSetWebhook,
    "/bridge/get-events": handleGetEvents,
    "/bridge/match-scoreboard": handle_match_scoreboard,
    "/bridge/result-room": handle_match_scoreboard,
    "/bridge/room-card": handleObterCardSala,
};

function iniciarBridge() {
    const server = http.createServer(async (req, res) => {
        const handler = ROUTE_MAP[req.url];
        if (!handler) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "NOT_FOUND" }));
            return;
        }
        let data = {};
        try {
            const body = await new Promise((resolve, reject) => {
                const chunks = [];
                req.on('data', chunk => chunks.push(chunk));
                req.on('end', () => resolve(Buffer.concat(chunks).toString()));
                req.on('error', reject);
            });
            if (body) data = JSON.parse(body);
        } catch (e) { data = {}; }
        try {
            let result = handler(data);
            if (result instanceof Promise) result = await result;
            let respData, code;
            if (Array.isArray(result)) {
                [respData, code] = result;
            } else {
                respData = result;
                code = 200;
            }
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(respData));
        } catch (e) {
            try {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: "BRIDGE_ERROR", msg: e.message }));
            } catch (e2) { /* ignore broken pipe */ }
        }
    });
    server.listen(BRIDGE_PORT, '127.0.0.1', () => {
        Logger.sistema(`Bridge Node.js iniciado em 127.0.0.1:${BRIDGE_PORT}`);
    });
    server.on('error', (e) => {
        Logger.erro("BRIDGE", `Erro ao iniciar bridge: ${e.message}`);
    });
    return server;
}

async function iniciarBridgeThread() {
    // Inicializar Redis antes de carregar salas
    await dbRedis.inicializarRedis();
    const server = iniciarBridge();
    autoSaveLoop();
    timeoutCheckerLoop();
    carregarSalasDb();
    _iniciarEventosLoop();
    return server;
}

module.exports = {
    setRotacaoCallback,
    roomClientsPool,
    salasAtivas,
    systemStats,
    BRIDGE_PORT,
    setRoomLoop,
    getPriorityUids,
    obterContaDisponivel,
    marcarContaEmUso,
    liberarConta,
    contarContasConectadas,
    devolverUsoKey,
    devolverSaldoSalaSeguro,
    salvarSalasDb,
    salvarSalasDbSync,
    carregarSalasDb,
    carregarKeysDb,
    salvarKeysDb,
    salvarKeyUnica,
    incrementarStat,
    obterPersistentStats,
    handleStatus,
    handleInfoSystem,
    handleCreateRoom,
    handleStartRoom,
    handleInfoRoom,
    handleCheckRoom,
    handleExpulsar,
    handleCancelRoom,
    handleCriarSalaSync,
    handleIniciarSalaSync,
    iniciarBridge,
    iniciarBridgeThread,
    validarEConsumirUsoCriarSala,
    criarSalaSync,
    iniciarSalaSync,
    processarSalasPendentesReconexao,
    autoIniciarSala,
    handle_match_scoreboard,
};
