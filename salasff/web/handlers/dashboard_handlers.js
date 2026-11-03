/**
 * dashboard_handlers.js — Handlers do dashboard do usuário
 * Convertido de internal/http/handlers/dashboard_handlers.go
 */
'use strict';

const crypto = require('crypto');
const path = require('path');
const config = require('../config');
const cryptoUtils = require('../crypto_utils');
const mw = require('../middleware/middleware');
const h = require('./helpers');
const { proxyToBridge, proxyToBridgeWithCallback } = require('./api_handlers');

function hashSenha(senha) {
    return crypto.createHash('sha256').update('kallidade_salt_2024:' + senha).digest('hex');
}

function validarCSRFDashboard(token, csrfRecebido) {
    const sessao = h.validarSessaoDashboard(token);
    if (!sessao) return false;
    const csrfSessao = h.getString(sessao, 'csrf_token');
    if (!csrfSessao || !csrfRecebido) return false;
    try { return cryptoUtils.validarCSRF(csrfSessao, csrfRecebido); } catch { return false; }
}

function getDashToken(req) { return (h.parseCookies(req).dash_session || ''); }

function dashboardValidarAuth(req, res, corpo) {
    const token = getDashToken(req);
    const csrfToken = h.getString(corpo, '_csrf');
    if (!validarCSRFDashboard(token, csrfToken)) { mw.jsonResponse(res, { erro: 'CSRF_INVALIDO', msg: 'Token de seguranca invalido' }, 403); return null; }
    const sessao = h.validarSessaoDashboard(token);
    if (!sessao) { mw.jsonResponse(res, { erro: 'NAO_AUTENTICADO', msg: 'Usuario nao autenticado' }, 401); return null; }
    return sessao;
}

// ─── Páginas ───
function DashboardPaginaInicial(req, res) {
    mw.serveFile(res, req, path.join(config.DashboardDir(), 'html', 'home.html'));
}

function DashboardPagina(req, res) {
    const token = getDashToken(req);
    if (!h.validarSessaoDashboard(token)) { res.writeHead(302, { Location: '/dashboard/login' }); res.end(); return; }
    mw.serveFile(res, req, path.join(config.DashboardDir(), 'html', 'dashboard.html'));
}

function DashboardDocs(req, res) { res.writeHead(302, { Location: '/dashboard#documentacao' }); res.end(); }

function DashboardLogin(req, res) {
    const token = getDashToken(req);
    if (h.validarSessaoDashboard(token)) { res.writeHead(302, { Location: '/dashboard' }); res.end(); return; }
    const { OAuth2DashboardRedirect } = require('./oauth2_handlers');
    OAuth2DashboardRedirect(req, res);
}

// ─── API Registrar ───
async function DashboardAPIRegistrar(req, res) {
    const corpo = await mw.parseBody(req);
    if (!corpo) return mw.jsonResponse(res, { sucesso: false, erro: 'Corpo invalido' }, 400);
    const username = (h.getString(corpo, 'username') || '').trim();
    const senha = h.getString(corpo, 'senha');
    if (!username || !senha) return mw.jsonResponse(res, { sucesso: false, erro: 'Username e senha sao obrigatorios' }, 400);
    if (username.length < 3 || username.length > 20) return mw.jsonResponse(res, { sucesso: false, erro: 'Username deve ter entre 3 e 20 caracteres' }, 400);
    if (senha.length < 4) return mw.jsonResponse(res, { sucesso: false, erro: 'Senha deve ter no minimo 4 caracteres' }, 400);
    const dadosUsuarios = h.carregarUsuarios();
    const usuarios = dadosUsuarios.usuarios || [];
    if (usuarios.some(u => u && h.getString(u, 'username').toLowerCase() === username.toLowerCase())) {
        return mw.jsonResponse(res, { sucesso: false, erro: 'Username ja esta em uso' }, 409);
    }
    const userID = 'user_' + cryptoUtils.gerarCSRFToken().slice(0, 12);
    const novoUsuario = { user_id: userID, username, senha_hash: hashSenha(senha), avatar: '', primeiro_login: h.obterHoraBrasilia(), ultimo_login: h.obterHoraBrasilia(), total_logins: 1 };
    usuarios.push(novoUsuario);
    dadosUsuarios.usuarios = usuarios;
    h.salvarUsuarios(dadosUsuarios);
    const [tokenSessao] = h.criarSessaoDashboard(userID, username, '');
    const secure = h.isSecureRequest(req);
    res.setHeader('Set-Cookie', `dash_session=${tokenSessao}; Path=/; Max-Age=${14 * 24 * 60 * 60}; HttpOnly${secure ? '; Secure' : ''}; SameSite=Lax`);
    mw.jsonResponse(res, { sucesso: true, msg: 'Conta criada com sucesso', redirect: '/dashboard' }, 200);
}

// ─── API Login ───
async function DashboardAPILogin(req, res) {
    const corpo = await mw.parseBody(req);
    if (!corpo) return mw.jsonResponse(res, { sucesso: false, erro: 'Corpo invalido' }, 400);
    const username = (h.getString(corpo, 'username') || '').trim();
    const senha = h.getString(corpo, 'senha');
    if (!username || !senha) return mw.jsonResponse(res, { sucesso: false, erro: 'Username e senha sao obrigatorios' }, 400);
    const senhaHash = hashSenha(senha);
    const dadosUsuarios = h.carregarUsuarios();
    const usuarios = dadosUsuarios.usuarios || [];
    for (const user of usuarios) {
        if (!user) continue;
        if (h.getString(user, 'username').toLowerCase() === username.toLowerCase() && h.getString(user, 'senha_hash') === senhaHash) {
            user.ultimo_login = h.obterHoraBrasilia();
            user.total_logins = h.getFloat(user, 'total_logins') + 1;
            h.salvarUsuarios(dadosUsuarios);
            const userID = h.getString(user, 'user_id');
            const [tokenSessao] = h.criarSessaoDashboard(userID, username, h.getString(user, 'avatar'));
            const secure = h.isSecureRequest(req);
            res.setHeader('Set-Cookie', `dash_session=${tokenSessao}; Path=/; Max-Age=${14 * 24 * 60 * 60}; HttpOnly${secure ? '; Secure' : ''}; SameSite=Lax`);
            return mw.jsonResponse(res, { sucesso: true, msg: 'Login realizado com sucesso', redirect: '/dashboard' }, 200);
        }
    }
    mw.jsonResponse(res, { sucesso: false, erro: 'Username ou senha incorretos' }, 401);
}

// ─── Logout ───
function DashboardLogout(req, res) {
    const token = getDashToken(req);
    if (token) h.removerSessaoDashboard(token);
    res.setHeader('Set-Cookie', 'dash_session=; Path=/; Max-Age=-1');
    res.writeHead(302, { Location: '/' }); res.end();
}

// ─── API Sessão ───
function DashboardAPISessao(req, res) {
    const token = getDashToken(req);
    const sessao = h.validarSessaoDashboard(token);
    if (sessao) {
        return mw.jsonResponse(res, { logado: true, csrf_token: h.getString(sessao, 'csrf_token'), usuario: { user_id: h.getString(sessao, 'user_id'), username: h.getString(sessao, 'username'), avatar: sessao.avatar } }, 200);
    }
    mw.jsonResponse(res, { logado: false }, 200);
}

// ─── API Verify Me ───
async function DashboardAPIVerifyMe(req, res) {
    const corpo = await mw.parseBody(req);
    const sessao = dashboardValidarAuth(req, res, corpo);
    if (!sessao) return;
    const dadosUsuarios = h.carregarUsuarios();
    const usuarioInfo = (dadosUsuarios.usuarios || []).find(u => u && h.getString(u, 'user_id') === h.getString(sessao, 'user_id'));
    if (!usuarioInfo) return mw.jsonResponse(res, { erro: 'USUARIO_NAO_ENCONTRADO', msg: 'Usuario nao encontrado no sistema' }, 404);
    mw.jsonResponse(res, { sucesso: true, usuario: { user_id: h.getString(usuarioInfo, 'user_id'), username: h.getString(usuarioInfo, 'username'), avatar: usuarioInfo.avatar, primeiro_login: h.getString(usuarioInfo, 'primeiro_login'), ultimo_login: h.getString(usuarioInfo, 'ultimo_login'), total_logins: h.getFloat(usuarioInfo, 'total_logins') }, sessao: { criada_em: h.getString(sessao, 'criada_em'), ultimo_acesso: h.getString(sessao, 'ultimo_acesso'), expira_em: h.getString(sessao, 'expira_em') } }, 200);
}

// ─── API Usuário ───
async function DashboardAPIUsuario(req, res) {
    const corpo = await mw.parseBody(req);
    const sessao = dashboardValidarAuth(req, res, corpo);
    if (!sessao) return;
    const dadosUsuarios = h.carregarUsuarios();
    const usuarioInfo = (dadosUsuarios.usuarios || []).find(u => u && h.getString(u, 'user_id') === h.getString(sessao, 'user_id'));
    if (!usuarioInfo) return mw.jsonResponse(res, { erro: 'USUARIO_NAO_ENCONTRADO', msg: 'Usuario nao encontrado no sistema' }, 404);
    mw.jsonResponse(res, { sucesso: true, usuario: usuarioInfo }, 200);
}

// ─── Arquivos Estáticos ───
function DashboardServirCSS(req, res) {
    const filename = req.url.replace('/dashboard/static/css/', '').split('?')[0];
    mw.serveStaticFile(res, req, path.join(config.DashboardDir(), 'css'), filename);
}

function DashboardServirJS(req, res) {
    const filename = req.url.replace('/dashboard/static/js/', '').split('?')[0];
    mw.serveStaticFile(res, req, path.join(config.DashboardDir(), 'js'), filename);
}

// ─── API Minhas Keys ───
async function DashboardAPIMinhasKeys(req, res) {
    const corpo = await mw.parseBody(req);
    const sessao = dashboardValidarAuth(req, res, corpo);
    if (!sessao) return;
    const userIDLocal = h.getString(sessao, 'user_id');
    const dados = h.carregarKeysDB();
    const keys = dados.keys || [];
    const minhasKeys = [];
    for (const keyInfo of keys) {
        if (!keyInfo || h.getString(keyInfo, 'user_id') !== userIDLocal) continue;
        const ativa = keyInfo.ativa !== undefined ? keyInfo.ativa : true;
        if (!ativa) continue;
        const limite = h.getFloat(keyInfo, 'limite_usos');
        const usos = h.getFloat(keyInfo, 'usos_totais') || h.getFloat(keyInfo, 'total_usos');
        const ilimitada = !!keyInfo.ilimitada;
        let restantes;
        if (ilimitada) restantes = 'ilimitado';
        else if (limite <= 0) restantes = 0;
        else restantes = Math.max(0, limite - usos);
        minhasKeys.push({ key: h.getString(keyInfo, 'key'), nome: h.getString(keyInfo, 'nome'), ilimitada, limite_usos: limite, usos_totais: usos, usos_restantes: restantes, criada_em: h.getString(keyInfo, 'criada_em') });
    }
    mw.jsonResponse(res, { sucesso: true, keys: minhasKeys, total: minhasKeys.length }, 200);
}

// ─── API Minhas Salas ───
async function DashboardAPIMinhasSalas(req, res) {
    const corpo = await mw.parseBody(req);
    const sessao = dashboardValidarAuth(req, res, corpo);
    if (!sessao) return;
    const userIDLocal = h.getString(sessao, 'user_id');
    const dadosKeys = h.carregarKeysDB();
    const minhasKeysStrs = (dadosKeys.keys || []).filter(k => k && h.getString(k, 'user_id') === userIDLocal).map(k => h.getString(k, 'key'));
    const salas = h.carregarSalasDB();
    const minhasSalas = [];
    for (const [sshash, sala] of Object.entries(salas)) {
        if (!sala || typeof sala !== 'object') continue;
        if (!minhasKeysStrs.includes(h.getString(sala, 'oauth_key'))) continue;
        minhasSalas.push({ sshash, room_id: String(sala.room_id || ''), nome: h.getString(sala, 'nome'), modo: sala.modo, senha: h.getString(sala, 'senha'), estado: h.getString(sala, 'estado'), created_at: h.getString(sala, 'created_at'), created_timestamp: h.getFloat(sala, 'created_timestamp'), partida_iniciada: h.getBool(sala, 'partida_iniciada') });
    }
    minhasSalas.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    mw.jsonResponse(res, { sucesso: true, salas: minhasSalas, total: minhasSalas.length }, 200);
}

// ─── API Criar Sala (Dashboard) ───
async function DashboardAPICriarSala(req, res) {
    const corpo = await mw.parseBody(req);
    const sessao = dashboardValidarAuth(req, res, corpo);
    if (!sessao) return;
    const dados = corpo.dados || corpo;
    const key = h.getString(dados, 'key') || h.getString(corpo, 'key');
    if (!key) return mw.jsonResponse(res, { erro: 'KEY_OBRIGATORIA', msg: 'Selecione uma key para criar a sala' }, 400);
    const [keyValida, resultado] = h.validarEConsumirUsoCriarSala(key);
    if (!keyValida) {
        if (resultado === 'key_inativa') return mw.jsonResponse(res, { erro: 'KEY_INATIVA', msg: 'Key esta inativa' }, 403);
        if (resultado === 'limite_excedido') return mw.jsonResponse(res, { erro: 'LIMITE_EXCEDIDO', msg: 'Limite de usos da key excedido' }, 403);
        return mw.jsonResponse(res, { erro: 'KEY_INVALIDA', msg: 'Key invalida ou nao encontrada' }, 403);
    }
    let modo = parseInt(dados.modo || corpo.modo) || 1;
    const nome = h.getString(dados, 'nome') || h.getString(corpo, 'nome');
    let senha = h.getString(dados, 'senha') || h.getString(corpo, 'senha');
    if (!senha) senha = String(h.randomInt(90) + 10);
    proxyToBridgeWithCallback('/bridge/criar-sala-sync', { oauth_key: key, modo, senha, nome }, (err, statusCode, respBody) => {
        if (err) { h.devolverUsoKey(key); return mw.jsonResponse(res, { erro: 'BRIDGE_OFFLINE', msg: 'Servico interno indisponivel' }, 503); }
        if (statusCode !== 200) { h.devolverUsoKey(key); }
        else { try { const d = JSON.parse(respBody.toString()); if (d.sucesso === false) h.devolverUsoKey(key); } catch {} }
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(statusCode);
        res.end(respBody);
    });
}

// ─── API Info Sala (Dashboard) ───
async function DashboardAPIInfoSala(req, res) {
    const corpo = await mw.parseBody(req);
    const sessao = dashboardValidarAuth(req, res, corpo);
    if (!sessao) return;
    const dados = corpo.dados || corpo;
    const sshash = h.getString(dados, 'sshash') || h.getString(corpo, 'sshash');
    const key = h.getString(dados, 'key') || h.getString(corpo, 'key');
    if (!sshash || !key) return mw.jsonResponse(res, { erro: 'PARAMETROS_INVALIDOS', msg: 'sshash e key sao obrigatorios' }, 400);
    const salas = h.carregarSalasDB();
    const sala = salas[sshash];
    if (!sala) {
        proxyToBridgeWithCallback('/bridge/info-room', { sshash }, (err, statusCode, respBody) => {
            if (!err && statusCode === 200) {
                try { const d = JSON.parse(respBody.toString()); if (d.status === 'INFO_OBTIDA') return mw.jsonResponse(res, { sucesso: true, info: d }, 200); } catch {}
            }
            mw.jsonResponse(res, { erro: 'SSHASH_INVALIDO', msg: 'sshash nao encontrado' }, 404);
        });
        return;
    }
    mw.jsonResponse(res, { sucesso: true, info: { status: 'INFO_OBTIDA', room: { id: String(sala.room_id || ''), nome: h.getString(sala, 'nome'), modo: sala.modo, senha: h.getString(sala, 'senha'), estado: h.getString(sala, 'estado'), created_at: h.getString(sala, 'created_at') }, players: [], totalPlayers: 0 } }, 200);
}

// ─── API Iniciar Sala (Dashboard) ───
async function DashboardAPIIniciarSala(req, res) {
    const corpo = await mw.parseBody(req);
    const sessao = dashboardValidarAuth(req, res, corpo);
    if (!sessao) return;
    const dados = corpo.dados || corpo;
    const sshash = h.getString(dados, 'sshash') || h.getString(corpo, 'sshash');
    const key = h.getString(dados, 'key') || h.getString(corpo, 'key');
    if (!sshash || !key) return mw.jsonResponse(res, { erro: 'PARAMETROS_INVALIDOS', msg: 'sshash e key sao obrigatorios' }, 400);
    proxyToBridge(res, '/bridge/start-room', { oauth_key: key, sshash, enviar_msg: 'true' });
}

// ─── API Status API (Dashboard) ───
async function DashboardAPIStatusAPI(req, res) {
    const corpo = await mw.parseBody(req);
    const sessao = dashboardValidarAuth(req, res, corpo);
    if (!sessao) return;
    proxyToBridge(res, '/bridge/status', {});
}

// ─── Servir Assets ───
function DashboardServirAssets(req, res) {
    const subPath = req.url.replace('/dashboard/', '').split('?')[0];
    if (subPath.includes('..') || subPath.includes('\\')) { res.writeHead(404); res.end('Not Found'); return; }
    mw.serveFile(res, req, path.join(config.DashboardDir(), subPath));
}

module.exports = {
    DashboardPaginaInicial, DashboardPagina, DashboardDocs, DashboardLogin,
    DashboardAPIRegistrar, DashboardAPILogin, DashboardLogout, DashboardAPISessao,
    DashboardAPIVerifyMe, DashboardAPIUsuario, DashboardServirCSS, DashboardServirJS,
    DashboardAPIMinhasKeys, DashboardAPIMinhasSalas, DashboardAPICriarSala,
    DashboardAPIInfoSala, DashboardAPIIniciarSala, DashboardAPIStatusAPI,
    DashboardServirAssets,
};
