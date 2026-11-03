/**
 * api_handlers.js — Handlers da API pública
 * Convertido de internal/http/handlers/api_handlers.go
 * Agora faz proxy direto para o room_bridge.js Node.js (em vez de Python)
 */
'use strict';

const http = require('http');
const config = require('../config');
const mw = require('../middleware/middleware');
const h = require('./helpers');

const bridgeAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });

function getBridgeURL() {
    return `http://127.0.0.1:${config.BridgePort}`;
}

function proxyToBridge(res, bridgePath, data) {
    const body = JSON.stringify(data);
    const url = new URL(bridgePath, getBridgeURL());

    const doRequest = (retry) => {
        const req = http.request({
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            agent: bridgeAgent,
            timeout: 20000,
        }, (bridgeRes) => {
            const chunks = [];
            bridgeRes.on('data', c => chunks.push(c));
            bridgeRes.on('end', () => {
                const respBody = Buffer.concat(chunks);
                res.setHeader('Content-Type', 'application/json');
                res.writeHead(bridgeRes.statusCode);
                res.end(respBody);
            });
        });
        req.on('error', () => {
            if (retry > 0) {
                setTimeout(() => doRequest(retry - 1), 150);
            } else {
                mw.jsonResponse(res, { status: 'BRIDGE_OFFLINE', msg: 'Servico interno indisponivel' }, 503);
            }
        });
        req.on('timeout', () => { req.destroy(); });
        req.write(body);
        req.end();
    };
    doRequest(1);
}

function proxyToBridgeWithCallback(bridgePath, data, callback) {
    const body = JSON.stringify(data);
    const url = new URL(bridgePath, getBridgeURL());

    const doRequest = (retry) => {
        const req = http.request({
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            agent: bridgeAgent,
            timeout: 20000,
        }, (bridgeRes) => {
            const chunks = [];
            bridgeRes.on('data', c => chunks.push(c));
            bridgeRes.on('end', () => {
                callback(null, bridgeRes.statusCode, Buffer.concat(chunks));
            });
        });
        req.on('error', (err) => {
            if (retry > 0) {
                setTimeout(() => doRequest(retry - 1), 200);
            } else {
                callback(err, 503, null);
            }
        });
        req.on('timeout', () => { req.destroy(); });
        req.write(body);
        req.end();
    };
    doRequest(1);
}

// ─── API Verificar Key ───
async function APIVerificarKey(req, res) {
    const corpo = await mw.parseBody(req);
    const oauthKey = mw.extrairOAuthKey(req, corpo);
    if (!oauthKey) {
        return mw.jsonResponse(res, { sucesso: false, erro: 'KEY_VAZIA', msg: 'Parametro oauth_key e obrigatorio' }, 400);
    }
    const dados = h.carregarKeysDB();
    const keys = dados.keys || [];
    for (const keyInfo of keys) {
        if (!keyInfo || h.getString(keyInfo, 'key') !== oauthKey) continue;
        const limite = h.getFloat(keyInfo, 'limite_usos');
        let usos = h.getFloat(keyInfo, 'usos_totais') || h.getFloat(keyInfo, 'total_usos');
        let restantes;
        if (keyInfo.ilimitada) {
            restantes = 'ilimitado';
        } else if (limite <= 0) {
            restantes = 0;
        } else {
            restantes = Math.max(0, limite - usos);
        }
        return mw.jsonResponse(res, {
            sucesso: true, key: oauthKey, nome: h.getString(keyInfo, 'nome'),
            ativa: h.getBool(keyInfo, 'ativa'), limite_usos: limite, usos_totais: usos,
            usos_restantes: restantes, criada_em: h.getString(keyInfo, 'criada_em'),
            ultima_request: keyInfo.ultima_request, user_id: h.getString(keyInfo, 'user_id'),
        }, 200);
    }
    mw.jsonResponse(res, { sucesso: false, erro: 'KEY_INVALIDA', msg: 'A key fornecida nao existe' }, 404);
}

// ─── API Status / Info System ───
async function APIStatus(req, res) { proxyToBridge(res, '/bridge/status', {}); }
async function APIInfoSystem(req, res) { proxyToBridge(res, '/bridge/info-system', {}); }

// ─── API Criar Sala ───
async function APICriarSala(req, res) {
    const corpo = await mw.parseBody(req);
    const oauthKey = mw.extrairOAuthKey(req, corpo);
    const [keyValida, resultado] = h.validarEConsumirUsoCriarSala(oauthKey);
    /*if (!keyValida) {
        if (resultado === 'key_inativa') return h.respostaKeyInativa(res);
        if (resultado === 'limite_excedido') return h.respostaLimiteExcedido(res);
        return h.respostaKeyInvalida(res);
    }*/
    let modo = parseInt(mw.extrairParam(req, 'modo', '1', corpo));
    if (isNaN(modo) || modo < 1 || modo > 6) modo = 1;
    const senha = mw.extrairParam(req, 'senha', '00', corpo);
    const nome = mw.extrairParam(req, 'nome', '', corpo);
    const roomImage = mw.extrairParam(req, 'room_image', '', corpo);
    const autoStartMin = mw.extrairParam(req, 'auto_start_min', '', corpo);
    const data = {
        oauth_key: oauthKey, modo, senha, nome,
        room_image: roomImage === 'true' || roomImage === '1',
    };
    if (autoStartMin) data.auto_start_min = autoStartMin;

    proxyToBridgeWithCallback('/bridge/create-room', data, (err, statusCode, respBody) => {
        if (err) {
            h.devolverUsoKey(oauthKey);
            return mw.jsonResponse(res, { status: 'BRIDGE_OFFLINE', msg: 'Servico interno indisponivel' }, 503);
        }
        if (statusCode !== 200) {
            h.devolverUsoKey(oauthKey);
        } else {
            try {
                const respData = JSON.parse(respBody.toString());
                const status = respData.status || '';
                if (status && status !== 'OK' && status !== 'SALA_CRIADA' && status !== 'ROOM_CREATED') {
                    h.devolverUsoKey(oauthKey);
                }
            } catch { /* ignore */ }
        }
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(statusCode);
        res.end(respBody);
    });
}

// ─── API Info / Iniciar / Check / Expulsar / Cancelar / Resultado Sala ───
async function APIInfoSala(req, res) {
    const corpo = await mw.parseBody(req);
    const oauthKey = mw.extrairOAuthKey(req, corpo);
    const [keyValida, resultado] = h.validarOAuthKey(oauthKey);
    if (!keyValida) {
        if (resultado === 'key_inativa') return h.respostaKeyInativa(res);
        return h.respostaKeyInvalida(res);
    }
    const sshash = mw.extrairParam(req, 'sshash', '', corpo);
    proxyToBridge(res, '/bridge/info-room', { oauth_key: oauthKey, sshash });
}

async function APIIniciarSala(req, res) {
    const corpo = await mw.parseBody(req);
    const oauthKey = mw.extrairOAuthKey(req, corpo);
    const [keyValida, resultado] = h.validarOAuthKey(oauthKey);
    /*if (!keyValida) {
        if (resultado === 'key_inativa') return h.respostaKeyInativa(res);
        return h.respostaKeyInvalida(res);
    }*/
    const sshash = mw.extrairParam(req, 'sshash', '', corpo);
    const enviarMsg = mw.extrairParam(req, 'enviar_msg', 'true', corpo);
    proxyToBridge(res, '/bridge/start-room', { oauth_key: oauthKey, sshash, enviar_msg: enviarMsg });
}

async function APICheckSala(req, res) {
    const corpo = await mw.parseBody(req);
    const oauthKey = mw.extrairOAuthKey(req, corpo);
    const [keyValida, resultado] = h.validarOAuthKey(oauthKey);
    if (!keyValida) {
        if (resultado === 'key_inativa') return h.respostaKeyInativa(res);
        return h.respostaKeyInvalida(res);
    }
    const sshash = mw.extrairParam(req, 'sshash', '', corpo);
    proxyToBridge(res, '/bridge/check-room', { oauth_key: oauthKey, sshash });
}

async function APIExpulsarPlayer(req, res) {
    const corpo = await mw.parseBody(req);
    const oauthKey = mw.extrairOAuthKey(req, corpo);
    const [keyValida, resultado] = h.validarOAuthKey(oauthKey);
    if (!keyValida) {
        if (resultado === 'key_inativa') return h.respostaKeyInativa(res);
        return h.respostaKeyInvalida(res);
    }
    const sshash = mw.extrairParam(req, 'sshash', '', corpo);
    let accountID = mw.extrairParam(req, 'accountid', '', corpo);
    if (!accountID) accountID = mw.extrairParam(req, 'account_id', '', corpo);
    proxyToBridge(res, '/bridge/expulsar', { oauth_key: oauthKey, sshash, accountid: accountID });
}

async function APICancelarSala(req, res) {
    const corpo = await mw.parseBody(req);
    const oauthKey = mw.extrairOAuthKey(req, corpo);
    const [keyValida, resultado] = h.validarOAuthKey(oauthKey);
    if (!keyValida) {
        if (resultado === 'key_inativa') return h.respostaKeyInativa(res);
        return h.respostaKeyInvalida(res);
    }
    const sshash = mw.extrairParam(req, 'sshash', '', corpo);
    proxyToBridge(res, '/bridge/cancel-room', { oauth_key: oauthKey, sshash });
}

async function APIResultadoSala(req, res) {
    const corpo = await mw.parseBody(req);
    const oauthKey = mw.extrairOAuthKey(req, corpo);
    const [keyValida, resultado] = h.validarOAuthKey(oauthKey);
    if (!keyValida) {
        if (resultado === 'key_inativa') return h.respostaKeyInativa(res);
        return h.respostaKeyInvalida(res);
    }
    const sshash = mw.extrairParam(req, 'sshash', '', corpo);
    const sendWebhook = mw.extrairParam(req, 'send_webhook', '', corpo);
    proxyToBridge(res, '/bridge/result-room', {
        oauth_key: oauthKey, sshash,
        send_webhook: sendWebhook === 'true' || sendWebhook === '1',
    });
}

// ─── API Ping / Health / NotFound ───
function APIPing(req, res) {
    mw.jsonResponse(res, { status: 'pong', time: Math.floor(Date.now() / 1000) }, 200);
}

function APIHealth(req, res) {
    mw.jsonResponse(res, { status: 'OK' }, 200);
}

function APINotFound(req, res) {
    mw.jsonResponse(res, { detail: 'Not Found' }, 404);
}

// ─── API Me / Verify Me ───
async function APIMe(req, res) {
    const corpo = await mw.parseBody(req);
    const userID = h.getString(corpo, 'user_id');
    if (!userID) return mw.jsonResponse(res, { sucesso: false, erro: 'user_id obrigatorio' }, 400);
    mw.jsonResponse(res, { sucesso: true, saldo: 0.0, creditos: 0 }, 200);
}

async function APIVerifyMe(req, res) {
    const corpo = await mw.parseBody(req);
    const userID = h.getString(corpo, 'user_id');
    const token = h.getString(corpo, 'token');
    if (!userID || !token) return mw.jsonResponse(res, { sucesso: false, erro: 'user_id e token obrigatorios' }, 400);
    const sessions = h.carregarAdminSessions();
    if (sessions) {
        const userSession = sessions[userID];
        if (userSession && h.getString(userSession, 'session_token') === token) {
            return mw.jsonResponse(res, { sucesso: true, verificado: true, user_id: userID }, 200);
        }
    }
    mw.jsonResponse(res, { sucesso: false, verificado: false }, 401);
}

// ─── API Listar Salas Ativas ───
async function APIListarSalasAtivas(req, res) {
    const corpo = await mw.parseBody(req);
    const oauthKey = mw.extrairOAuthKey(req, corpo);
    const [keyValida, resultado] = h.validarOAuthKey(oauthKey);
    if (!keyValida) {
        if (resultado === 'key_inativa') return h.respostaKeyInativa(res);
        return h.respostaKeyInvalida(res);
    }
    const salas = h.carregarSalasDB();
    const salasLista = [];
    for (const [sshash, sala] of Object.entries(salas)) {
        if (!sala || typeof sala !== 'object') continue;
        if (h.getString(sala, 'oauth_key') !== oauthKey) continue;
        salasLista.push({
            sshash, room_id: String(sala.room_id || ''),
            nome: h.getString(sala, 'nome'), modo: sala.modo,
            estado: h.getString(sala, 'estado'), created_at: h.getString(sala, 'created_at'),
            partida_iniciada: h.getBool(sala, 'partida_iniciada'),
        });
    }
    mw.jsonResponse(res, { status: 'OK', salas: salasLista, total: salasLista.length }, 200);
}

module.exports = {
    APIVerificarKey, APIStatus, APIInfoSystem, APICriarSala,
    APIInfoSala, APIIniciarSala, APICheckSala, APIExpulsarPlayer,
    APICancelarSala, APIResultadoSala, APIPing, APIHealth, APINotFound,
    APIMe, APIVerifyMe, APIListarSalasAtivas,
    proxyToBridge, proxyToBridgeWithCallback,
};
