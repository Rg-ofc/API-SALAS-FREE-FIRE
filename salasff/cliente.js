const _CLIENTE_VERSION = 'v25_99uptime_20260329';
try { require('fs').appendFileSync('/tmp/debug_field4.log', `\n=== CLIENTE.JS LOADED: ${_CLIENTE_VERSION} at ${new Date().toISOString()} ===\n`); } catch (e) { }

const net = require('net');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const axios = require('axios').default || require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');

const {
    Logger, roomAccountsData, marcarRoomDirty,
    criptografarPacote, decParaHex, garantirBytes, obterUserAgentAleatorio,
    buildGetBackpackPayload, buildUpdateBioPayload
} = require('./utils');
const {
    criarPacoteMajorLogin, criarPacoteEntrarSalaSpec,
    criarPacoteSairSala, criarPacoteComecarSala,
    criarPacoteConfirmarInicio, criarPacoteSairPartida,
    obterSalaDisponivel, obterSalaDisponivelComRepeated,
    criarPacoteVirarEspectador,
    criarPacoteExpulsarPlayer
} = require('./pacotes');
const dbSqlite = require('./db_postgres');

const _RE_SESSION = /a2021e([0-9a-f]{60})/;
const _HEARTBEAT_BYTES = Buffer.from("0205", "hex");
const _PREFIX_0E00 = Buffer.from("0e00", "hex");
const _PREFIX_0515 = Buffer.from("0515", "hex");
const _PREFIX_0514 = Buffer.from("0514", "hex");
const _PREFIX_0519 = Buffer.from("0519", "hex");

let gerarContaCompleta = null;
try { gerarContaCompleta = require('./gerador_contas').gerarContaCompleta; } catch (e) { /* not available */ }

let _tokenCacheData = {};
let _tokenCacheDirty = false;

function _carregarTokenCache() {
    try {
        const data = dbSqlite.carregarInfoAccounts();
        if (data && typeof data === 'object') _tokenCacheData = data;
        else _tokenCacheData = {};
    } catch (e) { _tokenCacheData = {}; }
}

function _salvarTokenCacheDisk() {
    if (!_tokenCacheDirty) return;
    const dataCopy = { ..._tokenCacheData };
    _tokenCacheDirty = false;
    try {
        dbSqlite.salvarTodosInfoAccounts(dataCopy);
    } catch (e) { _tokenCacheDirty = true; }
}

function obterTokenCache(uid) {
    const entry = _tokenCacheData[String(uid)];
    if (entry && !entry.invalidado) {
        const at = entry.accessToken;
        const oi = entry.openID;
        if (at && oi) return [at, oi];
    }
    return [null, null];
}

function salvarTokenCache(uid, password, accessToken, openId) {
    _tokenCacheData[String(uid)] = {
        uid: String(uid), password, accessToken, openID: openId, invalidado: false
    };
    _tokenCacheDirty = true;
}

function invalidarTokenCache(uid) {
    if (String(uid) in _tokenCacheData) {
        _tokenCacheData[String(uid)].invalidado = true;
        _tokenCacheDirty = true;
    }
}

function invalidarTodosTokensCache() {
    let count = 0;
    for (const uidKey of Object.keys(_tokenCacheData)) {
        if (!_tokenCacheData[uidKey].invalidado) {
            _tokenCacheData[uidKey].invalidado = true;
            count++;
        }
    }
    if (count > 0) _tokenCacheDirty = true;
    return count;
}

_carregarTokenCache();
setInterval(() => { try { _salvarTokenCacheDisk(); } catch (e) { /* ignore */ } }, 120000);

// Bio padrao
const BIO_CPX = "Neon Store";

let _reconexoesAtivas = 0;
const _MAX_RECONEXOES_SIMULTANEAS = 10;

const CHAT_DISABLED = true;
const HEARTBEAT_MIN = 30;
const HEARTBEAT_MAX = 45;
const TCP_RCVBUF = 4096;
const TCP_SNDBUF = 2048;

const _PROXY_ENABLED = process.env.PROXY_ENABLED === 'true' || false;
const _PROXY_HOST = process.env.PROXY_HOST || "";
const _PROXY_PORT = parseInt(process.env.PROXY_PORT || "0");
const _PROXY_USER = process.env.PROXY_USER || "";
const _PROXY_PASS = process.env.PROXY_PASS || "";

function carregarProxy() {
    try {
        if (!_PROXY_ENABLED || !_PROXY_HOST) return null;
        return `http://${_PROXY_USER}:${_PROXY_PASS}@${_PROXY_HOST}:${_PROXY_PORT}`;
    } catch (e) { return null; }
}

const PROXY_URL = carregarProxy();
if (_PROXY_ENABLED) {
    Logger.sistema(`[PROXY] Proxy HTTP ativa: ${_PROXY_HOST}:${_PROXY_PORT} (user=${_PROXY_USER.slice(0, 8)}...)`);
} else {
    Logger.sistema("[PROXY] AVISO: Proxy DESATIVADA! Todas as requisicoes HTTP vao direto.");
}

function getAxiosProxyConfig(uid) {
    if (!_PROXY_ENABLED || !_PROXY_HOST) return {};
    let user = _PROXY_USER;
    if (uid && user.includes('__cr.')) {
        user = `${user}__session.${uid}`;
    }
    const proxyUrl = `http://${user}:${_PROXY_PASS}@${_PROXY_HOST}:${_PROXY_PORT}`;
    return {
        httpAgent: new HttpProxyAgent(proxyUrl),
        httpsAgent: new HttpsProxyAgent(proxyUrl),
    };
}

// AES encryption
const KEY = Buffer.from([89, 103, 38, 116, 99, 37, 68, 69, 117, 104, 54, 37, 90, 99, 94, 56]);
const IV = Buffer.from([54, 111, 121, 90, 68, 114, 50, 50, 69, 51, 121, 99, 104, 106, 77, 37]);

function encAes(dataHex) {
    const data = Buffer.from(dataHex, 'hex');
    const cipher = crypto.createCipheriv('aes-128-cbc', KEY, IV);
    cipher.setAutoPadding(true);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    return encrypted.toString('hex');
}

// Dicionário global em memória de baselines de partida por room_id
const MATCH_BASELINES = {};

// Limpeza de baselines antigas (> 4 horas) a cada 30 minutos
setInterval(() => {
    try {
        const agora = Date.now() / 1000;
        for (const rId of Object.keys(MATCH_BASELINES)) {
            const b = MATCH_BASELINES[rId];
            if (b && b.captured_at && (agora - b.captured_at > 14400)) {
                delete MATCH_BASELINES[rId];
            }
        }
    } catch (e) { /* ignore */ }
}, 1800000);

function encodeVarintBig(value) {
    let v = BigInt(value);
    const result = [];
    while (v > 127n) {
        result.push(Number((v & 0x7Fn) | 0x80n));
        v = v >> 7n;
    }
    result.push(Number(v & 0x7Fn));
    return Buffer.from(result);
}

function flat_stats_perfil(fields, isCs = true) {
    const flat = {
        cs_4: 0,      // Kills (K)
        cs_2: 0,      // Deaths (D)
        cs_3: 0,      // Assists (A)
        cs_sub_5: 0,  // Dano
        wins: 0,      // Total Vitorias
        games: 0,     // Total Partidas
        cs_sub_1: 0,  // MVP count
        cs_sub_7: 0,  // Knockdowns
        cs_sub_9: 0,  // Assists raw
        cs_sub_10: 0, // Deaths raw
    };

    if (!fields || typeof fields !== 'object') return flat;

    try {
        if (isCs) {
            // PlayerCSStats response:
            // field 1 = AccountInfoWithTCStats (length-delimited)
            const f1Data = fields[1]?.[0]?.data;
            if (f1Data) {
                const accStats = RoomClient._parseProtobufRaw(f1Data);
                flat.games = Number(accStats[2]?.[0]?.value || 0); // gamesplayed
                flat.wins = Number(accStats[3]?.[0]?.value || 0);  // wins
                flat.cs_4 = Number(accStats[4]?.[0]?.value || 0);  // kills (K)

                // field 5 = DetailedTCStats (length-delimited)
                const f5Data = accStats[5]?.[0]?.data;
                if (f5Data) {
                    const detailed = RoomClient._parseProtobufRaw(f5Data);
                    flat.cs_sub_1 = Number(detailed[1]?.[0]?.value || 0);  // mvpcount
                    flat.cs_sub_5 = Number(detailed[5]?.[0]?.value || 0);  // damage
                    flat.cs_sub_7 = Number(detailed[7]?.[0]?.value || 0);  // knockdowns
                    flat.cs_sub_9 = Number(detailed[9]?.[0]?.value || 0);  // assists
                    flat.cs_sub_10 = Number(detailed[10]?.[0]?.value || 0); // deaths

                    // K/D/A: cs_2 = Death, cs_3 = Assist
                    flat.cs_2 = flat.cs_sub_10; // Deaths (D)
                    flat.cs_3 = flat.cs_sub_9;  // Assists (A)
                }
            }
        } else {
            // BR mode (PlayerStats response):
            // field 1 (solo), 2 (duo), 3 (quad)
            for (const fieldKey of [1, 2, 3]) {
                const subData = fields[fieldKey]?.[0]?.data;
                if (subData) {
                    const modeStats = RoomClient._parseProtobufRaw(subData);
                    flat.games += Number(modeStats[2]?.[0]?.value || 0);
                    flat.wins += Number(modeStats[3]?.[0]?.value || 0);
                    flat.cs_4 += Number(modeStats[4]?.[0]?.value || 0); // kills (K)
                    const detData = modeStats[5]?.[0]?.data;
                    if (detData) {
                        const detailed = RoomClient._parseProtobufRaw(detData);
                        flat.cs_2 += Number(detailed[1]?.[0]?.value || 0); // deaths (D)
                        flat.cs_sub_5 += Number(detailed[8]?.[0]?.value || 0); // BR damage
                        flat.cs_sub_7 += Number(detailed[12]?.[0]?.value || 0);
                    }
                }
            }
        }
    } catch (e) {
        Logger.erro('STATS', `Erro ao parsear flat_stats_perfil: ${e.message}`);
    }

    return flat;
}


// Helper: create a deferred promise (replaces asyncio.Event)
function createEvent() {
    let _resolve;
    let _isSet = false;
    const promise = new Promise(resolve => { _resolve = resolve; });
    return {
        wait: () => promise,
        set: () => { if (!_isSet) { _isSet = true; _resolve(); } },
        isSet: () => _isSet,
        clear: () => { /* recreate */ },
        _recreate: function () {
            _isSet = false;
            const p = new Promise(resolve => { _resolve = resolve; });
            this.wait = () => p;
            this.set = () => { if (!_isSet) { _isSet = true; _resolve(); } };
            this.isSet = () => _isSet;
        }
    };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function waitFor(promise, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs);
        promise.then(val => { clearTimeout(timer); resolve(val); })
            .catch(err => { clearTimeout(timer); reject(err); });
    });
}

class RoomClient {
    constructor(uid, password) {
        this.uid = uid;
        this.password = password;
        this.nickname = null;
        this.accountId = null;
        this.onlineIp = null;
        this.onlinePorta = null;
        this.mainIp = null;
        this.mainPorta = null;
        this.chave = null;
        this.iv = null;
        this.token = null;
        this.tokenBytes = null;
        this.chatTokenBytes = null;
        this.jwtExp = null;
        // TCP sockets
        this.mainSocket = null;
        this.onlineSocket = null;
        // State
        this.running = false;
        this.reconnectDelay = 1;
        this.maxReconnectDelay = 30;
        this.mainReconnectFailures = 0;
        this.onlineReconnectFailures = 0;
        this.lastSuccessfulConnection = Date.now() / 1000;
        this.salaCriadaId = null;
        this.salaCriadaEvent = createEvent();
        this.aguardandoSalaCriada = false;
        this.salaSessionId = null;
        this.salaTimestamp = null;
        this.jogadoresSala = {};
        this.estadoSala = "ESPERANDO_COMECAR";
        this.lastUpdate = null;
        this.roomQrCode = null;
        this.roomCode = null;
        this.lastHeartbeat = Date.now() / 1000;
        this.connectionHealthy = false;
        this.tentativasReconexao = 0;
        this.reconectando = false;
        this.countdownCancelado = false;
        this.chatConectado = false;
        this.temSalaAtiva = false;
        this.espectadorEnviado = false;
        this.partidaIniciadaEvent = createEvent();
        this.aguardandoInicio = false;
        this._reconexaoSucesso = createEvent();
        this._emReconexaoCompleta = false;
        this._retryEmAndamento = false;
        this._ultimaReconexaoCompleta = 0;
        // Intervals/Timeouts
        this._heartbeatInterval = null;
        this._anuncioInterval = null;
        this._countdownTimeout = null;
        this._startPacketsReceived = 0;
        this._confirmacaoEnviada = false;
        // Player tracking com slot/team
        this._eventosJogadores = [];
        this._maxEventos = 200;
    }

    isConnected() {
        try {
            if (!this.running || this.reconectando) return false;
            if (!this.onlineSocket || this.onlineSocket.destroyed) return false;
            if (!this.connectionHealthy) return false;
            const heartbeatTimeout = (this.temSalaAtiva || this.aguardandoInicio) ? 90 : 300; // 90s active (strict), 300s idle (relaxed)
            return (Date.now() / 1000 - this.lastHeartbeat) < heartbeatTimeout;
        } catch (e) { return false; }
    }

    static _lerVarint(data, pos) {
        let valor = 0, shift = 0;
        while (pos < data.length) {
            const b = data[pos]; pos++;
            // Usar multiplicacao em vez de bitwise para suportar numeros > 32 bits
            valor += (b & 0x7F) * Math.pow(2, shift);
            if (!(b & 0x80)) break;
            shift += 7;
        }
        return [valor, pos];
    }

    _extrairRoomInfoFields(pd) {
        const _extrairDeRoomInfo = (roomData) => {
            if (!roomData || typeof roomData !== 'object') return;
            const codeVal = roomData["10"]?.data;
            if (codeVal && typeof codeVal === 'string') this.roomCode = codeVal;
            const qrVal = roomData["40"]?.data;
            if (qrVal && typeof qrVal === 'string') this.roomQrCode = qrVal;
        };
        if (!pd || typeof pd !== 'object') return;
        const f5 = pd["5"]?.data;
        if (f5 && typeof f5 === 'object') _extrairDeRoomInfo(f5);
        const f2 = pd["2"]?.data;
        if (f2 && typeof f2 === 'object') _extrairDeRoomInfo(f2);
        _extrairDeRoomInfo(pd);
        const f33 = pd["33"]?.data;
        if (f33 && typeof f33 === 'string' && !this.roomQrCode) this.roomQrCode = f33;
    }

    // Extrai jogadores com slot e time a partir do RoomInfo parseado com repeated fields
    // Deep search: encontra field 11 (groups) em qualquer nivel de aninhamento
    // Aceita groups com OU sem members (sala vazia tem groups sem field 3)
    // Extrair jogador de um sub-objeto protobuf (RoomPlayerInfo)
    _extrairJogadorDeObjeto(obj) {
        if (!obj || typeof obj !== 'object') return null;
        // RoomPlayerInfo: field 1=uid, field 2=account_id, field 3=nickname(string)
        const f1 = obj["1"]?.data || obj["1"];
        const f2 = obj["2"]?.data || obj["2"];
        const f3 = obj["3"]?.data || obj["3"];
        // Precisa ter nickname como string e um uid valido
        let uid = null, nickname = null;
        if (typeof f3 === 'string' && f3.length > 0) {
            nickname = f3;
            uid = (typeof f2 === 'number' && f2 >= 10000000) ? f2 : ((typeof f1 === 'number' && f1 >= 10000000) ? f1 : null);
        }
        if (!uid || !nickname) return null;
        const emulatorScore = obj["4"]?.data || 0;
        const usingVersion = obj["11"]?.data || 0;
        const plataforma = emulatorScore >= 39 ? 'emulador' : 'mobile';
        const versaoMap = { 0: 'Desconhecido', 1: 'Free Fire Normal', 2: 'Free Fire Max', 3: 'Free Fire India', 4: 'Free Fire Max HPE' };
        const versaoFf = versaoMap[usingVersion] || 'desconhecido';
        return { uid, nick: nickname, plataforma, versao_ff: versaoFf, emulator_score: emulatorScore };
    }

    // Processar pacote 0E00 baseado no field 4 (tipo de notificacao)
    // Retorna { tipo, jogadores, groupsEncontrados }
    _processarPacote0E00(pd) {
        const resultado = { tipo: 'desconhecido', jogadores: [], groupsEncontrados: false };
        if (!pd || typeof pd !== 'object') return resultado;
        const field4Raw = pd["4"]?.data ?? pd["4"];
        const field4 = Number(field4Raw);
        const field5 = pd["5"]?.data || pd["5"];
        // DEBUG v17: trace inside function
        try {
            require('fs').appendFileSync('/tmp/debug_field4.log',
                `  [v17] f4raw=${typeof field4Raw}:${field4Raw} f4num=${field4} f5ok=${!!(field5 && typeof field5 === 'object')}\n`);
        } catch (e) { }
        if (!field5 || typeof field5 !== 'object') return resultado;

        // field 4 = 2: Criacao da sala - groups com members reais
        // field 4 = 21: State update - groups com members (strings vazias = slots vazios, objetos = jogadores)
        if (field4 === 2 || field4 === 21) {
            resultado.tipo = field4 === 2 ? 'criacao' : 'state_update';
            let groups = field5["11"];
            // v17 debug: log field5 keys and groups info
            try {
                const _f5keys = Object.keys(field5).join(',');
                const _hasGroups = !!groups;
                const _groupsIsArr = Array.isArray(groups);
                require('fs').appendFileSync('/tmp/debug_field4.log',
                    `  [v17_GROUPS] f4=${field4} f5keys=[${_f5keys}] hasGroups=${_hasGroups} isArr=${_groupsIsArr}\n`);
            } catch (e) { }
            if (!groups) return resultado;
            if (!Array.isArray(groups)) groups = [groups];
            resultado.groupsEncontrados = true;
            const jogadores = [];
            for (let teamIndex = 0; teamIndex < groups.length; teamIndex++) {
                const group = groups[teamIndex];
                const groupData = group?.data || group;
                if (!groupData || typeof groupData !== 'object') continue;
                const groupName = groupData["2"]?.data || '';
                const groupId = groupData["1"]?.data || 0;
                let members = groupData["3"];
                // v17 debug: log group details
                try {
                    const _gdKeys = groupData ? Object.keys(groupData).join(',') : 'null';
                    const _hasMembers = !!members;
                    const _membersIsArr = Array.isArray(members);
                    const _membersLen = _membersIsArr ? members.length : (members ? 1 : 0);
                    require('fs').appendFileSync('/tmp/debug_field4.log',
                        `  [v17_GROUP${teamIndex}] gdKeys=[${_gdKeys}] name="${groupName}" id=${groupId} hasMembers=${_hasMembers} isArr=${_membersIsArr} len=${_membersLen}\n`);
                } catch (e) { }
                if (!members) continue;
                if (!Array.isArray(members)) members = [members];
                for (let slotIndex = 0; slotIndex < members.length; slotIndex++) {
                    const member = members[slotIndex];
                    const memberData = member?.data || member;
                    // v17 debug: log each member
                    try {
                        const _mType = typeof memberData;
                        const _mKeys = (_mType === 'object' && memberData) ? Object.keys(memberData).join(',') : 'N/A';
                        const _mF1 = memberData?.["1"]?.data || memberData?.["1"];
                        const _mF2 = memberData?.["2"]?.data || memberData?.["2"];
                        const _mF3 = memberData?.["3"]?.data || memberData?.["3"];
                        require('fs').appendFileSync('/tmp/debug_field4.log',
                            `  [v17_MEMBER${teamIndex}.${slotIndex}] type=${_mType} keys=[${_mKeys}] f1=${_mF1} f2=${_mF2} f3=${typeof _mF3 === 'string' ? _mF3.substring(0, 20) : _mF3}\n`);
                    } catch (e) { }
                    // Pular strings vazias (slots vazios no state update)
                    if (!memberData || typeof memberData !== 'object') continue;
                    if (typeof memberData === 'string') continue;
                    // Tentar extrair jogador
                    const jogador = this._extrairJogadorDeObjeto(memberData);
                    // v17 debug: log extraction result
                    try {
                        require('fs').appendFileSync('/tmp/debug_field4.log',
                            `  [v17_EXTRACT${teamIndex}.${slotIndex}] result=${jogador ? `uid=${jogador.uid} nick=${jogador.nick}` : 'null'}\n`);
                    } catch (e) { }
                    if (jogador) {
                        jogador.team = teamIndex + 1;
                        jogador.team_name = (typeof groupName === 'string' && groupName.length > 0) ? groupName : `Time ${teamIndex + 1}`;
                        jogador.slot = slotIndex + 1;
                        jogador.group_id = groupId;
                        jogadores.push(jogador);
                    }
                }
            }
            resultado.jogadores = jogadores;
            return resultado;
        }

        // field 4 = 5: Join notification - jogador no field 5 (sub-objetos)
        if (field4 === 5) {
            resultado.tipo = 'join';
            // Tentar extrair jogador de field5 diretamente ou de sub-campos
            // O jogador pode estar em field5["1"] como sub-objeto com uid/nick
            for (const key of Object.keys(field5)) {
                const val = field5[key];
                const valData = val?.data || val;
                if (valData && typeof valData === 'object' && !Array.isArray(valData)) {
                    const jogador = this._extrairJogadorDeObjeto(valData);
                    if (jogador) {
                        resultado.jogadores.push(jogador);
                    }
                }
            }
            return resultado;
        }

        // field 4 = 25: Switch seat notification - jogador no field 5["2"]
        // v17b: Also extract slot/team info from field5
        if (field4 === 25) {
            resultado.tipo = 'switch_seat';
            // Debug: dump all field5 keys and their types
            try {
                const _f5keys = Object.keys(field5);
                const _f5info = _f5keys.map(k => {
                    const v = field5[k];
                    const vd = v?.data;
                    const vt = v?.wire_type || typeof v;
                    if (typeof vd === 'number') return `f${k}(${vt})=${vd}`;
                    if (typeof vd === 'string' && vd.length < 30) return `f${k}(${vt})="${vd}"`;
                    if (typeof vd === 'object' && vd) return `f${k}(obj,keys=${Object.keys(vd).join('+')})`;
                    return `f${k}(${vt})`;
                });
                require('fs').appendFileSync('/tmp/debug_field4.log',
                    `  [v17_SWITCH_F5] ${_f5info.join(' | ')}\n`);
            } catch (e) { }
            const f2 = field5["2"]?.data || field5["2"];
            if (f2 && typeof f2 === 'object') {
                const jogador = this._extrairJogadorDeObjeto(f2);
                if (jogador) {
                    // Try to find slot/team from field5 structure
                    // field5["1"] might be the RoomInfo with groups showing current assignment
                    const f1 = field5["1"]?.data || field5["1"];
                    if (f1 && typeof f1 === 'object') {
                        // f1 is the RoomInfo - look for groups (field 11)
                        let groups = f1["11"];
                        if (groups) {
                            if (!Array.isArray(groups)) groups = [groups];
                            for (let ti = 0; ti < groups.length; ti++) {
                                const g = groups[ti];
                                const gd = g?.data || g;
                                if (!gd || typeof gd !== 'object') continue;
                                const gName = gd["2"]?.data || '';
                                let members = gd["3"];
                                if (!members) continue;
                                if (!Array.isArray(members)) members = [members];
                                for (let si = 0; si < members.length; si++) {
                                    const m = members[si];
                                    const md = m?.data || m;
                                    if (!md || typeof md !== 'object') continue;
                                    if (typeof md === 'string') continue;
                                    const mUid = md["2"]?.data || md["1"]?.data;
                                    if (mUid === jogador.uid) {
                                        jogador.team = ti + 1;
                                        jogador.team_name = (typeof gName === 'string' && gName.length > 0) ? gName : `Time ${ti + 1}`;
                                        jogador.slot = si + 1;
                                    }
                                }
                            }
                        }
                    }
                    resultado.jogadores.push(jogador);
                }
            }
            return resultado;
        }

        // field 4 = 7: Leave notification
        // O pacote de leave NAO contem o uid de quem saiu, apenas o RoomInfo atualizado
        // Tentamos parsear o RoomInfo (field 5 -> field 2) para ver se tem groups com jogadores restantes
        if (field4 === 7) {
            resultado.tipo = 'leave';
            resultado.groupsEncontrados = false;
            // Tentar encontrar RoomInfo no field 5 -> field 2 ou field 5 -> field 12
            const roomInfo = field5["2"]?.data || field5["2"] || field5["12"]?.data || field5["12"];
            if (roomInfo && typeof roomInfo === 'object') {
                let groups = roomInfo["11"];
                if (groups) {
                    if (!Array.isArray(groups)) groups = [groups];
                    resultado.groupsEncontrados = true;
                    for (let teamIndex = 0; teamIndex < groups.length; teamIndex++) {
                        const group = groups[teamIndex];
                        const groupData = group?.data || group;
                        if (!groupData || typeof groupData !== 'object') continue;
                        const groupName = groupData["2"]?.data || '';
                        const groupId = groupData["1"]?.data || 0;
                        let members = groupData["3"];
                        if (!members) continue;
                        if (!Array.isArray(members)) members = [members];
                        for (let slotIndex = 0; slotIndex < members.length; slotIndex++) {
                            const member = members[slotIndex];
                            const memberData = member?.data || member;
                            if (!memberData || typeof memberData !== 'object') continue;
                            if (typeof memberData === 'string') continue;
                            const jogador = this._extrairJogadorDeObjeto(memberData);
                            if (jogador) {
                                jogador.team = teamIndex + 1;
                                jogador.team_name = (typeof groupName === 'string' && groupName.length > 0) ? groupName : `Time ${teamIndex + 1}`;
                                jogador.slot = slotIndex + 1;
                                jogador.group_id = groupId;
                                resultado.jogadores.push(jogador);
                            }
                        }
                    }
                }
            }
            // Se nao encontrou groups, marcar como leave sem info (vai limpar todos)
            if (!resultado.groupsEncontrados) {
                resultado.leaveAll = true;
            }
            return resultado;
        }

        // Outros field 4: tentar deep search generico
        resultado.tipo = `unknown_${field4}`;
        return resultado;
    }

    // Retorna { jogadores: [...], groupsEncontrados: bool }
    // DEPRECATED - mantido para compatibilidade, agora usa _processarPacote0E00
    _extrairJogadoresComSlotTeam(pd) {
        const resultado = { jogadores: [], groupsEncontrados: false };
        const pktResult = this._processarPacote0E00(pd);
        resultado.jogadores = pktResult.jogadores;
        resultado.groupsEncontrados = pktResult.groupsEncontrados;
        return resultado;
    }

    // Registra evento de jogador e emite para webhook
    _registrarEvento(tipo, jogador, detalhes = {}) {
        const evento = {
            tipo,
            timestamp: Date.now() / 1000,
            jogador: {
                uid: String(jogador.uid),
                nick: jogador.nick,
                plataforma: jogador.plataforma || 'mobile',
                versao_ff: jogador.versao_ff || 'desconhecido',
                emulator_score: jogador.emulator_score || 0,
                team: jogador.team || 0,
                team_name: jogador.team_name || '',
                slot: jogador.slot || 0
            },
            ...detalhes
        };
        this._eventosJogadores.push(evento);
        if (this._eventosJogadores.length > this._maxEventos) {
            this._eventosJogadores = this._eventosJogadores.slice(-this._maxEventos);
        }
    }

    // v22: Registra evento de sala (room_start, etc) - sem jogador individual
    _registrarEventoSala(tipo, detalhes = {}) {
        const evento = {
            tipo,
            timestamp: Date.now() / 1000,
            ...detalhes
        };
        this._eventosJogadores.push(evento);
        if (this._eventosJogadores.length > this._maxEventos) {
            this._eventosJogadores = this._eventosJogadores.slice(-this._maxEventos);
        }
    }

    // Atualiza jogadores comparando estado anterior e gerando eventos
    _atualizarJogadoresComEventos(novosJogadores) {
        const agora = Date.now() / 1000;
        const novosUids = new Set();
        const novoMap = {};
        for (const j of novosJogadores) {
            const uidStr = String(j.uid);
            if (uidStr === String(this.accountId) || j.nick === this.nickname) continue;
            novosUids.add(uidStr);
            novoMap[uidStr] = j;
        }
        // Detectar novos jogadores (JOIN)
        for (const [uidStr, j] of Object.entries(novoMap)) {
            const antigo = this.jogadoresSala[uidStr];
            if (!antigo) {
                this._registrarEvento('player_join', j);
            } else {
                // Detectar mudanca de team
                if (antigo.team && j.team && antigo.team !== j.team) {
                    this._registrarEvento('player_switch_team', j, {
                        de_team: antigo.team,
                        para_team: j.team
                    });
                }
                // Detectar mudanca de slot
                if (antigo.slot && j.slot && antigo.slot !== j.slot) {
                    this._registrarEvento('player_switch_slot', j, {
                        de_slot: antigo.slot,
                        para_slot: j.slot
                    });
                }
            }
        }
        // Detectar jogadores que sairam (LEAVE)
        for (const uidStr of Object.keys(this.jogadoresSala)) {
            if (!novosUids.has(uidStr)) {
                const antigo = this.jogadoresSala[uidStr];
                this._registrarEvento('player_leave', {
                    uid: uidStr,
                    nick: antigo.nick || 'N/A',
                    plataforma: antigo.plataforma || 'mobile',
                    versao_ff: antigo.versao_ff || 'desconhecido',
                    emulator_score: antigo.emulator_score || 0,
                    team: antigo.team || 0,
                    team_name: antigo.team_name || '',
                    slot: antigo.slot || 0
                });
            }
        }
        // Atualizar estado
        const novoEstado = {};
        for (const [uidStr, j] of Object.entries(novoMap)) {
            novoEstado[uidStr] = {
                nick: j.nick,
                plataforma: j.plataforma || 'mobile',
                versao_ff: j.versao_ff || 'desconhecido',
                emulator_score: j.emulator_score || 0,
                team: j.team || 0,
                team_name: j.team_name || '',
                slot: j.slot || 0
            };
        }
        this.jogadoresSala = novoEstado;
        this.lastUpdate = agora;
    }

    extrairJogadoresProtobuf(hexData) {
        const jogadores = [];
        const uidsVistos = new Set();
        try {
            const data = Buffer.from(hexData, 'hex');
            let pos = 0;
            while (pos < data.length - 4) {
                if (data[pos] === 0x08) {
                    let uidPos = pos + 1;
                    let uid1;
                    [uid1, uidPos] = RoomClient._lerVarint(data, uidPos);
                    if (uidPos < data.length - 2 && data[uidPos] === 0x10) {
                        uidPos++;
                        let uid2;
                        [uid2, uidPos] = RoomClient._lerVarint(data, uidPos);
                        if (uidPos < data.length - 1 && data[uidPos] === 0x1a) {
                            uidPos++;
                            const length = data[uidPos];
                            if (length < 0x80 && length >= 1 && length <= 50) {
                                uidPos++;
                                if (uidPos + length <= data.length) {
                                    try {
                                        const nick = data.slice(uidPos, uidPos + length).toString('utf-8');
                                        if (nick && !uidsVistos.has(uid2) && uid2 >= 10000000 && uid2 <= 999999999999) {
                                            uidsVistos.add(uid2);
                                            let extraPos = uidPos + length;
                                            let emulatorScore = 0, usingVersion = 0, lockRegion = '';
                                            const scanLimit = Math.min(extraPos + 300, data.length);
                                            let scanPos = extraPos;
                                            while (scanPos < scanLimit - 1) {
                                                try {
                                                    let tagVal;
                                                    [tagVal, scanPos] = RoomClient._lerVarint(data, scanPos);
                                                    const fieldNum = tagVal >> 3;
                                                    const wireType = tagVal & 0x07;
                                                    if (fieldNum === 1 && wireType === 0 && emulatorScore !== 0) break;
                                                    if (wireType === 0) {
                                                        let val;
                                                        [val, scanPos] = RoomClient._lerVarint(data, scanPos);
                                                        if (fieldNum === 4) emulatorScore = val;
                                                        else if (fieldNum === 11) usingVersion = val;
                                                    } else if (wireType === 2) {
                                                        let lengthVal;
                                                        [lengthVal, scanPos] = RoomClient._lerVarint(data, scanPos);
                                                        if (fieldNum === 24 && lengthVal <= 10) {
                                                            try { lockRegion = data.slice(scanPos, scanPos + lengthVal).toString('utf-8'); } catch (e) { /* ignore */ }
                                                        }
                                                        scanPos += lengthVal;
                                                    } else if (wireType === 1) { scanPos += 8; }
                                                    else if (wireType === 5) { scanPos += 4; }
                                                    else break;
                                                } catch (e) { break; }
                                            }
                                            const plataforma = emulatorScore >= 39 ? 'emulador' : 'mobile';
                                            const versaoMap = { 0: 'Desconhecido', 1: 'Free Fire Normal', 2: 'Free Fire Max', 3: 'Free Fire India', 4: 'Free Fire Max HPE' };
                                            let versaoFf = versaoMap[usingVersion] || 'desconhecido';
                                            if (usingVersion === 2 && ['IND', 'IN', 'INDIA'].includes(lockRegion.toUpperCase())) {
                                                versaoFf = 'Free Fire India';
                                            }
                                            jogadores.push({ uid: uid2, nick, plataforma, versao_ff: versaoFf, emulator_score: emulatorScore });
                                        }
                                    } catch (e) { /* ignore */ }
                                }
                            }
                        }
                    }
                    pos++;
                    continue;
                }
                pos++;
            }
        } catch (e) { /* ignore */ }
        return jogadores;
    }

    _encodeVarint(value) {
        const result = [];
        while (value > 127) {
            result.push((value & 0x7F) | 0x80);
            value >>>= 7;
        }
        result.push(value);
        return Buffer.from(result);
    }

    _codificarVarintProto(numero) {
        const resultado = [];
        do {
            let byte = numero & 0x7F;
            numero >>>= 7;
            if (numero) byte |= 0x80;
            resultado.push(byte);
        } while (numero);
        return Buffer.from(resultado).toString('hex');
    }

    _criarPacoteProtobuf(campos) {
        const parts = [];
        for (const numCampo of Object.keys(campos).map(Number).sort((a, b) => a - b)) {
            const valor = campos[numCampo];
            if (Array.isArray(valor)) {
                for (const item of valor) {
                    if (typeof item === 'object' && item !== null && !Buffer.isBuffer(item)) {
                        const bytesAninhados = this._criarPacoteProtobuf(item);
                        const hexAninhados = bytesAninhados.toString('hex');
                        const hexComprimento = this._codificarVarintProto(bytesAninhados.length);
                        const tag = (numCampo << 3) | 2;
                        const hexTag = this._codificarVarintProto(tag);
                        parts.push(hexTag + hexComprimento + hexAninhados);
                    } else {
                        const tag = (numCampo << 3) | 0;
                        const hexTag = this._codificarVarintProto(tag);
                        const hexVal = this._codificarVarintProto(item);
                        parts.push(hexTag + hexVal);
                    }
                }
            } else if (Buffer.isBuffer(valor)) {
                const hexComprimento = this._codificarVarintProto(valor.length);
                const tag = (numCampo << 3) | 2;
                const hexTag = this._codificarVarintProto(tag);
                parts.push(hexTag + hexComprimento + valor.toString('hex'));
            } else if (typeof valor === 'object' && valor !== null) {
                const bytesAninhados = this._criarPacoteProtobuf(valor);
                const hexAninhados = bytesAninhados.toString('hex');
                const hexComprimento = this._codificarVarintProto(bytesAninhados.length);
                const tag = (numCampo << 3) | 2;
                const hexTag = this._codificarVarintProto(tag);
                parts.push(hexTag + hexComprimento + hexAninhados);
            } else if (typeof valor === 'string') {
                const codificado = Buffer.from(valor, 'utf-8');
                const hexComprimento = this._codificarVarintProto(codificado.length);
                const tag = (numCampo << 3) | 2;
                const hexTag = this._codificarVarintProto(tag);
                parts.push(hexTag + hexComprimento + codificado.toString('hex'));
            } else if (valor === null || valor === undefined) {
                const tag = (numCampo << 3) | 2;
                const hexTag = this._codificarVarintProto(tag);
                parts.push(hexTag + "00");
            } else {
                const tag = (numCampo << 3) | 0;
                const hexTag = this._codificarVarintProto(tag);
                const hexVal = this._codificarVarintProto(valor);
                parts.push(hexTag + hexVal);
            }
        }
        return Buffer.from(parts.join(''), 'hex');
    }

    // ============================================================
    // HTTP Methods
    // ============================================================

    async fazerMajorLogin(payload) {
        const nowSec = Math.floor(Date.now() / 1000);
        const headers = {
            'Accept': "*/*",
            'Accept-Encoding': "deflate, gzip",
            'Authorization': "Bearer",
            'Content-Type': "application/x-www-form-urlencoded",
            'Expect': "100-continue",
            'Host': "loginbp.ppmainecoonghj.com",
            'ReleaseVersion': "OB55",
            'User-Agent': "UnityPlayer/2018.4.12f1 (UnityWebRequest/1.0, libcurl/8.5.0-DEV)",
            'X-GA': "v1 1",
            'X-GA-SV': String(nowSec),
            'X-Unity-Version': "2018.4.12f1"
        };
        try {
            const config = {
                url: "https://loginbp.ppmainecoonghj.com/MajorLogin",
                method: 'post',
                data: payload,
                headers,
                timeout: 30000,
                responseType: 'arraybuffer',
                ...getAxiosProxyConfig(this.uid),
            };
            const resposta = await axios(config);
            if (resposta.status === 200) return resposta.data;
            if (resposta.status === 400) {
                invalidarTokenCache(this.uid);
                return 'RETRY_TOKEN';
            }
            Logger.erro(this.uid, `[PROXY] MajorLogin status ${resposta.status}`);
            return null;
        } catch (e) {
            if (e.response && e.response.status === 400) {
                invalidarTokenCache(this.uid);
                return 'RETRY_TOKEN';
            }
            Logger.erro(this.uid, `[PROXY] MajorLogin erro: ${e.message}`);
            return null;
        }
    }

    /**
     * Parse generico de protobuf wire format.
     * Retorna um objeto { fieldNumber: { wireType, data } }
     */
    static _parseProtobufRaw(buf) {
        const fields = {};
        let pos = 0;
        while (pos < buf.length) {
            let tag;
            [tag, pos] = RoomClient._lerVarint(buf, pos);
            const fieldNum = tag >>> 3;
            const wireType = tag & 0x07;
            if (fieldNum === 0) break;
            if (wireType === 0) {
                // varint
                let val;
                [val, pos] = RoomClient._lerVarint(buf, pos);
                if (!fields[fieldNum]) fields[fieldNum] = [];
                fields[fieldNum].push({ wireType, value: val });
            } else if (wireType === 2) {
                // length-delimited (string, bytes, embedded message)
                let len;
                [len, pos] = RoomClient._lerVarint(buf, pos);
                const data = buf.slice(pos, pos + len);
                pos += len;
                if (!fields[fieldNum]) fields[fieldNum] = [];
                fields[fieldNum].push({ wireType, data });
            } else if (wireType === 1) {
                // 64-bit fixed
                const data = buf.slice(pos, pos + 8);
                pos += 8;
                if (!fields[fieldNum]) fields[fieldNum] = [];
                fields[fieldNum].push({ wireType, data });
            } else if (wireType === 5) {
                // 32-bit fixed
                const data = buf.slice(pos, pos + 4);
                pos += 4;
                if (!fields[fieldNum]) fields[fieldNum] = [];
                fields[fieldNum].push({ wireType, data });
            } else if (wireType === 3 || wireType === 4) {
                // Groups (deprecated): ignore and skip/continue parsing flat
                if (!fields[fieldNum]) fields[fieldNum] = [];
                fields[fieldNum].push({ wireType, value: wireType === 3 ? 'start_group' : 'end_group' });
            } else {
                break; // unknown wire type
            }
        }
        return fields;
    }

    processarRespostaLogin(dadosSerializados) {
        /**
         * MajorLoginRes protobuf fields (decodificado de trick_pb2.py):
         * field 8:  string token  (JWT)
         * field 21: int64  kts    (timestamp em nanosegundos ou segundos)
         * field 22: bytes  ak     (chave AES)
         * field 23: bytes  aiv    (IV AES)
         */
        try {
            let buf = Buffer.isBuffer(dadosSerializados) ? dadosSerializados : Buffer.from(dadosSerializados);
            let fields = RoomClient._parseProtobufRaw(buf);

            // No OB55, a resposta do MajorLogin vem com um prefixo de 64 bytes (assinatura/header)
            if (!fields[8] || fields[8].length === 0) {
                if (buf.length > 64) {
                    const fields64 = RoomClient._parseProtobufRaw(buf.slice(64));
                    if (fields64[8] && fields64[8].length > 0) {
                        fields = fields64;
                        buf = buf.slice(64);
                    }
                }
            }

            // Fallback de varredura se ainda não encontrou
            if (!fields[8] || fields[8].length === 0) {
                const jwtIndex = buf.indexOf(Buffer.from('eyJ'));
                if (jwtIndex > 0) {
                    for (let offset = 0; offset < jwtIndex; offset++) {
                        const testFields = RoomClient._parseProtobufRaw(buf.slice(offset));
                        if (testFields[8] && testFields[8].length > 0) {
                            fields = testFields;
                            buf = buf.slice(offset);
                            break;
                        }
                    }
                }
            }

            // field 21 = kts (varint, int64 - timestamp)
            const ktsField = fields[21];
            let kts = null;
            if (ktsField && ktsField.length > 0 && ktsField[0].wireType === 0) {
                kts = ktsField[0].value;
            }

            // field 22 = ak (bytes - chave AES)
            const akField = fields[22];
            let ak = null;
            if (akField && akField.length > 0 && akField[0].data) {
                ak = akField[0].data.toString('hex');
            }

            // field 23 = aiv (bytes - IV AES)
            const aivField = fields[23];
            let aiv = null;
            if (aivField && aivField.length > 0 && aivField[0].data) {
                aiv = aivField[0].data.toString('hex');
            }

            // field 8 = token (string - JWT)
            const tokenField = fields[8];
            let token = null;
            if (tokenField && tokenField.length > 0 && tokenField[0].data) {
                token = tokenField[0].data.toString('utf-8');
            }

            // Fallback para JWT via regex
            if (!token) {
                const strData = buf.toString('latin1');
                const jwtMatch = strData.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
                if (jwtMatch) {
                    token = jwtMatch[0];
                }
            }

            // field 4 = region (string)
            const regionField = fields[4];
            let region = 'US';
            if (regionField && regionField.length > 0 && regionField[0].data) {
                region = regionField[0].data.toString('utf-8');
            }

            let timestampCombinado = kts;

            if (!token) {
                Logger.erro(this.uid, '[PROTO] processarRespostaLogin: token nao encontrado no protobuf');
                return [null, null, null, null, null];
            }

            return [timestampCombinado, ak, aiv, token, region];
        } catch (e) {
            Logger.erro(this.uid, `[PROTO] processarRespostaLogin erro: ${e.message}`);
            return [null, null, null, null, null];
        }
    }

    async obterTokenGuest(forceNew = false) {
        if (!forceNew) {
            const [cachedAt, cachedOi] = obterTokenCache(this.uid);
            if (cachedAt && cachedOi) return [cachedAt, cachedOi];
        }
        const url = "https://100067.connect.garena.com/api/v2/oauth/guest/token:grant";
        const cabecalhos = {
            "Host": "100067.connect.garena.com",
            "User-Agent": obterUserAgentAleatorio(),
            "Accept": "application/json",
            "Content-Type": "application/json; charset=utf-8",
            "Accept-Encoding": "gzip",
            "Connection": "close"
        };
        const dados = {
            client_id: 100067,
            client_secret: "2ee44819e9b4598845141067b281621874d0d5d7af9d8f7e00c1e54715b7d1e3",
            client_type: 2,
            password: String(this.password),
            response_type: "token",
            uid: Number(this.uid)
        };

        // Try with proxy first
        if (_PROXY_ENABLED) {
            try {
                const resp = await axios.post(url, dados, {
                    headers: cabecalhos, timeout: 15000,
                    ...getAxiosProxyConfig(this.uid),
                });
                if (resp.status === 200) {
                    const data = resp.data?.data || resp.data;
                    const at = data.access_token;
                    const oi = data.open_id;
                    if (at && oi) { salvarTokenCache(this.uid, this.password, at, oi); return [at, oi]; }
                } else {
                    Logger.erro(this.uid, `[PROXY] obter_token_guest via proxy: status ${resp.status}`);
                }
            } catch (e) {
                Logger.erro(this.uid, `[PROXY] obter_token_guest falhou via proxy: ${e.message}. Tentando direto...`);
            }
        }
        // Fallback: direct
        for (let tentativa = 0; tentativa < 2; tentativa++) {
            try {
                const resp = await axios.post(url, dados, { headers: cabecalhos, timeout: 15000 });
                if (resp.status === 200) {
                    const data = resp.data?.data || resp.data;
                    const at = data.access_token;
                    const oi = data.open_id;
                    if (at && oi) { salvarTokenCache(this.uid, this.password, at, oi); return [at, oi]; }
                }
                if (tentativa === 0) { await sleep(300); continue; }
                return [null, null];
            } catch (e) {
                if (tentativa === 0) { await sleep(300); continue; }
                return [null, null];
            }
        }
        return [null, null];
    }

    async obterDadosLogin(tokenJwt, payload) {
        const url = `${this.clientUrl || 'https://client.us.freefiremobile.com'}/GetLoginData`;
        const headersLogin = {
            'Accept': '*/*',
            'Accept-Encoding': 'deflate, gzip',
            'Authorization': `Bearer ${tokenJwt}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Host': this.clientHost || 'client.us.freefiremobile.com',
            'ReleaseVersion': 'OB55',
            'User-Agent': 'UnityPlayer/2018.4.12f1 (UnityWebRequest/1.0, libcurl/8.5.0-DEV)',
            'X-GA': 'v1 1',
            'X-GA-SV': String(Math.floor(Date.now() / 1000)),
            'X-Unity-Version': '2018.4.12f1',
        };
        try {
            const resp = await axios.post(url, payload, {
                headers: headersLogin, timeout: 30000,
                responseType: 'arraybuffer',
                ...getAxiosProxyConfig(this.uid),
            });
            if (resp.status !== 200) return [null, null, null, null];
            try {
                const content = Buffer.from(resp.data);
                const fields = RoomClient._parseProtobufRaw(content);
                /**
                 * GetLoginData protobuf fields (decodificado de GetLoginDataRes_pb2.py):
                 * field 14: string Online_IP_Port  (formato "ip:porta")
                 * field 32: string AccountIP_Port  (formato "ip:porta")
                 */
                let onlineIpPort = null;
                let accountIpPort = null;

                // field 14 = Online_IP_Port
                const f14 = fields[14];
                if (f14 && f14.length > 0 && f14[0].data) {
                    onlineIpPort = f14[0].data.toString('utf-8');
                }

                // field 32 = AccountIP_Port
                const f32 = fields[32];
                if (f32 && f32.length > 0 && f32[0].data) {
                    accountIpPort = f32[0].data.toString('utf-8');
                }

                if (!onlineIpPort || !accountIpPort) {
                    Logger.erro(this.uid, `[PROTO] obterDadosLogin: campos ip:porta nao encontrados (Online=${onlineIpPort}, Account=${accountIpPort})`);
                    return [null, null, null, null];
                }

                const [onlineIp, onlinePorta] = onlineIpPort.split(':');
                const [ip, porta] = accountIpPort.split(':');
                return [ip, porta, onlineIp, onlinePorta];
            } catch (e) {
                Logger.erro(this.uid, `[PROTO] obterDadosLogin parse erro: ${e.message}`);
                return [null, null, null, null];
            }
        } catch (e) {
            Logger.erro(this.uid, `[HTTP] obterDadosLogin erro: ${e.message}`);
            return [null, null, null, null];
        }
    }

    async criarToken(novoTokenAcesso, novoOpenId) {
        const proto = criarPacoteMajorLogin(novoOpenId, novoTokenAcesso, "45.188.255.23");
        const payload = Buffer.from(encAes(proto.toString('hex')), 'hex');
        let resposta = await this.fazerMajorLogin(payload);
        if (resposta === 'RETRY_TOKEN') {
            Logger.info(`MajorLogin 400 para ${this.uid}, buscando novo token...`);
            const [novoAt, novoOi] = await this.obterTokenGuest(true);
            if (!novoAt || !novoOi) return null;
            const proto2 = criarPacoteMajorLogin(novoOi, novoAt, "45.188.255.23");
            const payload2 = Buffer.from(encAes(proto2.toString('hex')), 'hex');
            resposta = await this.fazerMajorLogin(payload2);
            if (!resposta || resposta === 'RETRY_TOKEN') return null;
            novoTokenAcesso = novoAt;
            novoOpenId = novoOi;
        }
        if (!resposta) return null;
        const [timestamp, chave, iv, tokenJwt, region] = this.processarRespostaLogin(Buffer.isBuffer(resposta) ? resposta : Buffer.from(resposta));
        let decodedUrl = null;
        try {
            const decoded = jwt.decode(tokenJwt, { complete: false });
            this.accountId = decoded.account_id;
            this.nickname = decoded.nickname || 'N/A';
            this.jwtExp = decoded.exp;
            if (decoded && decoded.server_url) {
                decodedUrl = decoded.server_url;
            }
        } catch (e) { return null; }

        this.clientRegion = region || 'US';
        const REGION_CLIENT_URL_MAP = {
            'BR': 'https://client.br.ggbluefox.com',
            'US': 'https://client.us.freefiremobile.com',
            'SG': 'https://client.sg.freefiremobile.com',
            'TW': 'https://client.tw.freefiremobile.com',
            'TH': 'https://client.th.freefiremobile.com',
            'ID': 'https://client.ind.freefiremobile.com',
            'ME': 'https://client.mena.freefiremobile.com',
            'VN': 'https://client.vn.freefiremobile.com',
            'IN': 'https://client.ind.freefiremobile.com',
            'CIS': 'https://client.ru.freefiremobile.com',
            'EU': 'https://client.eu.freefiremobile.com',
        };
        const ACCESSIBLE_URL = 'https://client.us.freefiremobile.com';
        let finalUrl = decodedUrl;
        if (!finalUrl && this.clientRegion) {
            const regionUrl = REGION_CLIENT_URL_MAP[this.clientRegion.toUpperCase()];
            finalUrl = (this.clientRegion.toUpperCase() === 'US') ? regionUrl : ACCESSIBLE_URL;
        }
        this.clientUrl = finalUrl || ACCESSIBLE_URL;
        this.clientHost = new URL(this.clientUrl).host;
        const proto3 = criarPacoteMajorLogin(novoOpenId, novoTokenAcesso, "45.188.255.23", this.clientRegion || "BR", true);
        const payload3 = Buffer.from(encAes(proto3.toString('hex')), 'hex');
        const [ip, porta, onlineIp, onlinePorta] = await this.obterDadosLogin(tokenJwt, payload3);
        if (!ip || !porta) return null;
        this.onlineIp = onlineIp || ip;
        this.onlinePorta = onlinePorta || porta;
        this.mainIp = ip;
        this.mainPorta = porta;
        this.chave = chave;
        this.iv = iv;
        this.token = tokenJwt;
        const accCodificado = this.accountId.toString(16).padStart(16, '0');
        const valorHex = decParaHex(timestamp).padStart(8, '0');
        const tokenBase64_ = Buffer.from(tokenJwt).toString('hex');
        const chaveBytes = garantirBytes(chave);
        const ivBytes = garantirBytes(iv);
        const encryptedToken = criptografarPacote(tokenBase64_, chaveBytes, ivBytes);
        const encTokenLenBytes = encryptedToken.length / 2;

        // OB55: Autenticação na porta 39699 (Online / Salas) usa opcode 9405 e tamanho de 8 bytes (16 hex chars)
        const len9405 = encTokenLenBytes.toString(16).padStart(16, '0');
        const cabecalho9405 = `9405${accCodificado}${valorHex}${len9405}`;
        this.tokenBytes = Buffer.from(cabecalho9405 + encryptedToken, 'hex');

        // OB55: Autenticação na porta 39801 (Chat / Account) usa opcode 8905 e tamanho de 4 bytes (8 hex chars)
        const len8905 = encTokenLenBytes.toString(16).padStart(8, '0');
        const cabecalho8905 = `8905${accCodificado}${valorHex}${len8905}`;
        this.chatTokenBytes = Buffer.from(cabecalho8905 + encryptedToken, 'hex');
        return true;
    }

    async getBackpack() {
        if (!this.token) return false;
        try {
            const url = `${this.clientUrl || 'https://client.us.freefiremobile.com'}/GetBackpack`;
            const headers = {
                "Accept": "*/*",
                "Accept-Encoding": "deflate, gzip",
                "Authorization": `Bearer ${this.token}`,
                "Content-Type": "application/x-www-form-urlencoded",
                "Host": this.clientHost || "client.us.freefiremobile.com",
                "ReleaseVersion": "OB55",
                "User-Agent": "UnityPlayer/2018.4.12f1 (UnityWebRequest/1.0, libcurl/8.5.0-DEV)",
                "X-GA": "v1 1",
                "X-GA-SV": String(Math.floor(Date.now() / 1000)),
                "X-Unity-Version": "2018.4.12f1",
            };
            const payload = buildGetBackpackPayload();
            const resp = await axios.post(url, payload, {
                headers, timeout: 30000,
                responseType: 'arraybuffer',
                ...getAxiosProxyConfig(this.uid),
            });
            return [200, 201].includes(resp.status);
        } catch (e) { return false; }
    }

    async alterarBio(bioText = null) {
        if (!this.token) return false;
        if (bioText === null) bioText = BIO_CPX;
        try {
            const url = `${this.clientUrl || 'https://client.us.freefiremobile.com'}/UpdateSocialBasicInfo`;
            const headers = {
                "Accept": "*/*",
                "Accept-Encoding": "deflate, gzip",
                "Authorization": `Bearer ${this.token}`,
                "Content-Type": "application/octet-stream",
                "Host": this.clientHost || "client.us.freefiremobile.com",
                "ReleaseVersion": "OB55",
                "User-Agent": "UnityPlayer/2018.4.12f1 (UnityWebRequest/1.0, libcurl/8.5.0-DEV)",
                "X-GA": "v1 1",
                "X-GA-SV": String(Math.floor(Date.now() / 1000)),
                "X-Unity-Version": "2018.4.12f1",
            };
            const payload = buildUpdateBioPayload(bioText);
            const resp = await axios.post(url, payload, {
                headers, timeout: 30000,
                responseType: 'arraybuffer',
                ...getAxiosProxyConfig(this.uid),
            });
            if ([200, 201].includes(resp.status)) {
                Logger.info(`[BIO] Bio alterada com sucesso para ${this.uid} (${this.nickname})`);
                return true;
            } else {
                Logger.erro(this.uid, `[BIO] Falha ao alterar bio: HTTP ${resp.status}`);
                return false;
            }
        } catch (e) {
            Logger.erro(this.uid, `[BIO] Erro ao alterar bio: ${e.message}`);
            return false;
        }
    }

    /**
     * Obtém as estatísticas do perfil do jogador via GetPlayerTCStats (CS) ou GetPlayerStats (BR)
     * @param {number|string} uid 
     * @param {string} mode - 'cs' ou 'br' (padrao: 'cs')
     * @returns {Promise<Object>} { cs_2, cs_3, cs_4, cs_sub_5, cs_sub_1, cs_sub_7, cs_sub_9, cs_sub_10 }
     */
    async obter_stats_jogador(uid, mode = 'cs') {
        if (!this.token) {
            Logger.erro(this.uid, `[STATS] Bot sem token para obter stats de ${uid}`);
            return flat_stats_perfil(null);
        }
        try {
            const modeLower = (mode || 'cs').toLowerCase();
            const isCs = modeLower !== 'br';
            const endpoint = isCs ? '/GetPlayerTCStats' : '/GetPlayerStats';
            const url = `${this.clientUrl || 'https://client.us.freefiremobile.com'}${endpoint}`;

            // Montar protobuf do request
            let protoBuf;
            if (isCs) {
                // PlayerCSStats request: field 1: accountid, field 3: gamemode=15, field 4: matchmode=0
                const f1 = Buffer.concat([Buffer.from([0x08]), encodeVarintBig(uid)]);
                const f3 = Buffer.from([0x18, 0x0f]); // gamemode = 15 (CS)
                const f4 = Buffer.from([0x20, 0x00]); // matchmode = 0 (career)
                protoBuf = Buffer.concat([f1, f3, f4]);
            } else {
                // PlayerStats request: field 1: accountid, field 2: matchmode=0
                const f1 = Buffer.concat([Buffer.from([0x08]), encodeVarintBig(uid)]);
                const f2 = Buffer.from([0x10, 0x00]);
                protoBuf = Buffer.concat([f1, f2]);
            }

            // Criptografar AES-128-CBC com KEY e IV
            const cipher = crypto.createCipheriv('aes-128-cbc', KEY, IV);
            cipher.setAutoPadding(true);
            const payload = Buffer.concat([cipher.update(protoBuf), cipher.final()]);

            const headers = {
                'Accept': '*/*',
                'Accept-Encoding': 'deflate, gzip',
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Host': this.clientHost || 'client.us.freefiremobile.com',
                'ReleaseVersion': 'OB55',
                'User-Agent': 'UnityPlayer/2018.4.12f1 (UnityWebRequest/1.0, libcurl/8.5.0-DEV)',
                'X-GA': 'v1 1',
                'X-Unity-Version': '2018.4.12f1'
            };

            const resp = await axios.post(url, payload, {
                headers,
                timeout: 12000,
                responseType: 'arraybuffer',
                ...getAxiosProxyConfig(this.uid)
            });

            if (resp.status !== 200 || !resp.data) {
                Logger.erro(this.uid, `[STATS] Falha HTTP ${resp.status} para UID ${uid}`);
                return flat_stats_perfil(null);
            }

            const dataBuf = Buffer.from(resp.data);
            const fields = RoomClient._parseProtobufRaw(dataBuf);
            return flat_stats_perfil(fields, isCs);
        } catch (e) {
            Logger.erro(this.uid, `[STATS] Erro ao obter stats para UID ${uid}: ${e.message}`);
            return flat_stats_perfil(null);
        }
    }

    /**
     * Consulta o nível da conta atual via GetPlayerPersonalShow.
     * Garena agora exige que o bot criador da sala seja nível 5 ou superior.
     * @returns {Promise<number|null>} Nível da conta (ex: 1, 2, 5, 50...) ou null se indisponível
     */
    async obterNivelConta() {
        if (!this.token) {
            Logger.erro(this.uid, `[NIVEL] Bot sem token para obter nível`);
            return null;
        }

        try {
            const playerUid = String(this.accountId || this.uid);
            const f1 = Buffer.concat([Buffer.from([0x08]), encodeVarintBig(playerUid)]);
            const f2 = Buffer.from([0x10, 0x07]);
            const f3 = Buffer.from([0x18, 0x01]);
            const protoBuf = Buffer.concat([f1, f2, f3]);

            const cipher = crypto.createCipheriv('aes-128-cbc', KEY, IV);
            cipher.setAutoPadding(true);
            const payload = Buffer.concat([cipher.update(protoBuf), cipher.final()]);

            const headers = {
                'Accept': '*/*',
                'Accept-Encoding': 'deflate, gzip',
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Host': this.clientHost || 'client.us.freefiremobile.com',
                'ReleaseVersion': 'OB55',
                'User-Agent': 'UnityPlayer/2018.4.12f1 (UnityWebRequest/1.0, libcurl/8.5.0-DEV)',
                'X-GA': 'v1 1',
                'X-GA-SV': String(Math.floor(Date.now() / 1000)),
                'X-Unity-Version': '2018.4.12f1'
            };

            const url = `${this.clientUrl || 'https://client.us.freefiremobile.com'}/GetPlayerPersonalShow`;
            try {
                const resp = await axios.post(url, payload, {
                    headers,
                    timeout: 10000,
                    responseType: 'arraybuffer',
                    ...getAxiosProxyConfig(this.uid)
                });

                if (resp.status === 200 && resp.data && resp.data.length > 0) {
                    const transport = Buffer.from(resp.data);
                    let bodyToDecode = transport;
                    if (transport.length % 16 === 0) {
                        try {
                            const decipher = crypto.createDecipheriv('aes-128-cbc', KEY, IV);
                            decipher.setAutoPadding(true);
                            const dec = Buffer.concat([decipher.update(transport), decipher.final()]);
                            if (dec && dec.length > 0) bodyToDecode = dec;
                        } catch (_) {}
                    }

                    const fields = RoomClient._parseProtobufRaw(bodyToDecode);
                    const basicData = fields[1]?.[0]?.data;
                    if (basicData) {
                        const basic = RoomClient._parseProtobufRaw(basicData);
                        // BasicInfo no Free Fire OB55:
                        // Campo 1: AccountId, Campo 2: Avatar/Gender (1), Campo 3: Nickname, Campo 5: Region, Campo 6: Level (15), Campo 7: Exp
                        const levelField = basic[6]?.[0]?.value !== undefined ? basic[6] : basic[5];
                        if (levelField && levelField[0]?.value !== undefined) {
                            const nivel = Number(levelField[0].value);
                            this.level = nivel;
                            if (basic[3]?.[0]?.data) {
                                try {
                                    const nick = basic[3][0].data.toString('utf-8');
                                    if (nick) this.nickname = nick;
                                } catch (_) {}
                            }
                            return nivel;
                        }
                    }
                }
            } catch (errReq) {
                Logger.erro(this.uid, `[NIVEL] Erro na consulta de perfil: ${errReq.message}`);
            }
        } catch (e) {
            Logger.erro(this.uid, `[NIVEL] Erro ao consultar nível para UID ${this.uid}: ${e.message}`);
        }
        return null;
    }

    /**
     * Tira a "foto 1" (Baseline) de perfil de todos os jogadores da sala imediatamente antes de iniciar.
     * Grava em MATCH_BASELINES[roomId].
     * @param {string|number} roomId
     */
    async _capturar_baseline_perfil(roomId) {
        try {
            const rIdStr = String(roomId);
            Logger.info(`[BASELINE] Capturando foto-base do perfil para sala ${rIdStr}...`);
            const uids = Object.keys(this.jogadoresSala || {});
            if (uids.length === 0) {
                Logger.info(`[BASELINE] Nenhum jogador em jogadoresSala para sala ${rIdStr}`);
                return null;
            }

            const playersBaseline = {};
            for (const uidStr of uids) {
                const p = this.jogadoresSala[uidStr];
                // Ignorar o proprio bot
                if (String(this.accountId) === String(uidStr)) continue;

                const stats = await this.obter_stats_jogador(uidStr, 'cs');
                playersBaseline[uidStr] = {
                    uid: uidStr,
                    nickname: p?.nick || 'N/A',
                    team: p?.team || 1,
                    slot: p?.slot || 1,
                    flat_stats: stats
                };
                Logger.info(`[BASELINE] Player ${uidStr} (${p?.nick || 'N/A'}): cs_4=${stats.cs_4} cs_3=${stats.cs_3} cs_2=${stats.cs_2} cs_sub_5=${stats.cs_sub_5}`);
            }

            MATCH_BASELINES[rIdStr] = {
                room_id: rIdStr,
                captured_at: Date.now() / 1000,
                total: Object.keys(playersBaseline).length,
                players: playersBaseline
            };

            Logger.executado(`[BASELINE] Foto-base capturada com sucesso para ${Object.keys(playersBaseline).length} jogadores na sala ${rIdStr}`);
            return MATCH_BASELINES[rIdStr];
        } catch (e) {
            Logger.erro(this.uid, `[BASELINE] Erro ao capturar foto-base para sala ${roomId}: ${e.message}`);
            return null;
        }
    }


    calcularBackoff(failures) {
        const baseDelay = Math.min(this.reconnectDelay * Math.pow(2, Math.min(failures, 5)), this.maxReconnectDelay);
        const jitter = baseDelay * (Math.random() * 0.5 - 0.25);
        return Math.max(1, baseDelay + jitter);
    }

    verificarJwtExpirando() {
        if (this.jwtExp) {
            const tempoRestante = this.jwtExp - Date.now() / 1000;
            if (tempoRestante < 600) return true;
        }
        return false;
    }

    nmnmmmmn(pacote) {
        return criptografarPacote(pacote, this.chave, this.iv);
    }

    isConnected() {
        return Boolean(this.onlineSocket && !this.onlineSocket.destroyed && this.connectionHealthy);
    }

    _writerOk() {
        try {
            return (this.onlineSocket !== null
                && !this.onlineSocket.destroyed
                && this.isConnected()
                && this.running);
        } catch (e) { return false; }
    }

    // ============================================================
    // Room creation methods (hex packet builders)
    // ============================================================

    _criarSalaGenerico(nomeSala, senha, parteConfigHex) {
        const parteInicio = Buffer.from("0801100f1803", "hex");
        const nomeBytes = Buffer.from(nomeSala, 'utf-8');
        let nomeField;
        if (nomeBytes.length < 128) {
            nomeField = Buffer.concat([Buffer.from([0x22, nomeBytes.length]), nomeBytes]);
        } else {
            nomeField = Buffer.concat([Buffer.from([0x22]), this._encodeVarint(nomeBytes.length), nomeBytes]);
        }
        let senhaField = Buffer.alloc(0);
        if (senha) {
            const senhaBytes = Buffer.from(senha, 'utf-8');
            if (senhaBytes.length < 128) {
                senhaField = Buffer.concat([Buffer.from([0x2a, senhaBytes.length]), senhaBytes]);
            } else {
                senhaField = Buffer.concat([Buffer.from([0x2a]), this._encodeVarint(senhaBytes.length), senhaBytes]);
            }
        }
        const parteConfig = Buffer.from(parteConfigHex, "hex");
        const submsg = Buffer.concat([parteInicio, nomeField, senhaField, parteConfig]);
        const submsgLen = this._encodeVarint(submsg.length);
        const pacote = Buffer.concat([Buffer.from([0x08, 0x02, 0x12]), submsgLen, submsg]);
        const pacoteHex = pacote.toString('hex');
        const encrypted = criptografarPacote(pacoteHex, this.chave, this.iv);
        const comprimentoCabecalhoFinal = decParaHex(encrypted.length / 2);
        const pacoteFinal = "0E05" + comprimentoCabecalhoFinal.padStart(8, '0') + encrypted;
        return Buffer.from(pacoteFinal, 'hex');
    }

    criarSalaSemEquipamento(nomeSala = "Neon Salas", senha = "") {
        return this._criarSalaGenerico(nomeSala, senha, "3008380140014801580170d89281117a0c0a044944433210321a0242527a0c0a044944433110061a02425282010f01030407090a0b1216191a201d27299001c8c89005a80101b201610f061008100c14321e381e3d204d2455265d2c7b066a086b146d047004860206986499649a649b649c649d640dde260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de260000d8010192026100011008100c14321e381e3d204d2455265d2c7b066a086b146d047004860206986499649a649b649c649d640dde260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de260000c2020570742d6272f002d0088003018a03050803108a038a030508041087038a0305080510c0018a0305081d10cc018a0304081610788a0305080e10af018a0302081592030c08c092811110c8c8900518509a0315615f36373637303831333634353434383631393332c00301");
    }

    criarSalaGeloInfinito(nomeSala = "Neon Salas", senha = "") {
        return this._criarSalaGenerico(nomeSala, senha, "3008380140014801580170d89381117a0c0a044944433210311a0242527a0c0a044944433110051a02425282010f01030407090a0b1216191a201d27299001c8c89005a80101b201610f061008100c14321e381e3d204d2455265d2c7b066a086b146d047004860206986499649a649b649c649d640dde260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de260000d8010192026100011008100c14321e381e3d204d2455265d2c7b066a086b146d047004860206986499649a649b649c649d640dde260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de260000c2020570742d6272f002d0088003018a03050803108a038a030508041087038a0305080510c0018a0305081d10cc018a0304081610788a0305080e10af018a0302081592030c08c092811110c8c8900518509a0315615f36373637303831333634353434383631393332c00301");
    }

    criarSalaFullCapa(nomeSala = "Neon Salas", senha = "") {
        return this._criarSalaGenerico(nomeSala, senha, "3008380140014801580170d89281117a0c0a044944433210321a0242527a0c0a044944433110051a02425282010f01030407090a0b1216191a201d27299001c8c8908502a80101b201610f061008100c14321e381e3d204d2455265d2c7b066a086b146d047004860206986499649a649b649c649d640dde260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de260000d8010192026100011008100c14321e381e3d204d2455265d2c7b066a086b146d047004860206986499649a649b649c649d640dde260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de260000c2020570742d6272f002d0088003018a03050803108a038a030508041087038a0305080510c0018a0305081d10cc018a0304081610788a0305080e10af018a0302081592030c08c092811110c8c8900518509a0315615f36373637303831333634353434383631393332c00301");
    }

    criarSalaComCarregamento(nomeSala = "Neon Salas", senha = "") {
        return this._criarSalaGenerico(nomeSala, senha, "3008380140014801580170d09281117a0c0a044944433210331a0242527a0c0a044944433110061a02425282010f01030407090a0b1216191a201d27299001c8c89005a80101b201610f061008100c14321e381e3d204d2455265d2c7b066a086b146d047004860206986499649a649b649c649d640dde260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de260000d8010192026100011008100c14321e381e3d204d2455265d2c7b066a086b146d047004860206986499649a649b649c649d640dde260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de260000c2020570742d6272f002d0088003018a03050803108a038a030508041087038a0305080510c0018a0305081d10cc018a0304081610788a0305080e10af018a0302081592030c08c092811110c8c8900518509a0315615f36373637303831333634353434383631393332c00301");
    }

    criarSalaFullumpxm8gelnormal(nomeSala = "Neon Salas", senha = "") {
        return this._criarSalaGenerico(nomeSala, senha, "3008380140014801580170d89281117a0c0a044944433210311a0242527a0c0a044944433110051a02425282010f01030407090a0b1216191a201d27299001c8c89005a80101b201610a06100810321e381e7b066a086b146d047004860206986499649a649b649c649d640dde260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de2600000000de260000de260000d801019202610001100810321e381e7b066a086b146d047004860206986499649a649b649c649d640dde260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de2600000000de260000de260000c2020570742d6272f002d0088003018a03050803108a038a030508041087038a0305080510c0018a0305081d10cc018a0304081610788a0305080e10af018a0302081592030c08c092811110c8c8900518509a0315615f36373637303831333634353434383631393332c00301");
    }

    criarSalaFullumpxm8gelinfinito(nomeSala = "Neon Salas", senha = "") {
        return this._criarSalaGenerico(nomeSala, senha, "3008380140014801580170d89381117a0c0a044944433210311a0242527a0c0a044944433110041a02425282010f01030407090a0b1216191a201d27299001c8c89005a80101b201610a06100810321e381e7b066a086b146d047004860206986499649a649b649c649d640dde260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de2600000000de260000de260000d801019202610001100810321e381e7b066a086b146d047004860206986499649a649b649c649d640dde260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de260000de2600000000de260000de260000c2020570742d6272f002d0088003018a03050803108a038a030508041087038a0305080510c0018a0305081d10cc018a0304081610788a0305080e10af018a0302081592030c08c092811110c8c8900518509a0315615f36373637303831333634353434383631393332c00301");
    }
    criarSalacsclassico(nomeSala = "Neon Salas", senha = "") {
        return this._criarSalaGenerico(nomeSala, senha, "3008380140014801580170d09281117a0c0a044944433210311a0242527a0c0a044944433110051a02425282010f01030407090a0b1216191a201d27299001c8c89005a80101b20161170308050a061008100c141c1a281c301e321e381e442047224d24542455265d2c76067b066a086b146d047004860206980a99049a049b149c309d0207f4010000840300004c040000a40600003408000060090000b80b0000de260000de260000d80101920261000108050a061008100c141c1a281c301e321e381e442047224d24542455265d2c76067b066a086b146d047004860206980a99049a049b149c309d0207f4010000840300004c040000a40600003408000060090000b80b0000de260000de260000c2020570742d6272f002d0088003018a03050803108a038a030508041087038a0305080510c0018a0305081d10cc018a0304081610788a0305080e10af018a0302081592030c08c092811110c8c8900518509a0315615f36373637303831333634353434383631393332c00301");
    }

    // TCP Connection Methods

    async enviarHeartbeat() {
        try {
            if (this.onlineSocket && this.running && !this.onlineSocket.destroyed) {
                return new Promise((resolve) => {
                    const timer = setTimeout(() => resolve(false), 5000); // 5s timeout
                    this.onlineSocket.write(_HEARTBEAT_BYTES, (err) => {
                        clearTimeout(timer);
                        if (err) resolve(false);
                        else {
                            this.lastHeartbeat = Date.now() / 1000;
                            resolve(true);
                        }
                    });
                });
            }
        } catch (e) { /* ignore */ }
        return false;
    }

    _startHeartbeatLoop() {
        if (this._heartbeatInterval) clearInterval(this._heartbeatInterval);
        const heartbeatFn = async () => {
            if (!this.running || !this.onlineSocket) return;
            const ok = await this.enviarHeartbeat();
            if (!ok && this.running) {
                await sleep(2000);
                const ok2 = await this.enviarHeartbeat();
                if (!ok2 && this.running && (this.temSalaAtiva || this.aguardandoInicio)) {
                    await sleep(1000);
                    await this.enviarHeartbeat();
                }
            }
        };
        // Adaptive interval
        const getDelay = () => {
            if (this.temSalaAtiva || this.aguardandoInicio) {
                return Math.random() * (25 - 15) + 15;
            }
            return Math.random() * (HEARTBEAT_MAX - HEARTBEAT_MIN) + HEARTBEAT_MIN;
        };
        const scheduleNext = () => {
            if (!this.running) return;
            const delay = getDelay() * 1000;
            this._heartbeatInterval = setTimeout(async () => {
                await heartbeatFn();
                scheduleNext();
            }, delay);
        };
        scheduleNext();
    }

    _stopHeartbeatLoop() {
        if (this._heartbeatInterval) {
            clearTimeout(this._heartbeatInterval);
            this._heartbeatInterval = null;
        }
    }

    async _enviarPacoteSeguro(pacote, descricao = "pacote") {
        if (!this._writerOk()) throw new Error(`Writer morto antes de enviar ${descricao}`);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Timeout ao enviar ${descricao} (drain travou 10s)`)), 10000);
            this.onlineSocket.write(pacote, (err) => {
                clearTimeout(timer);
                if (err) reject(new Error(`Conexao perdida ao enviar ${descricao}: ${err.message}`));
                else {
                    this.lastHeartbeat = Date.now() / 1000;
                    resolve(true);
                }
            });
        });
    }

    async abrirConexaoOnline() {
        while (this.running) {
            try {
                this.onlineSocket = await this._connectTcp(this.onlineIp, parseInt(this.onlinePorta), 15000);
                this.onlineSocket.setNoDelay(true);
                this.onlineSocket.setKeepAlive(true, 30000);
                // Send token
                this.onlineSocket.write(this.tokenBytes);
                this.onlineReconnectFailures = 0;
                this.reconnectDelay = 1;
                this.lastSuccessfulConnection = Date.now() / 1000;
                this.lastHeartbeat = Date.now() / 1000;
                this.connectionHealthy = true;
                this.tentativasReconexao = 0;
                if (this.uid in roomAccountsData) {
                    roomAccountsData[this.uid].status_jogo = 'online';
                    marcarRoomDirty();
                }
                this._startHeartbeatLoop();
                // Read loop
                await this._onlineReadLoop();
            } catch (e) {
                this.connectionHealthy = false;
                this._fecharConexaoOnline();
                if (e.message === 'EMFILE' || (e.code && e.code === 'EMFILE')) {
                    Logger.erro(this.uid, "CRITICO: Sistema sem FDs (Too many open files). Parando bot.");
                    this.running = false;
                    return;
                }
                this.onlineReconnectFailures++;
                this.tentativasReconexao++;
                let delay = this.calcularBackoff(this.onlineReconnectFailures);
                if (this.temSalaAtiva || this.aguardandoInicio) {
                    delay = Math.min(delay, 3);
                }
                if (this.onlineReconnectFailures >= 8) {
                    await this.renovarTokenEReconectar();
                    return;
                }
                if (this.uid in roomAccountsData) {
                    roomAccountsData[this.uid].status_jogo = 'reconectando';
                    marcarRoomDirty();
                }
                await sleep(delay * 1000);
            }
        }
    }

    _connectTcp(host, port, timeoutMs = 15000) {
        return new Promise((resolve, reject) => {
            const socket = new net.Socket();
            const timer = setTimeout(() => {
                socket.destroy();
                reject(new Error('TIMEOUT'));
            }, timeoutMs);
            socket.connect(port, host, () => {
                clearTimeout(timer);
                resolve(socket);
            });
            socket.on('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });
    }

    async _onlineReadLoop() {
        return new Promise((resolve, reject) => {
            let readTimeout;
            const resetReadTimeout = () => {
                if (readTimeout) clearTimeout(readTimeout);
                // v30: Quando tem sala ativa ou aguardando inicio, dar timeout de 15 minutos (tempo de vida da sala)
                // para que a conexao do bot anfitriao nunca seja derrubada enquanto os jogadores estao entrando
                const timeout = (this.temSalaAtiva || this.aguardandoInicio) ? 900000 : 300000;
                readTimeout = setTimeout(async () => {
                    if (this.running) {
                        const ok = await this.enviarHeartbeat();
                        if (ok) { resetReadTimeout(); return; }
                        await sleep(2000);
                        const ok2 = await this.enviarHeartbeat();
                        if (ok2) { resetReadTimeout(); return; }
                    }
                    if (this.temSalaAtiva || this.aguardandoInicio) {
                        // Nao derrubar a conexao se a sala estiver ativa aguardando jogadores, manter viva
                        Logger.info(`[READ-LOOP] Timeout de leitura com sala ativa. Mantendo conexao ativa do anfitriao...`);
                        resetReadTimeout();
                        return;
                    }
                    this.onlineSocket.destroy();
                    reject(new Error('timeout na leitura online'));
                }, timeout);
            };
            resetReadTimeout();

            this.onlineSocket.on('data', (data2) => {
                resetReadTimeout();
                this.lastHeartbeat = Date.now() / 1000;
                if (!this.temSalaAtiva && !this.aguardandoSalaCriada && !this.aguardandoInicio) return;
                try {
                    const prefix2 = data2.slice(0, 2);
                    const h = data2.toString('hex');
                    if (prefix2.equals(_PREFIX_0E00)) {
                        let pkt = h.includes("08") ? "08" + h.split("08").slice(1).join("08") : h.slice(10);
                        let pd;
                        try { pd = JSON.parse(obterSalaDisponivel(pkt) || "{}"); } catch (e) { pd = {}; }
                        try { this._extrairRoomInfoFields(pd); } catch (e) { /* ignore */ }
                        if (this.aguardandoSalaCriada) {
                            try {
                                const field4Data = pd["4"]?.data;
                                const field5Data = pd["5"]?.data || {};
                                if (field4Data === 2 && typeof field5Data === 'object') {
                                    const salaId = field5Data["1"]?.data;
                                    if (salaId && typeof salaId === 'number' && salaId > 100000) {
                                        this.salaCriadaId = salaId;
                                        Logger.executado(`Sala criada com sucesso! RoomID=${salaId}`);
                                        this.salaCriadaEvent.set();
                                    }
                                } else if (pd["2"]?.data === 14 && pd["3"]?.data !== undefined) {
                                    const errCode = pd["3"].data;
                                    this.erroCriacaoSala = errCode;
                                    Logger.erro(this.uid, `[0E00] servidor recusou criacao de sala (erro ${errCode})`);
                                    this.salaCriadaEvent.set();
                                }
                            } catch (e) { /* ignore */ }
                        }
                        if (this.temSalaAtiva) {
                            try {
                                const match = _RE_SESSION.exec(h);
                                if (match) {
                                    const dadosHex = match[1];
                                    const dadosCompletos = Buffer.from(dadosHex, 'hex').toString('utf-8');
                                    if (dadosCompletos.includes('_')) {
                                        const partes = dadosCompletos.split('_');
                                        this.salaTimestamp = partes[0];
                                        this.salaSessionId = partes[1];
                                    }
                                }
                            } catch (e) { /* ignore */ }
                            // Processar pacote 0E00 por tipo (field 4)
                            try {
                                let pdRepeated;
                                try { pdRepeated = JSON.parse(obterSalaDisponivelComRepeated(pkt) || "{}"); } catch (e) { pdRepeated = null; }
                                if (pdRepeated) {
                                    const pktResult = this._processarPacote0E00(pdRepeated);
                                    // DEBUG TEMP: logar field4 e tipo
                                    try {
                                        const fs = require('fs');
                                        const f4 = pdRepeated["4"]?.data;
                                        const jogCount = pktResult.jogadores.length;
                                        const grpFound = pktResult.groupsEncontrados;
                                        const hexShort = pkt.substring(0, 100);
                                        const leaveAll = pktResult.leaveAll || false;
                                        fs.appendFileSync('/tmp/debug_field4.log', `0E00 | f4=${f4} tipo=${pktResult.tipo} jogadores=${jogCount} groups=${grpFound} leaveAll=${leaveAll} hex=${hexShort}\n`);
                                    } catch (e) { }
                                    // v19: Unified handler with room scoping
                                    const _tipo = pktResult.tipo;
                                    const _jogLen = pktResult.jogadores.length;
                                    const _grp = pktResult.groupsEncontrados;
                                    // v19: Check if this packet belongs to our room
                                    const _pktOwnerUid = pdRepeated["1"]?.data;
                                    const _isOwnRoom = String(_pktOwnerUid) === String(this.accountId);
                                    try {
                                        require('fs').appendFileSync('/tmp/debug_field4.log',
                                            `  [v19_HANDLER] tipo=${_tipo} jog=${_jogLen} grp=${_grp} own=${_isOwnRoom} pktOwner=${_pktOwnerUid} salaKeys=${Object.keys(this.jogadoresSala).join(',')} botUid=${this.accountId}\n`);
                                    } catch (e) { }

                                    // v19: SKIP packets from other rooms for join/leave/switch_seat
                                    // Only criacao and state_update from other rooms are useful
                                    if (!_isOwnRoom && (_tipo === 'join' || _tipo === 'leave' || _tipo === 'switch_seat' || _tipo === 'unknown_14')) {
                                        // Packet from another room - skip
                                        try {
                                            require('fs').appendFileSync('/tmp/debug_field4.log',
                                                `  [v19_SKIP] tipo=${_tipo} pktOwner=${_pktOwnerUid} != botUid=${this.accountId}\n`);
                                        } catch (e) { }
                                    } else if (_tipo === 'criacao') {
                                        if (_grp) this._atualizarJogadoresComEventos(pktResult.jogadores);
                                    } else if (_tipo === 'state_update') {
                                        // State update - atualizar se tem groups com jogadores reais
                                        if (_grp && _jogLen > 0) {
                                            this._atualizarJogadoresComEventos(pktResult.jogadores);
                                        }
                                        // NAO tratar state_update com 0 jogadores como "todos sairam"
                                        // porque o bot's own room SEMPRE envia state_update com 0 jogadores
                                        // (os groups tem apenas placeholders vazios)
                                        // Leave detection é feita via f4=7 (leave packet) ou via
                                        // state_update de OUTRAS salas que TEM jogadores reais
                                    } else if (_tipo === 'join') {
                                        for (const j of pktResult.jogadores) {
                                            const uidStr = String(j.uid);
                                            if (j.nick !== this.nickname && uidStr !== String(this.accountId)) {
                                                if (!(uidStr in this.jogadoresSala)) {
                                                    // v19: Calcular slot/team baseado na ordem de entrada
                                                    const numJogadores = Object.keys(this.jogadoresSala).length;
                                                    // Primeiro jogador = slot 1, segundo = slot 2, etc.
                                                    const slotGlobal = numJogadores + 1; // +1 porque comeca do 1
                                                    let assignedTeam, assignedSlot;
                                                    if (slotGlobal <= 4) {
                                                        assignedTeam = 1;
                                                        assignedSlot = slotGlobal;
                                                    } else {
                                                        assignedTeam = 2;
                                                        assignedSlot = slotGlobal - 4;
                                                    }
                                                    const teamName = `Time ${assignedTeam}`;
                                                    this._registrarEvento('player_join', {
                                                        uid: j.uid, nick: j.nick, plataforma: j.plataforma,
                                                        versao_ff: j.versao_ff, emulator_score: j.emulator_score,
                                                        team: assignedTeam, team_name: teamName, slot: assignedSlot
                                                    });
                                                    this.jogadoresSala[uidStr] = {
                                                        nick: j.nick, plataforma: j.plataforma || 'mobile',
                                                        versao_ff: j.versao_ff || 'desconhecido',
                                                        emulator_score: j.emulator_score || 0,
                                                        team: assignedTeam, team_name: teamName, slot: assignedSlot
                                                    };
                                                    this.lastUpdate = Date.now() / 1000;
                                                    try {
                                                        require('fs').appendFileSync('/tmp/debug_field4.log',
                                                            `  [v17_JOIN_ASSIGN] uid=${uidStr} nick=${j.nick} team=${assignedTeam} slot=${assignedSlot} (total=${numJogadores + 1})\n`);
                                                    } catch (e) { }
                                                }
                                            }
                                        }
                                    } else if (_tipo === 'leave') {
                                        // f4=7 = alguem saiu da sala
                                        if (_grp && _jogLen > 0) {
                                            // Leave com groups que tem jogadores reais = atualizar
                                            // (funciona para salas de outros bots)
                                            this._atualizarJogadoresComEventos(pktResult.jogadores);
                                        } else if (pktResult.leaveAll) {
                                            // Leave sem groups = limpar todos
                                            for (const uid of Object.keys(this.jogadoresSala)) {
                                                const antigo = this.jogadoresSala[uid];
                                                this._registrarEvento('player_leave', {
                                                    uid: parseInt(uid) || uid, nick: antigo.nick || 'N/A',
                                                    plataforma: antigo.plataforma || 'mobile',
                                                    versao_ff: antigo.versao_ff || 'desconhecido',
                                                    emulator_score: antigo.emulator_score || 0,
                                                    team: antigo.team || 0, team_name: antigo.team_name || '',
                                                    slot: antigo.slot || 0
                                                });
                                            }
                                            this.jogadoresSala = {};
                                            this.lastUpdate = Date.now() / 1000;
                                        } else if (Object.keys(this.jogadoresSala).length > 0) {
                                            // v21: Leave para sala do bot com groups vazios
                                            // NAO usar extrairJogadoresProtobuf porque o GROUP ID
                                            // pode ser o UID do jogador, confundindo o parser
                                            // Solucao: remover TODOS os jogadores do jogadoresSala
                                            // Se ainda houver jogadores na sala, eles serao re-adicionados
                                            // pelo proximo switch_seat (f4=25) ou join (f4=5)
                                            const removidos = Object.keys(this.jogadoresSala);
                                            for (const uid of removidos) {
                                                const antigo = this.jogadoresSala[uid];
                                                this._registrarEvento('player_leave', {
                                                    uid: parseInt(uid) || uid, nick: antigo.nick || 'N/A',
                                                    plataforma: antigo.plataforma || 'mobile',
                                                    versao_ff: antigo.versao_ff || 'desconhecido',
                                                    emulator_score: antigo.emulator_score || 0,
                                                    team: antigo.team || 0, team_name: antigo.team_name || '',
                                                    slot: antigo.slot || 0
                                                });
                                            }
                                            this.jogadoresSala = {};
                                            this.lastUpdate = Date.now() / 1000;
                                            try {
                                                require('fs').appendFileSync('/tmp/debug_field4.log',
                                                    `  [v21_LEAVE_CLEAR_ALL] removidos=${removidos.join(',')}\n`);
                                            } catch (e) { }
                                        }
                                    } else if (_tipo === 'switch_seat') {
                                        // v17b: Atualizar slot/team do jogador com info do switch_seat
                                        for (const j of pktResult.jogadores) {
                                            const uidStr = String(j.uid);
                                            if (uidStr in this.jogadoresSala) {
                                                const antigo = this.jogadoresSala[uidStr];
                                                const oldTeam = antigo.team;
                                                const oldSlot = antigo.slot;
                                                // Atualizar slot/team se disponivel
                                                if (j.team && j.team > 0) {
                                                    antigo.team = j.team;
                                                    antigo.team_name = j.team_name || `Time ${j.team}`;
                                                }
                                                if (j.slot && j.slot > 0) {
                                                    antigo.slot = j.slot;
                                                }
                                                // Registrar evento se mudou
                                                if (oldTeam !== antigo.team || oldSlot !== antigo.slot) {
                                                    if (oldTeam > 0 && oldTeam !== antigo.team) {
                                                        this._registrarEvento('player_switch_team', {
                                                            uid: j.uid, nick: antigo.nick,
                                                            plataforma: antigo.plataforma,
                                                            versao_ff: antigo.versao_ff,
                                                            emulator_score: antigo.emulator_score,
                                                            team: antigo.team, team_name: antigo.team_name,
                                                            slot: antigo.slot
                                                        }, { de_team: oldTeam, para_team: antigo.team });
                                                    }
                                                    if (oldSlot > 0 && oldSlot !== antigo.slot) {
                                                        this._registrarEvento('player_switch_slot', {
                                                            uid: j.uid, nick: antigo.nick,
                                                            plataforma: antigo.plataforma,
                                                            versao_ff: antigo.versao_ff,
                                                            emulator_score: antigo.emulator_score,
                                                            team: antigo.team, team_name: antigo.team_name,
                                                            slot: antigo.slot
                                                        }, { de_slot: oldSlot, para_slot: antigo.slot });
                                                    }
                                                }
                                                this.lastUpdate = Date.now() / 1000;
                                                try {
                                                    require('fs').appendFileSync('/tmp/debug_field4.log',
                                                        `  [v17_SWITCH_UPDATE] uid=${uidStr} team=${antigo.team} slot=${antigo.slot} (was team=${oldTeam} slot=${oldSlot})\n`);
                                                } catch (e) { }
                                            } else if (j.nick !== this.nickname && uidStr !== String(this.accountId)) {
                                                // Player not yet in jogadoresSala - add them
                                                this._registrarEvento('player_join', {
                                                    uid: j.uid, nick: j.nick, plataforma: j.plataforma,
                                                    versao_ff: j.versao_ff, emulator_score: j.emulator_score,
                                                    team: j.team || 0, team_name: j.team_name || 'Pendente',
                                                    slot: j.slot || 0
                                                });
                                                this.jogadoresSala[uidStr] = {
                                                    nick: j.nick, plataforma: j.plataforma || 'mobile',
                                                    versao_ff: j.versao_ff || 'desconhecido',
                                                    emulator_score: j.emulator_score || 0,
                                                    team: j.team || 0, team_name: j.team_name || 'Pendente',
                                                    slot: j.slot || 0
                                                };
                                                this.lastUpdate = Date.now() / 1000;
                                            }
                                        }
                                    } else if (_isOwnRoom && _tipo.startsWith('unknown_')) {
                                        // v19: Tipo desconhecido para a propria sala
                                        // f4=14 pode ser leave notification - tentar detectar
                                        // Usar extrairJogadoresProtobuf para ver quem ainda esta
                                        if (Object.keys(this.jogadoresSala).length > 0) {
                                            const jogadoresRestantes = this.extrairJogadoresProtobuf(h);
                                            const restantesUids = new Set(jogadoresRestantes.map(j => String(j.uid)));
                                            restantesUids.delete(String(this.accountId));
                                            // Tambem remover o bot por nick
                                            for (const j of jogadoresRestantes) {
                                                if (j.nick === this.nickname) restantesUids.delete(String(j.uid));
                                            }
                                            const sairam = [];
                                            for (const uid of Object.keys(this.jogadoresSala)) {
                                                if (!restantesUids.has(uid)) {
                                                    sairam.push(uid);
                                                }
                                            }
                                            if (sairam.length > 0) {
                                                for (const uid of sairam) {
                                                    const antigo = this.jogadoresSala[uid];
                                                    this._registrarEvento('player_leave', {
                                                        uid: parseInt(uid) || uid, nick: antigo.nick || 'N/A',
                                                        plataforma: antigo.plataforma || 'mobile',
                                                        versao_ff: antigo.versao_ff || 'desconhecido',
                                                        emulator_score: antigo.emulator_score || 0,
                                                        team: antigo.team || 0, team_name: antigo.team_name || '',
                                                        slot: antigo.slot || 0
                                                    });
                                                    delete this.jogadoresSala[uid];
                                                }
                                                this.lastUpdate = Date.now() / 1000;
                                                try {
                                                    require('fs').appendFileSync('/tmp/debug_field4.log',
                                                        `  [v19_LEAVE_VIA_UNKNOWN] tipo=${_tipo} sairam=${sairam.join(',')} restantes=${[...restantesUids].join(',')}\n`);
                                                } catch (e) { }
                                            }
                                        }
                                    }
                                }
                            } catch (e) { /* ignore */ }
                        }
                    }
                    // Non-0E00 packets: parser simples como fallback para join detection
                    // (NON-0E00 packets parseiam como {} no protobuf, mas o parser binario consegue extrair jogadores)
                    if (this.temSalaAtiva && !prefix2.equals(_PREFIX_0E00)) {
                        try {
                            // DEBUG TEMP: logar non-0E00 prefix e hex
                            try {
                                const fs = require('fs');
                                const hexShort = h.substring(0, 200);
                                fs.appendFileSync('/tmp/debug_field4.log', `NON-0E00 | prefix=${prefix2.toString('hex')} hex=${hexShort}\n`);
                            } catch (e) { }
                            const jogadoresNoPacote = this.extrairJogadoresProtobuf(h);
                            if (jogadoresNoPacote.length) {
                                for (const j of jogadoresNoPacote) {
                                    const uidStr = String(j.uid);
                                    if (j.nick !== this.nickname && uidStr !== String(this.accountId)) {
                                        if (!(uidStr in this.jogadoresSala)) {
                                            this._registrarEvento('player_join', {
                                                uid: j.uid, nick: j.nick, plataforma: j.plataforma,
                                                versao_ff: j.versao_ff, emulator_score: j.emulator_score,
                                                team: 0, team_name: 'Pendente', slot: 0
                                            });
                                            this.jogadoresSala[uidStr] = {
                                                nick: j.nick, plataforma: j.plataforma || 'mobile',
                                                versao_ff: j.versao_ff || 'desconhecido',
                                                emulator_score: j.emulator_score || 0,
                                                team: 0, team_name: 'Pendente', slot: 0
                                            };
                                            this.lastUpdate = Date.now() / 1000;
                                        }
                                    }
                                }
                            }
                        } catch (e) { /* ignore */ }
                    }
                    if (prefix2.equals(_PREFIX_0515) || prefix2.equals(_PREFIX_0514) || prefix2.equals(_PREFIX_0519)) {
                        if (this.aguardandoSalaCriada) {
                            try {
                                let pkt = h.includes("08") ? "08" + h.split("08").slice(1).join("08") : h.slice(10);
                                let pd;
                                try { pd = JSON.parse(obterSalaDisponivel(pkt) || "{}"); } catch (e) { pd = {}; }
                                if (typeof pd === 'object') {
                                    const field2 = pd["2"]?.data || {};
                                    if (typeof field2 === 'object') {
                                        const salaId = field2["1"]?.data;
                                        if (salaId && typeof salaId === 'number' && salaId > 100000) {
                                            this.salaCriadaId = salaId;
                                            Logger.executado(`Sala criada com sucesso! RoomID=${salaId}`);
                                            this.salaCriadaEvent.set();
                                        }
                                    }
                                }
                            } catch (e) { /* ignore */ }
                        }
                    }
                    if (this.aguardandoInicio) {
                        try {
                            if (data2.length > 4 && !this.partidaIniciadaEvent.isSet()) {
                                this.partidaIniciadaEvent.set();
                                Logger.info(`Servidor confirmou inicio da partida (prefix=${prefix2.toString('hex')})`);
                            }
                        } catch (e) { /* ignore */ }
                    }
                } catch (e) { /* ignore */ }
            });

            this.onlineSocket.on('close', () => {
                if (readTimeout) clearTimeout(readTimeout);
                reject(new Error('conexao fechada pelo servidor'));
            });

            this.onlineSocket.on('error', (err) => {
                if (readTimeout) clearTimeout(readTimeout);
                reject(err);
            });
        });
    }

    _fecharConexaoOnline() {
        this._stopHeartbeatLoop();
        if (this.onlineSocket) {
            try { this.onlineSocket.destroy(); } catch (e) { /* ignore */ }
            this.onlineSocket = null;
        }
    }

    _fecharConexaoPrincipal() {
        this.chatConectado = false;
        if (this.mainSocket) {
            try { this.mainSocket.destroy(); } catch (e) { /* ignore */ }
            this.mainSocket = null;
        }
    }

    // ============================================================
    // Main connection and reconnection
    // ============================================================

    async abrirConexaoPrincipal() {
        // Start online connection
        const onlinePromise = this.abrirConexaoOnline();
        if (CHAT_DISABLED) {
            this.chatConectado = false;
            try { await onlinePromise; } catch (e) { /* ignore */ }
            return;
        }
        // Chat connection loop (when enabled)
        while (this.running) {
            try {
                if (this.verificarJwtExpirando()) {
                    await this.renovarTokenEReconectar(true);
                    return;
                }
                if (Date.now() / 1000 - this.lastSuccessfulConnection > 4 * 60 * 60) {
                    await this.renovarTokenEReconectar(true);
                    return;
                }
                this.mainSocket = await this._connectTcp(this.mainIp, parseInt(this.mainPorta), 15000);
                this.mainSocket.setNoDelay(true);
                this.mainSocket.setKeepAlive(true, 30000);
                this.mainSocket.write(this.chatTokenBytes || this.tokenBytes);
                this.mainReconnectFailures = 0;
                this.reconnectDelay = 1;
                this.lastSuccessfulConnection = Date.now() / 1000;
                this.chatConectado = true;
                Logger.info(`Chat conectado para GuestUID ${this.uid}`);
                // Read loop for main socket
                await new Promise((resolve, reject) => {
                    this.mainSocket.on('data', () => { /* discard */ });
                    this.mainSocket.on('close', () => reject(new Error('conexao principal fechada')));
                    this.mainSocket.on('error', (err) => reject(err));
                });
            } catch (e) {
                this.chatConectado = false;
                this._fecharConexaoPrincipal();
                this.mainReconnectFailures++;
                if (this.mainReconnectFailures >= 8) {
                    await this.renovarTokenEReconectar();
                    return;
                }
                const delay = this.calcularBackoff(this.mainReconnectFailures);
                await sleep(delay * 1000);
            }
        }
    }

    async _cancelarTodasTasks() {
        this._emReconexaoCompleta = true;
        this.running = false;
        this.connectionHealthy = false;
        this.chatConectado = false;
        this._pararAnuncio();
        this._stopHeartbeatLoop();
        this._fecharConexaoPrincipal();
        this._fecharConexaoOnline();
    }

    async renovarTokenEReconectar(silent = false, _fromRetry = false) {
        this._reconexaoSucesso._recreate();
        this._emReconexaoCompleta = true;
        if (this.reconectando) return false;
        if (this._ultimaReconexaoCompleta) {
            const elapsed = Date.now() / 1000 - this._ultimaReconexaoCompleta;
            if (elapsed < 30 && !_fromRetry) {
                Logger.info(`[RECONEXAO] Cooldown ativo para ${this.uid} (${elapsed.toFixed(0)}s < 30s), ignorando`);
                return false;
            }
        }
        this._ultimaReconexaoCompleta = Date.now() / 1000;
        // Semaphore check
        if (_reconexoesAtivas >= _MAX_RECONEXOES_SIMULTANEAS) {
            await sleep(5000);
        }
        _reconexoesAtivas++;
        try {
            return await this._renovarTokenInterno(silent, _fromRetry);
        } finally {
            _reconexoesAtivas = Math.max(0, _reconexoesAtivas - 1);
        }
    }

    async _renovarTokenInterno(silent, _fromRetry) {
        try {
            if (!silent) Logger.reconectando(this.accountId, this.nickname);
            this.reconectando = true;
            if (this.uid in roomAccountsData) {
                roomAccountsData[this.uid].status_jogo = 'reconectando';
                marcarRoomDirty();
            }
            await this._cancelarTodasTasks();
            this.mainReconnectFailures = 0;
            this.onlineReconnectFailures = 0;
            this.reconnectDelay = 1;
            this.tentativasReconexao = 0;
            let [accessToken, openId] = await this.obterTokenGuest();
            if (!accessToken || !openId) {
                await sleep(2000);
                [accessToken, openId] = await this.obterTokenGuest(true);
            }
            if (!accessToken || !openId) {
                await sleep(3000);
                [accessToken, openId] = await this.obterTokenGuest(true);
            }
            if (!accessToken || !openId) {
                Logger.erro(this.uid, "falha ao obter token guest na reconexao");
                this.reconectando = false;
                if (!_fromRetry) this._agendarRetrySeguros();
                return false;
            }
            let tokenResult = await this.criarToken(accessToken, openId);
            if (!tokenResult) {
                Logger.erro(this.uid, "falha ao criar token na reconexao, tentando com token novo...");
                invalidarTokenCache(this.uid);
                [accessToken, openId] = await this.obterTokenGuest(true);
                if (accessToken && openId) tokenResult = await this.criarToken(accessToken, openId);
            }
            if (!tokenResult) {
                Logger.erro(this.uid, "falha ao criar token na reconexao");
                this.reconectando = false;
                if (!_fromRetry) this._agendarRetrySeguros();
                return false;
            }
            if (this.uid in roomAccountsData) {
                roomAccountsData[this.uid].jwt_exp = this.jwtExp;
                roomAccountsData[this.uid].chave_atual = this.chave;
                roomAccountsData[this.uid].iv_atual = this.iv;
                roomAccountsData[this.uid].main_ip = this.mainIp;
                roomAccountsData[this.uid].main_porta = this.mainPorta;
                roomAccountsData[this.uid].online_ip = this.onlineIp;
                roomAccountsData[this.uid].online_porta = this.onlinePorta;
                marcarRoomDirty();
            }
            this.running = true;
            this.lastSuccessfulConnection = Date.now() / 1000;
            this.lastHeartbeat = Date.now() / 1000;
            this.reconectando = false;
            this._emReconexaoCompleta = false;
            if (!CHAT_DISABLED) await this.getBackpack();
            try { await this.alterarBio(); } catch (e) { /* ignore */ }
            // Start connections in background
            setImmediate(() => this.abrirConexaoPrincipal());
            this._reconexaoSucesso.set();
            if (!silent) Logger.reconectado(this.accountId, this.nickname);
            try {
                const { processarSalasPendentesReconexao } = require('./room_bridge');
                setImmediate(() => processarSalasPendentesReconexao(this.uid));
            } catch (e) { /* ignore */ }
            return true;
        } catch (e) {
            this.reconectando = false;
            Logger.erro(this.uid, `erro na reconexao: ${e.message}`);
            if (!_fromRetry) this._agendarRetrySeguros();
            return false;
        }
    }

    _agendarRetrySeguros() {
        if (this._retryEmAndamento) return;
        setImmediate(() => this._retryReconexaoTardia());
    }

    async _retryReconexaoTardia() {
        if (this._retryEmAndamento) return;
        this._retryEmAndamento = true;
        try {
            const maxRetries = 5;
            for (let tentativa = 1; tentativa <= maxRetries; tentativa++) {
                if (!this.running && !this.reconectando && !this._emReconexaoCompleta) {
                    Logger.info(`[RECONEXAO] Conta ${this.uid} ja parada, abortando retry`);
                    return;
                }
                const delay = tentativa * 10 + Math.floor(Math.random() * 11);
                Logger.erro(this.uid, `Reconexao falhou para ID=${this.accountId}. Retry ${tentativa}/${maxRetries} em ${delay}s...`);
                await sleep(delay * 1000);
                try {
                    const result = await this.renovarTokenEReconectar(true, true);
                    if (result) {
                        Logger.sistema(`[RECONEXAO] Conta ${this.uid} reconectou no retry ${tentativa}/${maxRetries}!`);
                        return;
                    }
                } catch (e) {
                    Logger.erro(this.uid, `Retry ${tentativa}/${maxRetries} falhou: ${e.message}`);
                }
            }
            Logger.erro(this.uid, `Reconexao falhou ${maxRetries}x para ID=${this.accountId}. Conta marcada como morta.`);
            this.running = false;
            this.connectionHealthy = false;
            this.reconectando = false;
            this._emReconexaoCompleta = false;
            if (this.uid in roomAccountsData) {
                roomAccountsData[this.uid].status_jogo = 'morta';
                marcarRoomDirty();
            }
        } finally {
            this._retryEmAndamento = false;
        }
    }

    // ============================================================
    // Room Operations
    // ============================================================

    async iniciarConexoes() {
        this.running = true;
        if (!CHAT_DISABLED) await this.getBackpack();
        setImmediate(() => this.abrirConexaoOnline());
        Logger.logada(this.accountId, this.nickname, this.uid);
    }

    async pararConexoes() {
        this._retryEmAndamento = false;
        await this._cancelarTodasTasks();
    }

    async criarSala(modo, senha = "", nome = "") {
        if (!this.isConnected()) return [null, "bot desconectou"];
        this.salaCriadaId = null;
        this.espectadorEnviado = false;
        this.erroCriacaoSala = null;
        this.salaCriadaEvent = createEvent();
        this.aguardandoSalaCriada = true;
        this.temSalaAtiva = true;
        this.salaSessionId = null;
        this.salaTimestamp = null;
        this.roomQrCode = null;
        this.roomCode = null;
        this.jogadoresSala = {};
        this.estadoSala = "ESPERANDO_COMECAR";
        try {
            const nomeSala = nome || `Salinha${Math.floor(Math.random() * 999999) + 1}`;
            let pacoteCriar;
            if (modo === 1) pacoteCriar = this.criarSalaSemEquipamento(nomeSala, senha);
            else if (modo === 2) pacoteCriar = this.criarSalaGeloInfinito(nomeSala, senha);
            else if (modo === 3) pacoteCriar = this.criarSalaFullCapa(nomeSala, senha);
            else if (modo === 4) pacoteCriar = this.criarSalaComCarregamento(nomeSala, senha);
            else if (modo === 5) pacoteCriar = this.criarSalaFullumpxm8gelnormal(nomeSala, senha);
            else if (modo === 6) pacoteCriar = this.criarSalaFullumpxm8gelinfinito(nomeSala, senha);
            else if (modo === 7) pacoteCriar = this.criarSalacsclassico(nomeSala, senha);
            else return [null, "modo invalido"];
            if (!this.onlineSocket || this.onlineSocket.destroyed) return [null, "bot desconectou"];
            this.onlineSocket.write(pacoteCriar);
            try {
                await waitFor(this.salaCriadaEvent.wait(), 10000);
                if (this.salaCriadaId) {
                    // v28b: Espectador em BACKGROUND - não bloqueia retorno da sala
                    this._enviarEspectadorBackground();
                    this.lastUpdate = Date.now() / 1000;
                    return [this.salaCriadaId, null];
                }
                if (this.erroCriacaoSala !== null && this.erroCriacaoSala !== undefined) {
                    this.temSalaAtiva = false;
                    return [null, `servidor recusou criacao de sala (erro ${this.erroCriacaoSala})`];
                }
                return [null, "sala nao foi criada"];
            } catch (e) {
                if (e.message === 'TIMEOUT') return [null, "timeout ao criar sala"];
                return [null, `erro: ${e.message}`];
            }
        } catch (e) {
            return [null, `erro: ${e.message}`];
        } finally {
            this.aguardandoSalaCriada = false;
        }
    }

    async verificarEPreparar() {
        let jaRenovou = false;
        // Check if JWT is expiring soon (< 30min) and renew proactively
        if (this.jwtExp) {
            const tempoRestante = this.jwtExp - Date.now() / 1000;
            if (tempoRestante <= 0) {
                Logger.info(`[PRE-GO] Token do bot ${this.uid} JA EXPIROU (${Math.floor(tempoRestante)}s), renovando antes do GO...`);
                try {
                    const result = await this.renovarTokenEReconectar(true);
                    jaRenovou = true;
                    if (result) {
                        Logger.info(`[PRE-GO] Token renovado com sucesso para ${this.uid}`);
                        await sleep(2000);
                    } else {
                        Logger.erro(this.uid, `[PRE-GO] Falha ao renovar token expirado`);
                    }
                } catch (e) {
                    Logger.erro(this.uid, `[PRE-GO] Erro ao renovar token expirado: ${e.message}`);
                }
            } else if (tempoRestante < 1800) {
                Logger.info(`[PRE-GO] Token do bot ${this.uid} expira em ${Math.floor(tempoRestante)}s, renovando antes do GO...`);
                try {
                    const result = await this.renovarTokenEReconectar(true);
                    jaRenovou = true;
                    if (result) {
                        Logger.info(`[PRE-GO] Token renovado com sucesso para ${this.uid}`);
                        await sleep(2000);
                    } else {
                        Logger.erro(this.uid, `[PRE-GO] Falha ao renovar token antes do GO`);
                    }
                } catch (e) {
                    Logger.erro(this.uid, `[PRE-GO] Erro ao renovar token: ${e.message}`);
                }
            }
        }
        // Se ja renovou (que inclui reconexao), pular teste de conexao
        if (jaRenovou) {
            return this.isConnected() && this._writerOk();
        }
        // Verify connection is alive with a real heartbeat (not empty buffer)
        if (this._writerOk()) {
            try {
                const hbOk = await this.enviarHeartbeat();
                if (!hbOk) {
                    Logger.info(`[PRE-GO] Heartbeat falhou para ${this.uid}, tentando reconectar...`);
                    try {
                        await this.renovarTokenEReconectar(true);
                        await sleep(3000);
                    } catch (e2) {
                        Logger.erro(this.uid, `[PRE-GO] Falha ao reconectar apos heartbeat: ${e2.message}`);
                    }
                }
            } catch (e) {
                Logger.info(`[PRE-GO] Erro no heartbeat para ${this.uid}: ${e.message}, tentando reconectar...`);
                try {
                    await this.renovarTokenEReconectar(true);
                    await sleep(3000);
                } catch (e2) {
                    Logger.erro(this.uid, `[PRE-GO] Falha ao reconectar: ${e2.message}`);
                }
            }
        } else {
            // Writer morto, tentar reconectar
            Logger.info(`[PRE-GO] Writer morto para ${this.uid}, tentando reconectar...`);
            try {
                await this.renovarTokenEReconectar(true);
                await sleep(3000);
            } catch (e) {
                Logger.erro(this.uid, `[PRE-GO] Falha ao reconectar writer morto: ${e.message}`);
            }
        }
        return this.isConnected() && this._writerOk();
    }

    async iniciarPartida(roomId, enviarContagem = true) {
        const maxTentativas = 3;
        let ultimoErro = "desconhecido";
        const inicioGlobal = Date.now() / 1000;
        const timeoutGlobal = 90;
        for (let tentativaGo = 1; tentativaGo <= maxTentativas; tentativaGo++) {
            const elapsed = Date.now() / 1000 - inicioGlobal;
            if (elapsed > timeoutGlobal) {
                ultimoErro = `timeout global ${timeoutGlobal}s excedido`;
                break;
            }
            const connected = this.isConnected();
            const running = this.running;
            const emReconexao = this._emReconexaoCompleta || this.reconectando;
            Logger.info(`[GO-DEBUG] Tentativa ${tentativaGo}/${maxTentativas} RoomID=${roomId} | connected=${connected} running=${running} reconectando=${emReconexao}`);
            if (!connected || !running || emReconexao) {
                ultimoErro = `bot desconectou (connected=${connected} running=${running} reconectando=${emReconexao})`;
                if (tentativaGo < maxTentativas) {
                    // Esperar ate 30s pela reconexao antes de tentar de novo
                    Logger.info(`[GO-DEBUG] Aguardando reconexao do bot para RoomID=${roomId}...`);
                    for (let w = 0; w < 30; w++) {
                        await sleep(1000);
                        if (this.isConnected() && this.running && !this._emReconexaoCompleta && !this.reconectando) {
                            Logger.info(`[GO-DEBUG] Bot reconectou apos ${w + 1}s para RoomID=${roomId}`);
                            break;
                        }
                    }
                    continue;
                }
                break;
            }
            try {
                if (!this._writerOk()) {
                    ultimoErro = "writer morto/fechando";
                    if (tentativaGo < maxTentativas) { await sleep(5000); continue; }
                    break;
                }
                // Test connection with real heartbeat
                try {
                    const hbTest = await this.enviarHeartbeat();
                    if (!hbTest) {
                        ultimoErro = 'heartbeat falhou no teste pre-GO';
                        if (tentativaGo < maxTentativas) { await sleep(3000); continue; }
                        break;
                    }
                } catch (e) {
                    ultimoErro = `heartbeat erro: ${e.message}`;
                    if (tentativaGo < maxTentativas) { await sleep(3000); continue; }
                    break;
                }
                this.partidaIniciadaEvent = createEvent();
                this._startPacketsReceived = 0;
                this._confirmacaoEnviada = false;
                // Capturar foto-base (baseline) do perfil dos jogadores imediatamente antes de iniciar
                if (tentativaGo === 1) {
                    try {
                        await this._capturar_baseline_perfil(roomId);
                    } catch (eBase) {
                        Logger.erro(this.uid, `[BASELINE] Erro ao capturar baseline da sala ${roomId}: ${eBase.message}`);
                    }
                }

                // Send preparation packet
                const pacotePreparacao = criarPacoteComecarSala(roomId, this.chave, this.iv);
                try {
                    await this._enviarPacoteSeguro(pacotePreparacao, "preparacao");
                } catch (e) {
                    this.aguardandoInicio = false;
                    ultimoErro = e.message;
                    if (tentativaGo < maxTentativas) { await sleep(5000); continue; }
                    break;
                }
                await sleep(3000);
                if (!this._writerOk()) {
                    this.aguardandoInicio = false;
                    ultimoErro = "writer morreu entre preparacao e confirmacao";
                    if (tentativaGo < maxTentativas) { await sleep(5000); continue; }
                    break;
                }
                // Send confirmation
                const pacoteConfirmar = criarPacoteConfirmarInicio(roomId, this.chave, this.iv);
                try {
                    await this._enviarPacoteSeguro(pacoteConfirmar, "confirmacao");
                    this._confirmacaoEnviada = true;
                } catch (e) {
                    this.aguardandoInicio = false;
                    ultimoErro = e.message;
                    if (tentativaGo < maxTentativas) { await sleep(5000); continue; }
                    break;
                }
                // Aguarda até 3s por confirmação explícita do servidor.
                // No Free Fire, uma vez entregue o pacoteConfirmar, a partida é iniciada imediatamente.
                try {
                    await waitFor(this.partidaIniciadaEvent.wait(), 3000);
                } catch (e) {
                    Logger.info(`[GO-DEBUG] Servidor nao enviou pacote extra de confirmacao em 3s, mas pacoteConfirmar foi entregue. Assumindo partida iniciada.`);
                    this.partidaIniciadaEvent.set();
                }

                this.aguardandoInicio = false;
                this.estadoSala = "SALA_INICIADA";
                this.temSalaAtiva = false;
                this.lastUpdate = Date.now() / 1000;
                this.lastHeartbeat = Date.now() / 1000;
                Logger.executado(`[GO-DEBUG] PARTIDA INICIADA! RoomID=${roomId} tentativa=${tentativaGo}`);

                // v22: Registrar evento room_start para webhook
                this._registrarEventoSala('room_start', {
                    room_id: roomId,
                    estado: 'SALA_INICIADA',
                    total_players: Object.keys(this.jogadoresSala).length,
                    players: Object.values(this.jogadoresSala).map(p => ({
                        uid: p.uid || 'N/A', nick: p.nick || 'N/A',
                        team: p.team || 0, slot: p.slot || 0
                    }))
                });
                setImmediate(() => this._postStartCleanup(roomId));
                return [true, null];
            } catch (e) {
                this.aguardandoInicio = false;
                ultimoErro = e.message;
                if (tentativaGo < maxTentativas) { await sleep(5000); continue; }
            }
        }
        this.aguardandoInicio = false;
        this.estadoSala = "ESPERANDO_COMECAR";
        this.lastUpdate = Date.now() / 1000;
        return [false, ultimoErro];
    }

    async _postStartCleanup(roomId) {
        try {
            this._pararAnuncio();
            if (CHAT_DISABLED && this.chatConectado) {
                this._fecharConexaoPrincipal();
                Logger.info(`Chat sob demanda desconectado apos GO (GuestUID ${this.uid})`);
            }
            // Aguarda 5s para o jogo carregar e envia os pacotes de saída
            await sleep(5000);
            this.jogadoresSala = {};
            this.lastHeartbeat = Date.now() / 1000;
            if (this.onlineSocket && !this.onlineSocket.destroyed) {
                const pacoteSairSala = criarPacoteSairSala(roomId, this.chave, this.iv);
                this.onlineSocket.write(pacoteSairSala);
                Logger.info(`[CLEANUP] Pacote sair de sala enviado para sala ${roomId} (GuestUID ${this.uid})`);
            }
            await sleep(1500);
            if (this.onlineSocket && !this.onlineSocket.destroyed) {
                const pacoteSairPartida = criarPacoteSairPartida(this.chave, this.iv);
                this.onlineSocket.write(pacoteSairPartida);
                Logger.info(`[CLEANUP] Pacote sair de partida enviado para sala ${roomId} (GuestUID ${this.uid})`);
            }
            await sleep(1000);

            // DESCONECTA a conexão da sala para a conta NÃO ficar online na partida
            this._fecharConexaoOnline();
            this.salaCriadaId = null;
            this.temSalaAtiva = false;
            this.estadoSala = "FINALIZADA";
            Logger.info(`[CLEANUP] Conexao da sala ${roomId} encerrada. Bot liberado e fora do jogo.`);
        } catch (e) {
            Logger.erro(this.uid, `Erro no cleanup pos-GO: ${e.message}`);
            this.temSalaAtiva = false;
        }
    }

    _pararAnuncio() {
        if (this._anuncioInterval) {
            clearInterval(this._anuncioInterval);
            this._anuncioInterval = null;
        }
    }

    obterJogadores() { return { ...this.jogadoresSala }; }
    obterRoomQrCode() { return this.roomQrCode; }
    obterRoomCode() { return this.roomCode; }
    obterEstado() { return this.estadoSala; }

    // v29: Enviar espectador IMEDIATAMENTE após criacao da sala, sem flood
    _enviarEspectadorBackground() {
        const roomId = this.salaCriadaId;
        const uid = this.uid;
        if (!roomId) return;
        this.espectadorEnviado = false;

        (async () => {
            try {
                // Passo 1: Envio quase imediato (150ms) assim que a sala é criada para ir direto pro telespectador!
                await sleep(150);
                if (this.onlineSocket && !this.onlineSocket.destroyed && this.salaCriadaId === roomId) {
                    const pacoteSpec = criarPacoteVirarEspectador(roomId, this.accountId, this.chave, this.iv);
                    this.onlineSocket.write(pacoteSpec);
                    this.espectadorEnviado = true;
                    Logger.executado(`[ESPECTADOR] Bot ${uid} movido para telespectador imediatamente na criacao (RoomID=${roomId})`);
                }

                // Passo 2: Reforco unico de seguranca apos 600ms para garantir sem floodar a conexao
                await sleep(600);
                if (this.onlineSocket && !this.onlineSocket.destroyed && this.salaCriadaId === roomId) {
                    const pacoteSpec2 = criarPacoteVirarEspectador(roomId, this.accountId, this.chave, this.iv);
                    this.onlineSocket.write(pacoteSpec2);
                    Logger.info(`[ESPECTADOR] Reforco unico de confirmacao enviado (RoomID=${roomId})`);
                }
            } catch (e) {
                Logger.erro(uid, `[ESPECTADOR] Erro ao mover para telespectador: ${e.message}`);
            }
        })();
    }

    // v29: Reenviar pacote espectador apenas se necessario
    reenviarEspectador() {
        try {
            if (!this.salaCriadaId) return false;
            if (!this.onlineSocket || this.onlineSocket.destroyed) return false;
            if (!this.isConnected()) return false;
            // Evita flood se ja foi enviado com sucesso
            if (this.espectadorEnviado) return false;
            const pacoteSpec = criarPacoteVirarEspectador(this.salaCriadaId, this.accountId, this.chave, this.iv);
            this.onlineSocket.write(pacoteSpec);
            this.espectadorEnviado = true;
            Logger.info(`[SPEC-RETRY] Reenviando pacote espectador para RoomID=${this.salaCriadaId} bot=${this.uid}`);
            return true;
        } catch (e) {
            Logger.erro(this.uid, `[SPEC-RETRY] Falha ao reenviar espectador: ${e.message}`);
            return false;
        }
    }
    obterEventosJogadores() {
        const eventos = [...this._eventosJogadores];
        this._eventosJogadores = [];
        return eventos;
    }

    async cancelarSala(roomId) {
        if (!this.isConnected()) return [false, "bot desconectou"];
        try {
            if (!this.onlineSocket || this.onlineSocket.destroyed) return [false, "bot desconectou"];
            const pacoteSair = criarPacoteSairSala(roomId, this.chave, this.iv);
            this.onlineSocket.write(pacoteSair);
            this.jogadoresSala = {};
            this.temSalaAtiva = false;
            this.espectadorEnviado = false;
            this.salaCriadaId = null;
            this.roomQrCode = null;
            this.roomCode = null;
            Logger.sistema(`[CANCEL] Sala ${roomId} cancelada pelo bot ${this.uid}`);
            return [true, null];
        } catch (e) { return [false, e.message]; }
    }

    async expulsarPlayer(accountId, roomId) {
        if (!this.isConnected()) return [false, "bot desconectou"];
        try {
            if (!this.onlineSocket || this.onlineSocket.destroyed) return [false, "bot desconectou"];
            const pacoteExpulsar = criarPacoteExpulsarPlayer(accountId, roomId, this.chave, this.iv);
            this.onlineSocket.write(pacoteExpulsar);
            const accountIdStr = String(accountId);
            if (accountIdStr in this.jogadoresSala) delete this.jogadoresSala[accountIdStr];
            return [true, null];
        } catch (e) { return [false, e.message]; }
    }

    // Chat methods (stubs - chat is disabled by default)
    async _conectarChatSobDemanda() {
        if (this.chatConectado && this.mainSocket && !this.mainSocket.destroyed) return;
        try {
            Logger.info(`Conectando chat sob demanda para GuestUID ${this.uid}...`);
            this.mainSocket = await this._connectTcp(this.mainIp, parseInt(this.mainPorta), 15000);
            this.mainSocket.setNoDelay(true);
            this.mainSocket.setKeepAlive(true, 30000);
            this.mainSocket.write(this.chatTokenBytes || this.tokenBytes);
            this.chatConectado = true;
            Logger.info(`Chat sob demanda conectado para GuestUID ${this.uid}`);
            // Background reader to keep connection alive
            this.mainSocket.on('data', () => { /* discard */ });
            this.mainSocket.on('close', () => {
                this.chatConectado = false;
                if (this.temSalaAtiva && this.running) {
                    setImmediate(() => this._conectarChatSobDemanda().catch(() => { }));
                }
            });
        } catch (e) {
            this.chatConectado = false;
            Logger.erro(this.uid, `Falha ao conectar chat sob demanda: ${e.message}`);
            throw e;
        }
    }

    _montarRequisicaoSala(idSala) {
        const campos = {
            1: 3,
            2: {
                1: parseInt(idSala),
                2: 3,
                3: "pt-br",
                4: `${this.salaTimestamp}_${this.salaSessionId}`
            }
        };
        const pacote = this._criarPacoteProtobuf(campos).toString('hex');
        const encrypted = criptografarPacote(pacote, this.chave, this.iv);
        const hexComprimento = decParaHex(encrypted.length / 2);
        const pacoteFinal = "1205" + hexComprimento.padStart(8, '0') + encrypted;
        return Buffer.from(pacoteFinal, 'hex');
    }

    _montarPacoteMsgSala(msg, idSala) {
        const nicknameLimpo = (this.nickname || "Bot").replace(/#/g, '');
        const campos = {
            1: 1,
            2: {
                1: this.accountId,
                2: parseInt(idSala),
                3: 3,
                4: msg,
                5: Math.floor(Date.now() / 1000),
                7: 6,
                9: {
                    1: nicknameLimpo,
                    4: 301,
                    7: 2,
                    13: "",
                    14: { 1: this.accountId }
                },
                10: "pt-br",
                13: Buffer.from([0x10, 0x01, 0x18, 0x01]),
                14: ""
            }
        };
        const pacote = this._criarPacoteProtobuf(campos).toString('hex');
        const encrypted = criptografarPacote(pacote, this.chave, this.iv);
        const hexComprimento = decParaHex(encrypted.length / 2);
        const pacoteFinal = "1205" + hexComprimento.padStart(8, '0') + encrypted;
        return Buffer.from(pacoteFinal, 'hex');
    }

    async enviarMsgSala(msg, roomId) {
        try {
            if (!this.chatConectado || !this.mainSocket || this.mainSocket.destroyed) {
                for (let i = 0; i < 10; i++) {
                    await sleep(500);
                    if (this.chatConectado && this.mainSocket && !this.mainSocket.destroyed) break;
                }
                if (!this.chatConectado) {
                    Logger.erro(this.uid, `enviar_msg_sala: chat nao conectado para sala ${roomId}`);
                    return false;
                }
            }
            const pacote = this._montarPacoteMsgSala(msg, roomId);
            this.mainSocket.write(pacote);
            Logger.info(`MSG enviada na sala ${roomId} por GuestUID ${this.uid}`);
            return true;
        } catch (e) {
            Logger.erro(this.uid, `enviar_msg_sala erro: ${e.message}`);
            return false;
        }
    }

    cancelarCountdown() {
        this.countdownCancelado = true;
        if (this._countdownTimeout) {
            clearTimeout(this._countdownTimeout);
            this._countdownTimeout = null;
        }
    }
}

module.exports = {
    RoomClient,
    encAes,
    obterTokenCache,
    salvarTokenCache,
    invalidarTokenCache,
    invalidarTodosTokensCache,
    CHAT_DISABLED,
    PROXY_URL,
    BIO_CPX,
    MATCH_BASELINES,
    flat_stats_perfil,
    encodeVarintBig,
};
