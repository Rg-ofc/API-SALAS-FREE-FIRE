/**
 * admin_handlers.js — Handlers do painel admin
 * Convertido de internal/http/handlers/admin_handlers.go
 */
'use strict';

const path = require('path');
const config = require('../config');
const cryptoUtils = require('../crypto_utils');
const mw = require('../middleware/middleware');
const h = require('./helpers');
const db = require('../../db_postgres');
const apiHandlers = require('./api_handlers');
const turbofyApi = require('./turbofy_api');
const parceria = require('./parceria_handlers');

// ─── Helpers internos ───
async function adminExtrairCSRFeDados(req) {
    const corpo = await mw.parseBody(req);
    if (!corpo) return [null, null, null];
    const csrfRecebido = h.getString(corpo, '_csrf');
    const dadosCriptografados = h.getString(corpo, 'data');
    let dadosDecriptados = {};
    if (dadosCriptografados) {
        try {
            const resultado = cryptoUtils.descriptografarDados(dadosCriptografados);
            if (resultado && typeof resultado === 'object') dadosDecriptados = resultado;
        } catch { return [csrfRecebido, null, corpo]; }
    }
    return [csrfRecebido, dadosDecriptados, corpo];
}

function verificarCSRFAdmin(req, csrfRecebido) {
    const sess = h.getAdminSession(req);
    if (!sess) return false;
    return cryptoUtils.validarCSRF(sess.csrfToken, csrfRecebido);
}

// ─── Páginas ───
function AdminRedirecionarOAuth(req, res) {
    if (h.verificarAdminLogado(req)) { res.writeHead(302, { Location: '/dashadmin' }); res.end(); return; }
    const { OAuth2AdminRedirect } = require('./oauth2_handlers');
    OAuth2AdminRedirect(req, res);
}

function AdminOAuthCallback(req, res) {
    const { OAuth2AdminCallback } = require('./oauth2_handlers');
    OAuth2AdminCallback(req, res);
}

function AdminPagina(req, res) {
    if (!h.verificarAdminLogado(req)) { res.writeHead(302, { Location: '/admin/oauth' }); res.end(); return; }
    mw.noCacheHeaders(res);
    mw.serveFile(res, req, path.join(config.SrcWebDir(), 'html', 'dashadmin.html'));
}

function AdminErroAcesso(req, res) {
    mw.serveFile(res, req, path.join(config.SrcWebDir(), 'html', 'erro-acesso.html'));
}

function AdminServirCSS(req, res) {
    const filename = req.url.replace('/static/css/', '').split('?')[0];
    mw.serveStaticFile(res, req, path.join(config.SrcWebDir(), 'css'), filename);
}

function AdminServirJS(req, res) {
    const filename = req.url.replace('/static/js/', '').split('?')[0];
    mw.serveStaticFile(res, req, path.join(config.SrcWebDir(), 'js'), filename);
}

// ─── API Verificar Sessão ───
function AdminAPIVerificarSessao(req, res) {
    if (h.verificarAdminLogado(req)) {
        const sess = h.getAdminSession(req);
        let avatar = sess.adminAvatar || '/static/images/avatar-default.png';
        return mw.jsonResponse(res, { autenticado: true, user_id: sess.adminUserID, username: sess.adminUsername, avatar, csrf: sess.csrfToken }, 200);
    }
    mw.jsonResponse(res, { autenticado: false }, 200);
}

// ─── API Me ───
async function AdminAPIMe(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);
    const infoAdmin = h.carregarInfoAdmin();
    const dadosResposta = {
        user_id: infoAdmin.user_id, username: infoAdmin.username, avatar: infoAdmin.avatar,
        ultimo_acesso: infoAdmin.ultimo_acesso, total_logins: h.getFloat(infoAdmin, 'total_logins'),
    };
    const encrypted = cryptoUtils.criptografarDados(dadosResposta);
    mw.jsonResponse(res, { sucesso: true, data: encrypted }, 200);
}

// ─── API Listar Keys ───
async function AdminAPIListarKeys(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);
    const dados = h.carregarKeysDB();
    const keys = dados.keys || [];
    let totalSalasCriadas = 0;
    for (const keyInfo of keys) {
        if (!keyInfo) continue;
        let usos = h.getFloat(keyInfo, 'usos_totais') || h.getFloat(keyInfo, 'total_usos');
        totalSalasCriadas += usos;
    }
    const dbStats = db.carregarStats();
    let totalSalasIniciadas = 0;
    if (dbStats) {
        totalSalasIniciadas = h.getFloat(dbStats, 'total_salas_iniciadas');
        const dbCriadas = h.getFloat(dbStats, 'total_salas_criadas');
        if (dbCriadas > totalSalasCriadas) totalSalasCriadas = dbCriadas;
    }
    const dadosResposta = { keys, total_salas_criadas: Math.floor(totalSalasCriadas), total_salas_iniciadas: totalSalasIniciadas };
    const encrypted = cryptoUtils.criptografarDados(dadosResposta);
    mw.jsonResponse(res, { sucesso: true, data: encrypted, dados: dadosResposta }, 200);
}

// ─── API Criar Key ───
async function AdminAPICriarKey(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido, dadosReq] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);
    let nome = h.getString(dadosReq, 'nome') || 'Sem nome';
    let limiteUsos = h.getFloat(dadosReq, 'limite_usos') || 10;
    if (limiteUsos < 0) limiteUsos = 10;
    const formato = h.getString(dadosReq, 'formato');
    const customKey = h.getString(dadosReq, 'custom_key');
    let novaKey = (formato === 'custom' && customKey) ? customKey.trim() : cryptoUtils.gerarHashKey();
    const dados = h.carregarKeysDB();
    const keys = dados.keys || [];
    if (keys.some(k => k && h.getString(k, 'key') === novaKey)) {
        return mw.jsonResponse(res, { sucesso: false, erro: 'Key ja existe' }, 200);
    }
    const novaEntrada = { key: novaKey, nome, ativa: true, ilimitada: false, limite_usos: limiteUsos, usos_totais: 0, criada_em: h.obterHoraBrasilia(), ultima_request: null };
    keys.push(novaEntrada);
    dados.keys = keys;
    h.salvarKeysDB(dados);
    const dadosResposta = { key: novaEntrada };
    const encrypted = cryptoUtils.criptografarDados(dadosResposta);
    mw.jsonResponse(res, { sucesso: true, data: encrypted, dados: dadosResposta, key: novaKey }, 200);
}

// ─── API Toggle Key ───
async function AdminAPIToggleKey(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido, dadosReq] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);
    const keyAlvo = h.getString(dadosReq, 'key');
    if (!keyAlvo) return mw.jsonResponse(res, { sucesso: false, erro: 'Key nao informada' }, 200);
    const dados = h.carregarKeysDB();
    for (const keyInfo of (dados.keys || [])) {
        if (!keyInfo || h.getString(keyInfo, 'key') !== keyAlvo) continue;
        keyInfo.ativa = !(keyInfo.ativa !== undefined ? keyInfo.ativa : true);
        h.salvarKeysDB(dados);
        return mw.jsonResponse(res, { sucesso: true, ativa: keyInfo.ativa }, 200);
    }
    mw.jsonResponse(res, { sucesso: false, erro: 'Key nao encontrada' }, 200);
}

// ─── API Deletar Key ───
async function AdminAPIDeletarKey(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido, dadosReq] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);
    const keyAlvo = h.getString(dadosReq, 'key');
    if (!keyAlvo) return mw.jsonResponse(res, { sucesso: false, erro: 'Key nao informada' }, 200);
    
    const dados = h.carregarKeysDB();
    const orig = (dados.keys || []).length;
    dados.keys = (dados.keys || []).filter(k => k && h.getString(k, 'key') !== keyAlvo);
    
    if (dados.keys.length < orig) { 
        // Deletar a key do banco de dados SQL permanentemente
        db.deletarKey(keyAlvo);
        h.salvarKeysDB(dados); 
        return mw.jsonResponse(res, { sucesso: true }, 200); 
    }
    
    mw.jsonResponse(res, { sucesso: false, erro: 'Key nao encontrada' }, 200);
}

// ─── API Adicionar Limite ───
async function AdminAPIAdicionarLimite(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido, dadosReq] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);
    const keyAlvo = h.getString(dadosReq, 'key');
    if (!keyAlvo) return mw.jsonResponse(res, { sucesso: false, erro: 'Key nao informada' }, 200);
    const quantidade = h.getFloat(dadosReq, 'quantidade');
    const dados = h.carregarKeysDB();
    for (const keyInfo of (dados.keys || [])) {
        if (!keyInfo || h.getString(keyInfo, 'key') !== keyAlvo) continue;
        const limiteAtual = h.getFloat(keyInfo, 'limite_usos');
        const novoLimite = Math.max(0, limiteAtual + quantidade);
        keyInfo.limite_usos = novoLimite;
        h.salvarKeysDB(dados);
        const dadosResposta = { limite_anterior: limiteAtual, limite_novo: novoLimite, novo_limite: novoLimite };
        const encrypted = cryptoUtils.criptografarDados(dadosResposta);
        return mw.jsonResponse(res, { sucesso: true, data: encrypted, dados: dadosResposta }, 200);
    }
    mw.jsonResponse(res, { sucesso: false, erro: 'Key nao encontrada' }, 200);
}

// ─── API Operação em Massa ───
async function AdminAPIOperacaoMassa(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido, dadosReq] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);
    const sess = h.getAdminSession(req);
    if (!sess || sess.adminUserID !== h.donoAdminID) return mw.jsonResponse(res, { sucesso: false, erro: 'Apenas o dono pode usar esta funcao' }, 403);
    const modo = h.getString(dadosReq, 'modo');
    const quantidade = h.getFloat(dadosReq, 'quantidade');
    if (quantidade <= 0) return mw.jsonResponse(res, { sucesso: false, erro: 'Quantidade deve ser maior que 0' }, 200);
    if (modo !== 'global' && modo !== 'telegram') return mw.jsonResponse(res, { sucesso: false, erro: "Modo invalido. Use 'global' ou 'telegram'" }, 200);
    const dadosKeys = h.carregarKeysDB();
    const keysLista = dadosKeys.keys || [];
    if (modo === 'global') {
        let atualizadas = 0, ignoradas = 0;
        for (const keyInfo of keysLista) {
            if (!keyInfo) continue;
            const [elegivel] = h.keyElegivel(keyInfo);
            if (elegivel) { keyInfo.limite_usos = h.getFloat(keyInfo, 'limite_usos') + quantidade; atualizadas++; }
            else ignoradas++;
        }
        if (atualizadas > 0) h.salvarKeysDB(dadosKeys);
        return mw.jsonResponse(res, { sucesso: true, resultado: { msg: `Adicionado +${quantidade} salas a todos os usuarios`, keys_atualizadas: atualizadas, keys_ignoradas: ignoradas, total_salas_adicionadas: quantidade * atualizadas } }, 200);
    }
    if (modo === 'telegram') {
        const userKeysMap = db.carregarUserKeys();
        if (!userKeysMap || Object.keys(userKeysMap).length === 0) return mw.jsonResponse(res, { sucesso: false, erro: 'Nenhum usuario do Telegram encontrado' }, 200);
        const keysPorValor = {};
        for (const keyInfo of keysLista) { if (keyInfo) keysPorValor[h.getString(keyInfo, 'key')] = keyInfo; }
        let usuariosAtualizados = 0, usuariosSemKeyElegivel = 0;
        for (const keysList of Object.values(userKeysMap)) {
            if (!Array.isArray(keysList)) continue;
            let encontrou = false;
            for (const ks of keysList) {
                const keyInfo = keysPorValor[String(ks)];
                if (!keyInfo) continue;
                const [elegivel] = h.keyElegivel(keyInfo);
                if (elegivel) { keyInfo.limite_usos = h.getFloat(keyInfo, 'limite_usos') + quantidade; usuariosAtualizados++; encontrou = true; break; }
            }
            if (!encontrou) usuariosSemKeyElegivel++;
        }
        if (usuariosAtualizados > 0) h.salvarKeysDB(dadosKeys);
        return mw.jsonResponse(res, { sucesso: true, resultado: { msg: `Adicionado +${quantidade} salas a todos os usuarios do Telegram`, usuarios_atualizados: usuariosAtualizados, usuarios_ignorados: usuariosSemKeyElegivel, total_salas_adicionadas: quantidade * usuariosAtualizados } }, 200);
    }
}

// ─── API Listar Salas ───
async function AdminAPIListarSalas(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido, dadosReq] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);
    const keyFiltro = h.getString(dadosReq, 'key_filtro');
    const salas = h.carregarSalasDB();
    const salasLista = [];
    for (const [sshash, sala] of Object.entries(salas)) {
        if (!sala || typeof sala !== 'object') continue;
        if (keyFiltro && h.getString(sala, 'oauth_key') !== keyFiltro) continue;
        const sshashTrunc = sshash.length > 16 ? sshash.slice(0, 16) + '...' : sshash;
        let oauthKeyTrunc = h.getString(sala, 'oauth_key');
        if (oauthKeyTrunc.length > 20) oauthKeyTrunc = oauthKeyTrunc.slice(0, 20) + '...';
        salasLista.push({ sshash: sshashTrunc, nome: h.getString(sala, 'nome'), room_id: String(sala.room_id || ''), estado: h.getString(sala, 'estado'), total_players: 0, bot_conectado: false, oauth_key: oauthKeyTrunc, created_at: h.getString(sala, 'created_at') });
    }
    const dadosResposta = { salas: salasLista };
    const encrypted = cryptoUtils.criptografarDados(dadosResposta);
    mw.jsonResponse(res, { sucesso: true, data: encrypted, dados: dadosResposta }, 200);
}

// ─── API Logout ───
function AdminAPILogout(req, res) {
    const sess = h.getAdminSession(req);
    if (sess && sess.adminUserID) {
        const sessions = h.carregarAdminSessions();
        delete sessions[sess.adminUserID];
        h.salvarAdminSessions(sessions);
    }
    h.destroyAdminSession(res, req);
    mw.jsonResponse(res, { sucesso: true }, 200);
}

// ─── API Listar Pagamentos ───
async function AdminAPIListarPagamentos(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);
    const dados = db.carregarPagamentos() || {};
    const listaPag = dados.pagamentos || [];
    const hoje = h.obterHoraBrasilia().slice(0, 10);
    const dataHoje = new Date(hoje + 'T00:00:00');
    
    // Últimos 7 dias (Semanal móvel)
    const inicioSemana = new Date(dataHoje);
    inicioSemana.setDate(dataHoje.getDate() - 7);
    const inicioSemanaStr = inicioSemana.toISOString().slice(0, 10);
    
    // Últimos 30 dias (Mensal móvel)
    const inicioMes = new Date(dataHoje);
    inicioMes.setDate(dataHoje.getDate() - 30);
    const inicioMesStr = inicioMes.toISOString().slice(0, 10);
    
    let pagamentosHoje = 0, totalArrecadado = 0, pagamentosPendentes = 0;
    let lucroDiario = 0, lucroSemanal = 0, lucroMensal = 0, lucroTotal = 0;
    const listaPagamentos = [];
    for (const pag of listaPag) {
        if (!pag) continue;
        const status = h.getString(pag, 'status') || 'PENDENTE';
        const valor = h.getFloat(pag, 'valor');
        const criadoEm = h.getString(pag, 'criado_em');
        const pagoEm = h.getString(pag, 'pago_em');
        if (status === 'PAGO') {
            totalArrecadado += valor; lucroTotal += valor;
            const dataRef = pagoEm || criadoEm;
            if (criadoEm.startsWith(hoje)) pagamentosHoje++;
            if (dataRef.length >= 10) {
                const dataDia = dataRef.slice(0, 10);
                if (dataDia >= hoje) lucroDiario += valor;
                if (dataDia >= inicioSemanaStr) lucroSemanal += valor;
                if (dataDia >= inicioMesStr) lucroMensal += valor;
            }
        } else if (status === 'PENDENTE') pagamentosPendentes++;
        listaPagamentos.push({ txid: h.getString(pag, 'txid'), user_id: h.getString(pag, 'user_id'), nome: h.getString(pag, 'nome'), tipo: h.getString(pag, 'tipo'), quantidade: pag.quantidade, valor, status, criado_em: criadoEm, pago_em: pagoEm });
    }
    mw.jsonResponse(res, { sucesso: true, pagamentos_hoje: pagamentosHoje, total_arrecadado: totalArrecadado, pagamentos_pendentes: pagamentosPendentes, lucro_diario: lucroDiario, lucro_semanal: lucroSemanal, lucro_mensal: lucroMensal, lucro_total: lucroTotal, pagamentos: listaPagamentos }, 200);
}

// ─── API Salvar Config Pagamento ───
async function AdminAPISalvarConfigPagamento(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido, dadosReq] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);
    const configAtual = db.carregarPagamentosConfig() || {};
    for (const k of ['valor_por_sala', 'valor_por_credito', 'minimo_salas', 'minimo_creditos', 'expiracao_pix', 'pagamentos_online']) {
        if (dadosReq[k] !== undefined) configAtual[k] = dadosReq[k];
    }
    if (dadosReq.telegram_contato !== undefined) configAtual.telegram_contato = String(dadosReq.telegram_contato).replace(/@/g, '').trim();
    configAtual.gateway_ativo = 'efi';
    db.salvarPagamentosConfig(configAtual);
    mw.jsonResponse(res, { sucesso: true, msg: 'Configuracoes salvas' }, 200);
}

function APIPagamentoConfigGet(req, res) {
    const defaultConfig = { valor_por_sala: 0.10, valor_por_credito: 0.10, minimo_salas: 20, minimo_creditos: 1, expiracao_pix: 3600, pagamentos_online: true, telegram_contato: 'awstokenbot', gateway_ativo: 'efi' };
    const configArquivo = db.carregarPagamentosConfig();
    if (configArquivo) Object.assign(defaultConfig, configArquivo);
    mw.jsonResponse(res, defaultConfig, 200);
}

// ─── API Editar Key ───
async function AdminAPIEditarKey(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido, dadosReq] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);
    const keyAlvo = h.getString(dadosReq, 'key');
    if (!keyAlvo) return mw.jsonResponse(res, { sucesso: false, erro: 'Key nao informada' }, 200);
    const dados = h.carregarKeysDB();
    for (const keyInfo of (dados.keys || [])) {
        if (!keyInfo || h.getString(keyInfo, 'key') !== keyAlvo) continue;
        for (const k of ['nome', 'limite_usos', 'ilimitada', 'user_id', 'comprado_por']) {
            if (dadosReq[k] !== undefined) keyInfo[k] = dadosReq[k];
        }
        h.salvarKeysDB(dados);
        return mw.jsonResponse(res, { sucesso: true, key: keyInfo }, 200);
    }
    mw.jsonResponse(res, { sucesso: false, erro: 'Key nao encontrada' }, 200);
}

// ─── API Transferir Key ───
async function AdminAPITransferirKey(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido, dadosReq] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);
    const keyAlvo = h.getString(dadosReq, 'key');
    const novoUserID = h.getString(dadosReq, 'novo_user_id');
    if (!keyAlvo || !novoUserID) return mw.jsonResponse(res, { sucesso: false, erro: 'Key e novo_user_id sao obrigatorios' }, 200);
    const dados = h.carregarKeysDB();
    for (const keyInfo of (dados.keys || [])) {
        if (!keyInfo || h.getString(keyInfo, 'key') !== keyAlvo) continue;
        keyInfo.user_id = novoUserID;
        h.salvarKeysDB(dados);
        return mw.jsonResponse(res, { sucesso: true, msg: 'Key transferida com sucesso' }, 200);
    }
    mw.jsonResponse(res, { sucesso: false, erro: 'Key nao encontrada' }, 200);
}

// ─── API Resetar Usos ───
async function AdminAPIResetarUsos(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido, dadosReq] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);
    const keyAlvo = h.getString(dadosReq, 'key');
    if (!keyAlvo) return mw.jsonResponse(res, { sucesso: false, erro: 'Key nao informada' }, 200);
    const dados = h.carregarKeysDB();
    for (const keyInfo of (dados.keys || [])) {
        if (!keyInfo || h.getString(keyInfo, 'key') !== keyAlvo) continue;
        keyInfo.usos_totais = 0;
        h.salvarKeysDB(dados);
        return mw.jsonResponse(res, { sucesso: true }, 200);
    }
    mw.jsonResponse(res, { sucesso: false, erro: 'Key nao encontrada' }, 200);
}

// ─── API Backup ───
function AdminAPIBackup(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    mw.jsonResponse(res, { sucesso: true, msg: 'Backup executado' }, 200);
}

// ─── API Gerenciar Admins ───
async function AdminAPIGerenciarAdmins(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido, dadosReq] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);
    const sess = h.getAdminSession(req);
    if (!sess || sess.adminUserID !== h.donoAdminID) return mw.jsonResponse(res, { sucesso: false, erro: 'Apenas o dono pode gerenciar admins' }, 403);
    const acao = h.getString(dadosReq, 'acao') || 'listar';
    const userID = h.getString(dadosReq, 'user_id');
    const admins = h.carregarAdminsDashboard();
    const adminsMap = admins.admins || {};
    if (acao === 'listar') return mw.jsonResponse(res, { sucesso: true, admins: Object.values(adminsMap) }, 200);
    if (!userID) return mw.jsonResponse(res, { sucesso: false, erro: 'user_id obrigatorio' }, 200);
    if (acao === 'adicionar') {
        adminsMap[userID] = { user_id: userID, adicionado_em: h.obterHoraBrasilia(), cargo: 'admin' };
        admins.admins = adminsMap;
        db.salvarAdminsDashboard(admins);
        return mw.jsonResponse(res, { sucesso: true, msg: 'Admin adicionado' }, 200);
    }
    if (acao === 'remover') {
        if (userID === h.donoAdminID) return mw.jsonResponse(res, { sucesso: false, erro: 'Nao pode remover o dono' }, 200);
        delete adminsMap[userID];
        admins.admins = adminsMap;
        db.salvarAdminsDashboard(admins);
        return mw.jsonResponse(res, { sucesso: true, msg: 'Admin removido' }, 200);
    }
    mw.jsonResponse(res, { sucesso: false, erro: 'Acao invalida' }, 200);
}

// ─── API Fornecedores ───
async function AdminAPIFornecedores(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido, dadosReq] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);
    const fornecedores = db.carregarFornecedores() || { fornecedores: [] };
    mw.jsonResponse(res, { sucesso: true, fornecedores: fornecedores.fornecedores || [] }, 200);
}

// ─── API Avisos ───
async function AdminAPIAvisos(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido, dadosReq] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);
    const acao = h.getString(dadosReq, 'acao') || 'listar';
    let avisosLista = db.carregarAvisosMap() || [];
    const avisos = { avisos: avisosLista };
    if (acao === 'listar') return mw.jsonResponse(res, { sucesso: true, avisos: avisos.avisos }, 200);
    if (acao === 'criar') {
        const novoAviso = { id: String(Date.now()), titulo: h.getString(dadosReq, 'titulo'), conteudo: h.getString(dadosReq, 'conteudo'), criado_em: h.obterHoraBrasilia() };
        const imagem = h.getString(dadosReq, 'imagem');
        if (imagem) novoAviso.imagem = imagem;
        avisos.avisos.push(novoAviso);
        db.salvarAvisosMap(avisos);
        return mw.jsonResponse(res, { sucesso: true, aviso: novoAviso }, 200);
    }
    if (acao === 'deletar') {
        const avisoID = h.getString(dadosReq, 'id');
        avisos.avisos = avisos.avisos.filter(a => a && h.getString(a, 'id') !== avisoID);
        db.salvarAvisosMap(avisos);
        return mw.jsonResponse(res, { sucesso: true }, 200);
    }
    mw.jsonResponse(res, { sucesso: true }, 200);
}

// ─── API Estornar Pagamento ───
async function AdminAPIEstornarPagamento(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido, dadosReq] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);
    const txid = h.getString(dadosReq, 'txid');
    if (!txid) return mw.jsonResponse(res, { sucesso: false, erro: 'txid obrigatorio' }, 200);
    const dados = db.carregarPagamentos() || {};
    for (const pag of (dados.pagamentos || [])) {
        if (!pag || h.getString(pag, 'txid') !== txid) continue;
        pag.status = 'ESTORNADO';
        pag.estornado_em = h.obterHoraBrasilia();
        db.salvarPagamentos(dados);
        return mw.jsonResponse(res, { sucesso: true, msg: 'Pagamento estornado' }, 200);
    }
    mw.jsonResponse(res, { sucesso: false, erro: 'Pagamento nao encontrado' }, 200);
}

// ─── API Telegram VIPs ───
async function AdminAPITelegramVips(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);
    const vips = db.carregarTelegramVips() || { vips: [] };
    mw.jsonResponse(res, { sucesso: true, vips: vips.vips || [] }, 200);
}

// ─── API Salvar/Carregar Config Geral ───
async function AdminAPISalvarConfigGeral(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido, dadosReq] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);
    const configAtual = db.carregarConfigGeral() || {};
    Object.assign(configAtual, dadosReq);
    db.salvarConfigGeral(configAtual);
    mw.jsonResponse(res, { sucesso: true, msg: 'Configuracao salva' }, 200);
}

async function AdminAPICarregarConfig(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);
    const cfg = h.carregarConfiguracao();
    const encrypted = cryptoUtils.criptografarDados(cfg);
    mw.jsonResponse(res, { sucesso: true, data: encrypted, dados: cfg }, 200);
}

async function AdminAPICarregarConfigPagamento(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);
    const configPag = db.carregarPagamentosConfig() || { valor_por_sala: 0.10, valor_por_credito: 0.10, minimo_salas: 20, minimo_creditos: 1, expiracao_pix: 3600, pagamentos_online: true, telegram_contato: 'awstokenbot', gateway_ativo: 'efi' };
    mw.jsonResponse(res, { sucesso: true, config: configPag }, 200);
}

// ─── API Keys Masters ───
async function AdminAPIPartnerKeysList(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);
    const partnerKeysMap = db.carregarPartnerKeys() || {};
    const listaKeys = Object.values(partnerKeysMap);
    const dadosResposta = { keys: listaKeys };
    const encrypted = cryptoUtils.criptografarDados(dadosResposta);
    mw.jsonResponse(res, { sucesso: true, data: encrypted, dados: dadosResposta }, 200);
}

async function AdminAPIPartnerKeysAdd(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido, dadosReq] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);
    const key = h.getString(dadosReq, 'key').trim();
    const nome = h.getString(dadosReq, 'nome').trim();
    if (!key || !nome) {
        return mw.jsonResponse(res, { sucesso: false, erro: 'Preencha todos os campos' }, 200);
    }
    const newEntry = {
        key: key,
        nome: nome,
        ativa: true,
        criada_em: new Date().toISOString().replace('T', ' ').slice(0, 19)
    };
    db.salvarPartnerKey(newEntry);
    mw.jsonResponse(res, { sucesso: true, msg: 'Key Master adicionada com sucesso!' }, 200);
}

async function AdminAPIPartnerKeysDelete(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido, dadosReq] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);
    const key = h.getString(dadosReq, 'key').trim();
    if (!key) {
        return mw.jsonResponse(res, { sucesso: false, erro: 'Chave nao informada' }, 200);
    }
    db.deletarPartnerKey(key);
    mw.jsonResponse(res, { sucesso: true, msg: 'Key Master deletada com sucesso!' }, 200);
}

async function AdminAPIPartnerKeysStats(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido, dadosReq] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);
    
    const key = h.getString(dadosReq, 'key').trim();
    if (!key) {
        return mw.jsonResponse(res, { sucesso: false, erro: 'Chave obrigatoria' }, 200);
    }
    
    const dados = db.carregarPagamentos() || {};
    const listaPag = dados.pagamentos || [];
    
    const hoje = h.obterHoraBrasilia().slice(0, 10);
    const dataHoje = new Date(hoje + 'T00:00:00');
    
    // Últimos 7 dias (Semanal móvel)
    const inicioSemana = new Date(dataHoje);
    inicioSemana.setDate(dataHoje.getDate() - 7);
    const inicioSemanaStr = inicioSemana.toISOString().slice(0, 10);
    
    // Últimos 30 dias (Mensal móvel)
    const inicioMes = new Date(dataHoje);
    inicioMes.setDate(dataHoje.getDate() - 30);
    const inicioMesStr = inicioMes.toISOString().slice(0, 10);
    
    const partnerKeysMap = db.carregarPartnerKeys() || {};
    const keyInfo = partnerKeysMap[key] || {};
    const afiliadoAtivo = keyInfo.afiliado_ativo === true;
    const taxa = keyInfo.afiliado_taxa || 0;

    let pagamentosHoje = 0, totalArrecadado = 0, pagamentosPendentes = 0;
    let lucroDiario = 0, lucroSemanal = 0, lucroMensal = 0, lucroTotal = 0;
    let totalAfiliado = 0, totalSistema = 0;
    let totalCompras = 0, totalFaturamento = 0;
    const listaPagamentos = [];
    
    for (const pag of listaPag) {
        if (!pag) continue;
        
        let keyMatch = pag.partner_key === key;
        // Compatibilidade retroativa para pagamentos antigos da chave padrão
        if (!pag.partner_key && key === 'neonstore7700099aaAHHhhzhha') {
            if (pag.cpf === '56508142879' || pag.nome === 'Rafael') {
                keyMatch = true;
            }
        }
        
        if (!keyMatch) continue;
        
        const status = h.getString(pag, 'status') || 'PENDENTE';
        const valor = h.getFloat(pag, 'valor');
        const criadoEm = h.getString(pag, 'criado_em');
        const pagoEm = h.getString(pag, 'pago_em');
        
        if (status === 'PAGO') {
            totalArrecadado += valor;
            lucroTotal += valor;

            let valAfiliado = pag.valor_afiliado;
            let valSistema = pag.valor_sistema;
            if (valAfiliado === undefined) {
                valAfiliado = afiliadoAtivo ? (valor * (taxa / 100)) : 0;
            }
            if (valSistema === undefined) {
                valSistema = afiliadoAtivo ? (valor - valAfiliado) : valor;
            }
            
            const dataRef = pagoEm || criadoEm;
            if (!keyInfo.reset_lucro_at || dataRef >= keyInfo.reset_lucro_at) {
                totalAfiliado += valAfiliado;
                totalSistema += valSistema;
                totalCompras += (h.getFloat(pag, 'quantidade') || 0);
                totalFaturamento += valor;
            }
            if (criadoEm.startsWith(hoje)) pagamentosHoje++;
            if (dataRef.length >= 10) {
                const dataDia = dataRef.slice(0, 10);
                if (dataDia >= hoje) lucroDiario += valor;
                if (dataDia >= inicioSemanaStr) lucroSemanal += valor;
                if (dataDia >= inicioMesStr) lucroMensal += valor;
            }
        } else if (status === 'PENDENTE') {
            pagamentosPendentes++;
        }
        
        listaPagamentos.push({
            txid: h.getString(pag, 'txid'),
            user_id: h.getString(pag, 'user_id'),
            nome: h.getString(pag, 'nome'),
            tipo: h.getString(pag, 'tipo'),
            quantidade: pag.quantidade,
            valor,
            status,
            criado_em: criadoEm,
            pago_em: pagoEm
        });
    }
    
    const dadosResposta = {
        pagamentos_hoje: pagamentosHoje,
        total_arrecadado: totalArrecadado,
        pagamentos_pendentes: pagamentosPendentes,
        lucro_diario: lucroDiario,
        lucro_semanal: lucroSemanal,
        lucro_mensal: lucroMensal,
        lucro_total: lucroTotal,
        total_afiliado: totalAfiliado,
        total_sistema: totalSistema,
        total_compras: totalCompras,
        total_faturamento: totalFaturamento,
        pagamentos: listaPagamentos
    };
    
    const encrypted = cryptoUtils.criptografarDados(dadosResposta);
    mw.jsonResponse(res, { sucesso: true, data: encrypted, dados: dadosResposta }, 200);
}

async function AdminAPIPartnerKeysSaveConfig(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido, dadosReq] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);
    
    const key = h.getString(dadosReq, 'key').trim();
    if (!key) {
        return mw.jsonResponse(res, { sucesso: false, erro: 'Chave obrigatoria' }, 200);
    }
    
    const partnerKeysMap = db.carregarPartnerKeys() || {};
    const keyInfo = partnerKeysMap[key];
    if (!keyInfo) {
        return mw.jsonResponse(res, { sucesso: false, erro: 'Chave nao encontrada' }, 200);
    }
    
    const valorSala = parseFloat(dadosReq.valor_por_sala);
    if (isNaN(valorSala) || valorSala <= 0) {
        return mw.jsonResponse(res, { sucesso: false, erro: 'Valor por sala invalido' }, 200);
    }
    
    keyInfo.valor_por_sala = valorSala;
    keyInfo.ativa = dadosReq.ativa === true;
    
    const semDesconto = dadosReq.sem_desconto === true;
    keyInfo.sem_desconto = semDesconto;
    if (semDesconto) {
        keyInfo.sem_desconto_expirou = false;
        const dias = parseInt(dadosReq.uso_ilimitado_dias) || 0;
        const horas = parseInt(dadosReq.uso_ilimitado_horas) || 0;
        const minutos = parseInt(dadosReq.uso_ilimitado_minutos) || 0;
        
        if (dias > 0 || horas > 0 || minutos > 0) {
            const totalMs = ((dias * 24 + horas) * 60 + minutos) * 60 * 1000;
            keyInfo.sem_desconto_expira = new Date(Date.now() + totalMs).toISOString();
        } else {
            if (keyInfo.sem_desconto_expira) {
                const jaExpirou = new Date(keyInfo.sem_desconto_expira).getTime() < Date.now();
                if (jaExpirou) {
                    keyInfo.sem_desconto_expira = null;
                }
            } else {
                keyInfo.sem_desconto_expira = null;
            }
        }
    } else {
        keyInfo.sem_desconto_expira = null;
        keyInfo.sem_desconto_expirou = false;
    }
    
    keyInfo.bloquear_compartilhamento = dadosReq.bloquear_compartilhamento === true;
    keyInfo.afiliado_ativo = dadosReq.afiliado_ativo === true;
    keyInfo.afiliado_taxa = dadosReq.afiliado_ativo === true ? (parseFloat(dadosReq.afiliado_taxa) || 0) : 0;
    if (dadosReq.afiliado_pix !== undefined) {
        keyInfo.afiliado_pix = h.getString(dadosReq, 'afiliado_pix').trim();
    }
    
    db.salvarPartnerKey(keyInfo);
    mw.jsonResponse(res, { sucesso: true, msg: 'Configuracoes do parceiro salvas com sucesso!' }, 200);
}

async function AdminAPIPartnerKeysResetLucro(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido, dadosReq] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);
    
    const key = h.getString(dadosReq, 'key').trim();
    if (!key) {
        return mw.jsonResponse(res, { sucesso: false, erro: 'Chave obrigatoria' }, 200);
    }
    
    const partnerKeysMap = db.carregarPartnerKeys() || {};
    const keyInfo = partnerKeysMap[key];
    if (!keyInfo) {
        return mw.jsonResponse(res, { sucesso: false, erro: 'Chave nao encontrada' }, 200);
    }
    
    keyInfo.saldo_afiliado = 0;
    keyInfo.reset_lucro_at = h.obterHoraBrasilia();
    db.salvarPartnerKey(keyInfo);
    mw.jsonResponse(res, { sucesso: true, msg: 'Lucro resetado com sucesso!' }, 200);
}

// ─── API Saque Partner Key (Payout Turbofy) ───
async function AdminAPIPartnerKeysSaque(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido, dadosReq] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);

    const key = h.getString(dadosReq, 'key').trim();
    if (!key) {
        return mw.jsonResponse(res, { sucesso: false, erro: 'Chave obrigatoria' }, 200);
    }

    const partnerKeysMap = db.carregarPartnerKeys() || {};
    const keyInfo = partnerKeysMap[key];
    if (!keyInfo) {
        return mw.jsonResponse(res, { sucesso: false, erro: 'Chave nao encontrada' }, 200);
    }

    const chavePix = (keyInfo.afiliado_pix || '').trim();
    if (!chavePix) {
        return mw.jsonResponse(res, { sucesso: false, erro: 'Nao e possivel realizar o saque pois nao ha nenhuma chave PIX cadastrada nesta Key Master. Por favor, entre em contato com o suporte.' }, 200);
    }

    const lucros = parceria.calcularLucrosParceiro(key);
    const saldoAfiliadoDisponivel = parseFloat((lucros.totalAfiliado || 0).toFixed(2));

    if (saldoAfiliadoDisponivel <= 0) {
        return mw.jsonResponse(res, { sucesso: false, erro: 'Saldo de afiliado zerado. Nao ha lucros disponiveis para saque.' }, 200);
    }

    let valor = saldoAfiliadoDisponivel;
    if (dadosReq.valor !== undefined && dadosReq.valor !== null && dadosReq.valor !== '') {
        const vParsed = parseFloat(dadosReq.valor);
        if (!isNaN(vParsed) && vParsed > 0) {
            if (vParsed > saldoAfiliadoDisponivel) {
                return mw.jsonResponse(res, { sucesso: false, erro: `Valor solicitado (R$ ${vParsed.toFixed(2)}) e maior que o lucro disponivel do afiliado (R$ ${saldoAfiliadoDisponivel.toFixed(2)}).` }, 200);
            }
            valor = vParsed;
        }
    }

    const amountCents = Math.round(valor * 100);
    const recipientName = (keyInfo.nome || 'Afiliado').trim();

    try {
        const resultadoPayout = await turbofyApi.criarLotePayout({
            pixKey: chavePix,
            amountCents: amountCents,
            recipientName: recipientName,
            description: `Saque Afiliado Key ${key} - R$ ${valor.toFixed(2)}`
        });

        keyInfo.saldo_afiliado = 0;
        keyInfo.reset_lucro_at = h.obterHoraBrasilia();
        keyInfo.ultimo_saque = {
            valor: valor,
            chave_pix: chavePix,
            batch_id: resultadoPayout.batchId || null,
            data: h.obterHoraBrasilia()
        };
        db.salvarPartnerKey(keyInfo);

        // Desconta o valor sacado do Saldo no Sistema (Turbofy)
        const configPag = db.carregarPagamentosConfig() || {};
        const saldoSistemaAtual = configPag.turbofy_saldo !== undefined ? parseFloat(configPag.turbofy_saldo) : 0.0;
        configPag.turbofy_saldo = Math.max(0, parseFloat((saldoSistemaAtual - valor).toFixed(2)));
        db.salvarPagamentosConfig(configPag);

        return mw.jsonResponse(res, {
            sucesso: true,
            msg: `Saque de R$ ${valor.toFixed(2)} enviado com sucesso via Turbofy PIX! Saldo do afiliado zerado.`,
            batchId: resultadoPayout.batchId
        }, 200);
    } catch (err) {
        console.error(`[ADMIN SAQUE] Erro ao processar saque para key ${key}:`, err.message);
        return mw.jsonResponse(res, {
            sucesso: false,
            erro: `Erro no envio do PIX Turbofy: ${err.message}`
        }, 200);
    }
}

// ─── API Toggle Pin Partner Key ───
async function AdminAPIPartnerKeysTogglePin(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido, dadosReq] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);

    const key = h.getString(dadosReq, 'key').trim();
    if (!key) {
        return mw.jsonResponse(res, { sucesso: false, erro: 'Chave obrigatoria' }, 200);
    }

    const partnerKeysMap = db.carregarPartnerKeys() || {};
    const keyInfo = partnerKeysMap[key];
    if (!keyInfo) {
        return mw.jsonResponse(res, { sucesso: false, erro: 'Chave nao encontrada' }, 200);
    }

    keyInfo.fixado = !(keyInfo.fixado === true);
    db.salvarPartnerKey(keyInfo);

    const acao = keyInfo.fixado ? 'fixada no topo' : 'desfixada';
    mw.jsonResponse(res, { sucesso: true, fixado: keyInfo.fixado, msg: `Chave ${acao} com sucesso!` }, 200);
}

// ─── API Status Bot (Bridge) ───
async function AdminAPIStatusBot(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);
    apiHandlers.proxyToBridge(res, '/bridge/status', {});
}

// ─── Turbofy Handlers ───
async function AdminAPITurbofyGetInfo(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);

    const configPag = db.carregarPagamentosConfig() || {};
    const saldo = configPag.turbofy_saldo !== undefined ? parseFloat(configPag.turbofy_saldo) : 0.0;
    const depositos = configPag.turbofy_depositos || [];

    const dadosResposta = {
        saldo: saldo,
        depositos: depositos
    };
    const encrypted = cryptoUtils.criptografarDados(dadosResposta);
    mw.jsonResponse(res, { sucesso: true, data: encrypted }, 200);
}

async function AdminAPITurbofyDepositar(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido, dados] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);

    const valor = parseFloat(dados.valor);
    if (isNaN(valor) || valor <= 0) {
        return mw.jsonResponse(res, { sucesso: false, erro: 'Valor inválido para depósito' }, 400);
    }

    const amountCents = Math.round(valor * 100);
    const externalRef = `deposito-turbofy-${Date.now()}`;
    const description = `Depósito de Saldo via Turbofy - R$ ${valor.toFixed(2)}`;

    try {
        const cobranca = await turbofyApi.criarCobrancaPix(amountCents, description, externalRef);
        
        const configPag = db.carregarPagamentosConfig() || {};
        if (!configPag.turbofy_depositos) configPag.turbofy_depositos = [];
        
        let qrCode = cobranca.pix ? cobranca.pix.qrCode : '';
        if (qrCode && !qrCode.startsWith('data:image') && !qrCode.startsWith('http')) {
            qrCode = 'data:image/png;base64,' + qrCode;
        }

        const novoDeposito = {
            id: cobranca.id,
            valor: valor,
            status: cobranca.status || 'PENDING',
            copia_cola: cobranca.pix ? cobranca.pix.copyPaste : '',
            qr_code: qrCode,
            criado_em: h.obterHoraBrasilia(),
            pago_em: null
        };
        
        configPag.turbofy_depositos.unshift(novoDeposito);
        if (configPag.turbofy_depositos.length > 50) {
            configPag.turbofy_depositos = configPag.turbofy_depositos.slice(0, 50);
        }
        db.salvarPagamentosConfig(configPag);

        const dadosResposta = {
            deposito: novoDeposito
        };
        const encrypted = cryptoUtils.criptografarDados(dadosResposta);
        mw.jsonResponse(res, { sucesso: true, data: encrypted }, 200);
    } catch (err) {
        console.error('[TURBOFY DEPOSIT] Erro ao criar cobrança:', err);
        mw.jsonResponse(res, { sucesso: false, erro: err.message }, 500);
    }
}

async function AdminAPITurbofyConsultarPix(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { erro: 'nao autorizado' }, 401);
    const [csrfRecebido, dados] = await adminExtrairCSRFeDados(req);
    if (!verificarCSRFAdmin(req, csrfRecebido)) return mw.jsonResponse(res, { erro: 'csrf invalido' }, 403);

    const depositoId = dados.id;
    if (!depositoId) {
        return mw.jsonResponse(res, { sucesso: false, erro: 'ID do depósito não informado' }, 400);
    }

    try {
        const resultado = await turbofyApi.consultarCobrancaPix(depositoId);
        const statusTurbofy = resultado.status;
        
        const configPag = db.carregarPagamentosConfig() || {};
        const depositos = configPag.turbofy_depositos || [];
        const index = depositos.findIndex(d => d.id === depositoId);
        
        if (index === -1) {
            return mw.jsonResponse(res, { sucesso: false, erro: 'Depósito não localizado localmente' }, 404);
        }
        
        const dep = depositos[index];
        let creditado = false;
        
        if (statusTurbofy === 'PAID') {
            if (dep.status !== 'PAID') {
                dep.status = 'PAID';
                dep.pago_em = h.obterHoraBrasilia();
                
                // Desconta taxa de 2.5% do valor depositado
                const valorLiquido = parseFloat((dep.valor * 0.975).toFixed(2));
                dep.valor_creditado = valorLiquido;
                
                const saldoAtual = configPag.turbofy_saldo !== undefined ? parseFloat(configPag.turbofy_saldo) : 0.0;
                configPag.turbofy_saldo = parseFloat((saldoAtual + valorLiquido).toFixed(2));
                creditado = true;
                
                depositos[index] = dep;
                configPag.turbofy_depositos = depositos;
                db.salvarPagamentosConfig(configPag);
            }
        } else {
            dep.status = statusTurbofy;
            depositos[index] = dep;
            configPag.turbofy_depositos = depositos;
            db.salvarPagamentosConfig(configPag);
        }

        const dadosResposta = {
            deposito: dep,
            creditado: creditado,
            saldo: configPag.turbofy_saldo
        };
        const encrypted = cryptoUtils.criptografarDados(dadosResposta);
        mw.jsonResponse(res, { sucesso: true, data: encrypted }, 200);
    } catch (err) {
        console.error('[TURBOFY QUERY] Erro ao consultar Pix:', err);
        mw.jsonResponse(res, { sucesso: false, erro: err.message }, 500);
    }
}

module.exports = {
    AdminRedirecionarOAuth, AdminOAuthCallback, AdminPagina, AdminErroAcesso,
    AdminServirCSS, AdminServirJS, AdminAPIVerificarSessao, AdminAPIMe,
    AdminAPIListarKeys, AdminAPICriarKey, AdminAPIToggleKey, AdminAPIDeletarKey,
    AdminAPIAdicionarLimite, AdminAPIOperacaoMassa, AdminAPIListarSalas, AdminAPILogout,
    AdminAPIListarPagamentos, AdminAPISalvarConfigPagamento, APIPagamentoConfigGet,
    AdminAPIEditarKey, AdminAPITransferirKey, AdminAPIResetarUsos, AdminAPIBackup,
    AdminAPIGerenciarAdmins, AdminAPIFornecedores, AdminAPIAvisos, AdminAPIEstornarPagamento,
    AdminAPITelegramVips, AdminAPISalvarConfigGeral, AdminAPICarregarConfig, AdminAPICarregarConfigPagamento,
    AdminAPIPartnerKeysList, AdminAPIPartnerKeysAdd, AdminAPIPartnerKeysDelete,
    AdminAPIPartnerKeysStats, AdminAPIPartnerKeysSaveConfig, AdminAPIPartnerKeysResetLucro,
    AdminAPIStatusBot,
    AdminAPIPartnerKeysTogglePin,
    AdminAPIPartnerKeysSaque,
    AdminAPITurbofyGetInfo, AdminAPITurbofyDepositar, AdminAPITurbofyConsultarPix,
};
