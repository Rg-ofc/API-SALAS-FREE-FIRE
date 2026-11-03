'use strict';

const crypto = require('crypto');
const http = require('http');
const cryptoUtils = require('../crypto_utils');
const mw = require('../middleware/middleware');
const db = require('../../db_postgres');

const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || '25566');

function bridgeRequest(path, data) {
    return new Promise((resolve) => {
        const body = JSON.stringify(data || {});
        const req = http.request({
            hostname: '127.0.0.1', port: BRIDGE_PORT, path, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout: 3000
        }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
                catch (e) { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.write(body);
        req.end();
    });
}

const donoAdminID = 'discord_1059959131580153866';

const systemStats = {
    start_time: Date.now() / 1000,
    total_requests_bot: 0,
    success_requests_bot: 0,
    total_requests_api: 0,
    success_requests_api: 0,
    total_salas_criadas: 0,
    total_salas_iniciadas: 0,
};

let keysCache = null;
let keysCacheTs = 0;

// Locks simulados com Promises
const locks = {
    keys: Promise.resolve(),
    stats: Promise.resolve(),
    salas: Promise.resolve(),
    sessoes: Promise.resolve(),
    usuarios: Promise.resolve(),
    admin: Promise.resolve(),
    sessions: Promise.resolve(),
    config: Promise.resolve(),
};
const keyLocks = new Map();

function withLock(lockName, fn) {
    const prev = locks[lockName] || Promise.resolve();
    const next = prev.then(fn, fn);
    locks[lockName] = next.catch(() => { });
    return next;
}

function getKeyLock(key) {
    if (!keyLocks.has(key)) keyLocks.set(key, Promise.resolve());
    return key;
}

function withKeyLock(key, fn) {
    const lockKey = getKeyLock(key);
    const prev = keyLocks.get(lockKey) || Promise.resolve();
    const next = prev.then(fn, fn);
    keyLocks.set(lockKey, next.catch(() => { }));
    return next;
}

function obterHoraBrasilia() {
    const now = new Date();
    const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    return brt.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function gerarSshash() {
    return crypto.randomBytes(16).toString('hex');
}

function randomInt(max) {
    return crypto.randomInt(max);
}

// ─── Keys DB ───
function carregarKeysDB() {
    const now = Date.now() / 1000;
    if (keysCache && (now - keysCacheTs) < 3) return keysCache;
    const dados = db.carregarKeysInfo();
    if (dados) {
        keysCache = dados;
        keysCacheTs = now;
        return dados;
    }
    return { keys: [] };
}

function carregarKeysDBFresh() {
    const dados = db.carregarKeysInfo();
    if (dados) {
        keysCache = dados;
        keysCacheTs = Date.now() / 1000;
        return dados;
    }
    return { keys: [] };
}

function salvarKeysDB(dados) {
    db.salvarTodasKeys(dados);
    keysCache = dados;
    keysCacheTs = Date.now() / 1000;
}

function invalidarKeysCache() {
    keysCache = null;
    keysCacheTs = 0;
}

function validarOAuthKey(oauthKey) {
    if (!oauthKey) return [false, 'key_invalida'];
    const dados = carregarKeysDB();
    const keys = dados.keys || [];
    for (const keyInfo of keys) {
        if (!keyInfo || typeof keyInfo !== 'object') continue;
        if (keyInfo.key === oauthKey) {
            if (!keyInfo.ativa) {
                return [false, 'key_inativa'];
            }
            return [true, keyInfo];
        }
    }
    return [false, 'key_invalida'];
}

function validarEConsumirUsoCriarSala(oauthKey) {
    if (!oauthKey) return [false, 'key_invalida'];
    const dados = carregarKeysDBFresh();
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
            const limite = getFloat(keyInfo, 'limite_usos');
            if (limite <= 0) {
                return [true, keyInfo];
            }
            const usosAtuais = getFloat(keyInfo, 'usos_totais') || getFloat(keyInfo, 'total_usos');
            if (usosAtuais >= limite) {
                return [false, 'limite_excedido'];
            }
            keyInfo.usos_totais = usosAtuais + 1;
            salvarKeysDB(dados);
            return [true, keyInfo];
        }
    }
    return [false, 'key_invalida'];
}

function devolverUsoKey(oauthKey) {
    if (!oauthKey) return false;
    const dados = carregarKeysDBFresh();
    const keys = dados.keys || [];
    for (const keyInfo of keys) {
        if (!keyInfo || typeof keyInfo !== 'object') continue;
        if (keyInfo.key !== oauthKey) continue;
        if (keyInfo.ilimitada) return true;
        const limite = getFloat(keyInfo, 'limite_usos');
        if (limite <= 0) return true;
        let usosAtuais = getFloat(keyInfo, 'usos_totais') || getFloat(keyInfo, 'total_usos');
        if (usosAtuais > 0) {
            keyInfo.usos_totais = usosAtuais - 1;
            salvarKeysDB(dados);
        }
        return true;
    }
    return false;
}

// ─── Helpers de tipo ───
function getFloat(m, key) {
    if (!m || m[key] === undefined) return 0;
    const v = m[key];
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return parseFloat(v) || 0;
    return 0;
}

function getString(m, key) {
    if (!m || m[key] === undefined || m[key] === null) return '';
    return String(m[key]);
}

function getBool(m, key) {
    if (!m) return false;
    return !!m[key];
}

// ─── Respostas padrão ───
function respostaKeyInvalida(res) {
    mw.jsonResponse(res, { error: 'KEY_INVALIDA', msg: 'a key fornecida nao existe!' }, 401);
}

function respostaKeyInativa(res) {
    mw.jsonResponse(res, { error: 'KEY_INATIVA', msg: 'a key fornecida esta desativada!' }, 401);
}

function respostaLimiteExcedido(res) {
    mw.jsonResponse(res, { error: 'LIMITE_EXCEDIDO', msg: 'a key atingiu o limite de usos!' }, 401);
}

// ─── Salas DB (via Redis/Bridge) ───
function carregarSalasDB() {
    // Sincrono fallback: retorna cache local ou vazio
    // Os handlers que precisam de salas devem usar carregarSalasDBAsync
    return _salasCache || {};
}

let _salasCache = {};

async function carregarSalasDBAsync() {
    const dados = await bridgeRequest('/bridge/list-rooms');
    if (dados) {
        _salasCache = dados;
        return dados;
    }
    return _salasCache || {};
}

function salvarSalasDB(dados) {
    _salasCache = dados;
    bridgeRequest('/bridge/save-rooms', dados).catch(() => { });
}

// ─── Stats DB ───
function carregarStatsDB() {
    const dados = db.carregarStats();
    if (dados) {
        if (dados.total_salas_criadas !== undefined) systemStats.total_salas_criadas = dados.total_salas_criadas;
        if (dados.total_salas_iniciadas !== undefined) systemStats.total_salas_iniciadas = dados.total_salas_iniciadas;
    }
}

function salvarStatsDB() {
    db.salvarStats({
        total_salas_criadas: systemStats.total_salas_criadas,
        total_salas_iniciadas: systemStats.total_salas_iniciadas,
    });
}

function initStats() {
    carregarStatsDB();
}

// ─── Sessões Dashboard ───
function carregarSessoes() {
    return db.carregarSessoes() || { sessoes: [] };
}

function salvarSessoes(dados) {
    db.salvarSessoes(dados);
}

function carregarUsuarios() {
    return db.carregarUsuarios() || { usuarios: [] };
}

function salvarUsuarios(dados) {
    db.salvarUsuarios(dados);
}

function validarSessaoDashboard(tokenSessao) {
    if (!tokenSessao) return null;
    const dados = carregarSessoes();
    const sessoes = dados.sessoes || [];
    const agora = new Date(Date.now() - 3 * 60 * 60 * 1000);
    for (const sessao of sessoes) {
        if (!sessao || getString(sessao, 'token') !== tokenSessao) continue;
        const expiraStr = getString(sessao, 'expira_em');
        if (expiraStr) {
            const expira = new Date(expiraStr.replace(' ', 'T') + '-03:00');
            if (agora > expira) return null;
        }
        sessao.ultimo_acesso = obterHoraBrasilia();
        return sessao;
    }
    return null;
}

function criarSessaoDashboard(userID, username, avatar) {
    const tokenSessao = cryptoUtils.gerarCSRFToken() + cryptoUtils.gerarCSRFToken();
    const csrfToken = cryptoUtils.gerarCSRFToken();
    const agora = obterHoraBrasilia();
    const expira = new Date(Date.now() - 3 * 60 * 60 * 1000 + 7 * 24 * 60 * 60 * 1000);
    const expiraStr = expira.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

    const sessao = {
        token: tokenSessao,
        csrf_token: csrfToken,
        user_id: userID,
        username,
        avatar,
        criada_em: agora,
        ultimo_acesso: agora,
        expira_em: expiraStr,
    };

    const dados = carregarSessoes();
    const sessoes = (dados.sessoes || []).filter(s => s && getString(s, 'user_id') !== userID);
    sessoes.push(sessao);
    dados.sessoes = sessoes;
    salvarSessoes(dados);
    return [tokenSessao, csrfToken];
}

function removerSessaoDashboard(tokenSessao) {
    const dados = carregarSessoes();
    dados.sessoes = (dados.sessoes || []).filter(s => s && getString(s, 'token') !== tokenSessao);
    salvarSessoes(dados);
}

function registrarUsuario(userID, username, avatar) {
    const dados = carregarUsuarios();
    const usuarios = dados.usuarios || [];
    let idx = usuarios.findIndex(u => u && getString(u, 'user_id') === userID);

    const infoUsuario = {
        user_id: userID,
        username,
        avatar,
        ultimo_login: obterHoraBrasilia(),
    };

    if (idx >= 0) {
        const old = usuarios[idx] || {};
        infoUsuario.primeiro_login = getString(old, 'primeiro_login') || obterHoraBrasilia();
        infoUsuario.total_logins = getFloat(old, 'total_logins') + 1;
        if (old.senha_hash) infoUsuario.senha_hash = old.senha_hash;
        usuarios[idx] = infoUsuario;
    } else {
        infoUsuario.primeiro_login = obterHoraBrasilia();
        infoUsuario.total_logins = 1;
        usuarios.push(infoUsuario);
    }
    dados.usuarios = usuarios;
    salvarUsuarios(dados);
}

// ─── Config ───
function carregarConfiguracao() {
    const dados = db.carregarConfigGeral();
    if (!dados || Object.keys(dados).length === 0) return { admin_user_id: 'admin_local' };
    return dados;
}

// ─── Admins Dashboard ───
function carregarAdminsDashboard() {
    const dados = db.carregarAdminsDashboard();
    if (!dados || Object.keys(dados).length === 0) {
        return {
            admins: {
                [donoAdminID]: { user_id: donoAdminID, adicionado_em: 'Sistema', cargo: 'dono' },
            },
        };
    }
    const adminsMap = dados.admins;
    if (!adminsMap || Object.keys(adminsMap).length === 0) {
        return {
            admins: {
                [donoAdminID]: { user_id: donoAdminID, adicionado_em: 'Sistema', cargo: 'dono' },
            },
        };
    }
    return dados;
}

function verificarAdminDashboard(userID) {
    const admins = carregarAdminsDashboard();
    const adminsMap = admins.admins || {};
    if (adminsMap[userID]) return true;
    return userID === donoAdminID;
}

// ─── Admin Sessions ───
function carregarAdminSessions() {
    return db.carregarAdminSessions() || {};
}

function salvarAdminSessions(dados) {
    db.salvarTodosAdminSessions(dados);
}

function carregarInfoAdmin() {
    const dados = db.carregarInfoAdmin();
    if (!dados || Object.keys(dados).length === 0) {
        return {
            user_id: null, username: null, avatar: null, email: null,
            session_token: null, csrf_token: null, ultimo_acesso: null, total_logins: 0,
        };
    }
    return dados;
}

function salvarInfoAdmin(dados) {
    db.salvarInfoAdmin(dados);
}

// ─── Admin Session Store (in-memory com persistência) ───
const adminSessionStore = new Map();

function persistSessionStore() {
    const data = {};
    for (const [id, sess] of adminSessionStore) {
        data[id] = {
            admin_logado: sess.adminLogado,
            admin_user_id: sess.adminUserID,
            admin_username: sess.adminUsername,
            admin_avatar: sess.adminAvatar,
            session_token: sess.sessionToken,
            csrf_token: sess.csrfToken,
            access_token: sess.accessToken,
            permanent: sess.permanent,
            created_at: sess.createdAt.toISOString(),
        };
    }
    db.salvarAdminSessionStore(data);
}

function loadSessionStore() {
    const data = db.carregarAdminSessionStore();
    if (!data || Object.keys(data).length === 0) return;
    for (const [id, sessMap] of Object.entries(data)) {
        if (!sessMap || typeof sessMap !== 'object') continue;
        let createdAt = new Date(sessMap.created_at || Date.now());
        if (isNaN(createdAt.getTime())) createdAt = new Date();
        if (Date.now() - createdAt.getTime() > 14 * 24 * 60 * 60 * 1000) continue;
        adminSessionStore.set(id, {
            adminLogado: !!sessMap.admin_logado,
            adminUserID: sessMap.admin_user_id || '',
            adminUsername: sessMap.admin_username || '',
            adminAvatar: sessMap.admin_avatar || '',
            sessionToken: sessMap.session_token || '',
            csrfToken: sessMap.csrf_token || '',
            accessToken: sessMap.access_token || '',
            permanent: !!sessMap.permanent,
            createdAt,
        });
    }
    console.log(`  \x1b[92m\x1b[1mSESSIONS\x1b[0m Carregadas ${adminSessionStore.size} sessoes do disco`);
}

function getAdminSession(req) {
    const cookies = parseCookies(req);
    const sessionID = cookies.admin_session_id;
    if (!sessionID) return null;
    return adminSessionStore.get(sessionID) || null;
}

function createAdminSession(res, req) {
    const sessionID = crypto.randomBytes(32).toString('hex');
    const sess = {
        adminLogado: false,
        adminUserID: '',
        adminUsername: '',
        adminAvatar: '',
        sessionToken: '',
        csrfToken: '',
        accessToken: '',
        permanent: false,
        createdAt: new Date(),
    };
    adminSessionStore.set(sessionID, sess);
    const secure = isSecureRequest(req);
    res.setHeader('Set-Cookie', `admin_session_id=${sessionID}; Path=/; Max-Age=${14 * 24 * 60 * 60}; HttpOnly${secure ? '; Secure' : ''}; SameSite=Lax`);
    return [sess, sessionID];
}

function destroyAdminSession(res, req) {
    const cookies = parseCookies(req);
    const sessionID = cookies.admin_session_id;
    if (sessionID) adminSessionStore.delete(sessionID);
    res.setHeader('Set-Cookie', 'admin_session_id=; Path=/; Max-Age=0; HttpOnly');
    setImmediate(persistSessionStore);
}

function verificarAdminLogado(req) {
    const sess = getAdminSession(req);
    if (!sess || !sess.adminLogado) return false;
    if (!sess.sessionToken || !sess.adminUserID) return false;

    if (sess.adminUserID === 'admin_local') {
        const sessions = carregarAdminSessions();
        const userSession = sessions.admin_local;
        if (userSession && getString(userSession, 'session_token') === sess.sessionToken) return true;
        const infoAdmin = carregarInfoAdmin();
        if (getString(infoAdmin, 'session_token') === sess.sessionToken) return true;
    }

    const sessions = carregarAdminSessions();
    const userSession = sessions[sess.adminUserID];
    if (userSession && getString(userSession, 'session_token') === sess.sessionToken) return true;
    const infoAdmin = carregarInfoAdmin();
    if (getString(infoAdmin, 'user_id') === sess.adminUserID && getString(infoAdmin, 'session_token') === sess.sessionToken) return true;

    return false;
}

function keyElegivel(keyInfo) {
    let ativa = keyInfo.ativa !== undefined ? keyInfo.ativa : true;
    if (!ativa) return [false, 'Inativa'];
    if (keyInfo.ilimitada) return [false, 'Ilimitada'];
    const limite = getFloat(keyInfo, 'limite_usos');
    const usos = getFloat(keyInfo, 'usos_totais');
    if (limite > 0 && usos >= limite) return [false, 'Esgotada'];
    return [true, ''];
}

// ─── Cookie parser ───
function parseCookies(req) {
    const header = req.headers.cookie || '';
    const result = {};
    for (const pair of header.split(';')) {
        const [name, ...rest] = pair.split('=');
        if (name) result[name.trim()] = rest.join('=').trim();
    }
    return result;
}

function isSecureRequest(req) {
    if (req.socket.encrypted) return true;
    if ((req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https') return true;
    return false;
}

function obterAvatarURL(userID, avatarHash) {
    return '/static/img/avatar-default.png';
}

module.exports = {
    donoAdminID,
    systemStats,
    initStats,
    obterHoraBrasilia,
    gerarSshash,
    randomInt,
    carregarKeysDB,
    carregarKeysDBFresh,
    salvarKeysDB,
    invalidarKeysCache,
    validarOAuthKey,
    validarEConsumirUsoCriarSala,
    devolverUsoKey,
    getFloat,
    getString,
    getBool,
    respostaKeyInvalida,
    respostaKeyInativa,
    respostaLimiteExcedido,
    carregarSalasDB,
    carregarSalasDBAsync,
    salvarSalasDB,
    carregarStatsDB,
    salvarStatsDB,
    carregarSessoes,
    salvarSessoes,
    carregarUsuarios,
    salvarUsuarios,
    validarSessaoDashboard,
    criarSessaoDashboard,
    removerSessaoDashboard,
    registrarUsuario,
    carregarConfiguracao,
    carregarAdminsDashboard,
    verificarAdminDashboard,
    carregarAdminSessions,
    salvarAdminSessions,
    carregarInfoAdmin,
    salvarInfoAdmin,
    adminSessionStore,
    persistSessionStore,
    loadSessionStore,
    getAdminSession,
    createAdminSession,
    destroyAdminSession,
    verificarAdminLogado,
    keyElegivel,
    parseCookies,
    isSecureRequest,
    obterAvatarURL,
    withLock,
    withKeyLock,
};
