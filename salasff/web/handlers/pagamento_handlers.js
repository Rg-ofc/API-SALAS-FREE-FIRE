/**
 * pagamento_handlers.js — Payment handlers (PIX, saldo, keys, fornecedores, admin)
 * Convertido de internal/http/handlers/pagamento_handlers.go
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const config = require('../config');
const cryptoUtils = require('../crypto_utils');
const mw = require('../middleware/middleware');
const h = require('./helpers');
const db = require('../../db_postgres');
const efiPix = require('./efi_pix');

const WEBHOOK_CREDITO = '';
const WEBHOOK_COMPRA_SALA = '';
const WEBHOOK_SALA_INICIADA = '';

const rateLimitMap = new Map();

// ─── Utility helpers ───
function gerarTokenHex(n) { return crypto.randomBytes(n).toString('hex'); }

function limparCPF(cpf) { return (cpf || '').replace(/[^0-9]/g, ''); }

function validarCPF(cpf) {
    const c = limparCPF(cpf);
    if (c.length !== 11) return false;
    if (/^(\d)\1{10}$/.test(c)) return false;
    let soma = 0;
    for (let i = 0; i < 9; i++) soma += parseInt(c[i]) * (10 - i);
    let resto = (soma * 10) % 11; if (resto === 10) resto = 0;
    if (resto !== parseInt(c[9])) return false;
    soma = 0;
    for (let i = 0; i < 10; i++) soma += parseInt(c[i]) * (11 - i);
    resto = (soma * 10) % 11; if (resto === 10) resto = 0;
    return resto === parseInt(c[10]);
}

function gerarEmailPagador(nome, cpfLimpo) {
    let n = (nome || '').toLowerCase().trim()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z\s]/g, '');
    const partes = n.split(/\s+/).filter(Boolean);
    if (partes.length === 0) return cpfLimpo.length >= 4 ? `cliente_${cpfLimpo.slice(-4)}@pagamento.com` : 'cliente@pagamento.com';
    if (partes.length === 1) return cpfLimpo.length >= 4 ? `${partes[0]}.${cpfLimpo.slice(-4)}@pagamento.com` : `${partes[0]}@pagamento.com`;
    return `${partes[0]}.${partes[partes.length - 1]}@pagamento.com`;
}

function verificarRateLimit(userID) {
    const agora = Date.now();
    let times = rateLimitMap.get(userID) || [];
    times = times.filter(t => agora - t < 3600000);
    const contagemMinuto = times.filter(t => agora - t < 60000).length;
    if (contagemMinuto >= 5 || times.length >= 20) { rateLimitMap.set(userID, times); return true; }
    times.push(agora);
    rateLimitMap.set(userID, times);
    return false;
}

function getFloatDefault(m, key, def) { const v = h.getFloat(m, key); return v === 0 ? def : v; }
function getStringDefault(m, key, def) { const v = h.getString(m, key); return v || def; }
function getBoolDefault(m, key, def) { if (m && key in m && typeof m[key] === 'boolean') return m[key]; return def; }
function getOrDefault(m, key, def) { return (m && m[key] != null) ? m[key] : def; }

// ─── Saldos ───
function carregarSaldos() {
    const s = db.carregarSaldos() || { usuarios: {} };
    if (!s.usuarios) s.usuarios = {};
    return s;
}
function obterSaldoUsuario(saldos, userID) {
    if (!saldos.usuarios) saldos.usuarios = {};
    if (!saldos.usuarios[userID] || typeof saldos.usuarios[userID] !== 'object') {
        saldos.usuarios[userID] = { creditos: 0, total_gasto: 0, total_salas_compradas: 0 };
    }
    return saldos.usuarios[userID];
}
function salvarSaldos(saldos) { db.salvarSaldos(saldos); }
function adicionarCreditosAoUsuario(userID, quantidade) {
    const saldos = carregarSaldos();
    const us = obterSaldoUsuario(saldos, userID);
    us.creditos = getFloatDefault(us, 'creditos', 0) + quantidade;
    salvarSaldos(saldos);
}

// ─── Fornecedores ───
function verificarFornecedorVip(userID) {
    const vips = db.carregarTelegramVips();
    if (!vips) return false;
    const vipsMap = vips.vips;
    if (typeof vipsMap === 'object' && !Array.isArray(vipsMap) && vipsMap) {
        const info = vipsMap[userID];
        if (info && typeof info === 'object') {
            if (h.getString(info, 'tipo') === 'permanente') return true;
            const expiraEm = h.getString(info, 'expira_em');
            if (expiraEm) { try { if (new Date(expiraEm) > new Date()) return true; } catch {} }
        }
    }
    return false;
}

function verificarFornecedor(userID) {
    const fornecedores = db.carregarFornecedores();
    if (fornecedores) {
        const lista = fornecedores.fornecedores || [];
        for (const f of lista) {
            if (typeof f === 'string' && f === userID) return true;
            if (typeof f === 'object' && f && h.getString(f, 'user_id') === userID) return true;
        }
    }
    const vips = db.carregarTelegramVips();
    if (vips) {
        const vipsMap = vips.vips;
        if (typeof vipsMap === 'object' && !Array.isArray(vipsMap) && vipsMap) {
            if (vipsMap[userID]) {
                const info = typeof vipsMap[userID] === 'object' ? vipsMap[userID] : {};
                if (h.getString(info, 'tipo') === 'permanente') return true;
                const expiraEm = h.getString(info, 'expira_em');
                if (expiraEm) { try { if (new Date(expiraEm) > new Date()) return true; } catch {} }
            }
            for (const v of Object.values(vipsMap)) {
                if (typeof v === 'object' && v && h.getString(v, 'user_id') === userID) {
                    if (h.getString(v, 'tipo') === 'permanente') return true;
                    const expiraEm = h.getString(v, 'expira_em');
                    if (expiraEm) { try { if (new Date(expiraEm) > new Date()) return true; } catch {} }
                }
            }
        }
    }
    return false;
}

function registrarVendaFornecedor(userID, valor) {
    const fornecedores = db.carregarFornecedores();
    if (!fornecedores) return;
    const lista = fornecedores.fornecedores || [];
    let modificado = false;
    for (let i = 0; i < lista.length; i++) {
        let forn = lista[i];
        let fornUserID = '';
        if (typeof forn === 'string') { if (forn === userID) fornUserID = forn; }
        else if (typeof forn === 'object' && forn) fornUserID = h.getString(forn, 'user_id');
        if (fornUserID !== userID) continue;
        if (typeof forn !== 'object') forn = { user_id: userID };
        if (h.getString(forn, 'is_vip') === 'true') return;
        let vendasPeriodo = getFloatDefault(forn, 'vendas_periodo', 0) + valor;
        forn.vendas_periodo = vendasPeriodo;
        if (vendasPeriodo >= 20.0) {
            forn.ultimo_reset = h.obterHoraBrasilia();
            forn.vendas_periodo = 0;
            console.log(`  \x1b[92m[FORNECEDOR]\x1b[0m ${userID} atingiu R$20 em vendas - timer resetado`);
        }
        lista[i] = forn;
        modificado = true;
        break;
    }
    if (modificado) { fornecedores.fornecedores = lista; db.salvarFornecedores(fornecedores); }
}

function LimparFornecedoresExpirados() {
    const fornecedores = db.carregarFornecedores();
    if (!fornecedores) return;
    const lista = fornecedores.fornecedores || [];
    if (lista.length === 0) return;
    const agora = new Date();
    const novaLista = [];
    let removidos = 0;
    for (const f of lista) {
        const forn = typeof f === 'object' ? f : { user_id: f };
        if (h.getString(forn, 'is_vip') === 'true') { novaLista.push(forn); continue; }
        const userID = h.getString(forn, 'user_id');
        if (verificarFornecedorVip(userID)) { novaLista.push(forn); continue; }
        let ultimoReset = h.getString(forn, 'ultimo_reset') || h.getString(forn, 'criado_em');
        if (!ultimoReset) { removidos++; continue; }
        try {
            const t = new Date(ultimoReset);
            if (agora - t > 7 * 24 * 3600 * 1000) { removidos++; console.log(`  \x1b[93m[FORNECEDOR]\x1b[0m Removido ${userID}`); continue; }
        } catch { novaLista.push(forn); continue; }
        novaLista.push(forn);
    }
    if (removidos > 0) {
        fornecedores.fornecedores = novaLista;
        db.salvarFornecedores(fornecedores);
        console.log(`  \x1b[93m[FORNECEDOR]\x1b[0m ${removidos} fornecedor(es) removido(s) por inatividade`);
    }
}

function IniciarLimpezaFornecedores() {
    setTimeout(() => { LimparFornecedoresExpirados(); setInterval(LimparFornecedoresExpirados, 3600000); }, 300000);
    console.log(`  \x1b[92m[FORNECEDOR]\x1b[0m Limpeza automatica iniciada (a cada 1h)`);
    
    // Iniciar verificação automática de pagamentos pendentes em segundo plano a cada 30 segundos
    setInterval(verificarPagamentosPendentesBackground, 30000);
    console.log(`  \x1b[92m[PAGAMENTOS]\x1b[0m Loop de verificacao automatica iniciado (a cada 30s)`);
}

async function verificarPagamentosPendentesBackground() {
    const pagDados = db.carregarPagamentos();
    if (!pagDados) return;
    const pagamentos = pagDados.pagamentos || [];
    
    let houveAlteracao = false;
    const agora = Date.now();
    
    for (let i = 0; i < pagamentos.length; i++) {
        const pag = pagamentos[i];
        if (!pag || h.getString(pag, 'status') !== 'PENDENTE') continue;
        
        // 1. Verificar se expirou com segurança
        let expirou = false;
        let expireMs = NaN;
        if (pag.expires_at) {
            expireMs = Date.parse(pag.expires_at);
        }
        
        if (isNaN(expireMs) && pag.criado_em) {
            try {
                // Tenta formatar YYYY-MM-DD HH:MM:SS para ISO 8601 com fuso de Brasília (-03:00)
                const cleanCriado = pag.criado_em.trim().replace(' ', 'T').replace(/\//g, '-') + '-03:00';
                expireMs = Date.parse(cleanCriado) + 15 * 60 * 1000; // 15 min de tolerância
            } catch (e) {}
        }
        
        if (!isNaN(expireMs)) {
            expirou = agora > expireMs;
        }
        
        if (expirou) {
            pag.status = 'CANCELADA'; // Marca como cancelada/expirada no banco
            pagamentos[i] = pag;
            houveAlteracao = true;
            console.log(`  \x1b[90m[PAGAMENTOS]\x1b[0m Pagamento ${pag.id} de ${pag.user_id} expirou e foi marcado como CANCELADA`);
            continue;
        }
        
        // 2. Verificar na API se foi pago (apenas se for EFI)
        // Damos suporte a pagamentos antigos sem a propriedade gateway definida mas que possuem txid (são EFI)
        if (pag.txid && (pag.gateway === 'efi' || !pag.gateway)) {
            try {
                const resCheck = await efiPix.verificarPagamentoEfi(pag.txid);
                if (resCheck && h.getString(resCheck, 'status') === 'CONCLUIDA') {
                    // Foi pago! Marca e concede os créditos
                    pag.status = 'PAGO';
                    pag.pago_em = h.obterHoraBrasilia();
                    
                    let keyGerada = '';
                    if (pag.partner_key || pag.user_id.startsWith('discord_')) {
                        // Reseller payment
                        const par = require('./parceria_handlers.js');
                        keyGerada = par.processarPagamentoConfirmadoParceria(
                            pag.user_id.replace('discord_', ''), 
                            pag.quantidade, 
                            pag.valor,
                            pag.partner_key,
                            pag
                        );
                    } else {
                        // User dashboard payment
                        keyGerada = processarPagamentoConfirmado(pag);
                    }
                    
                    if (keyGerada) pag.key_gerada = keyGerada;
                    pagamentos[i] = pag;
                    houveAlteracao = true;
                    
                    console.log(`  \x1b[92m\x1b[1m[PAGAMENTOS]\x1b[0m Pagamento ${pag.id} de ${pag.user_id} detectado como PAGO no background`);
                }
            } catch (e) {
                // Silently fail connection errors to retry next loop
            }
        }
    }
    
    if (houveAlteracao) {
        pagDados.pagamentos = pagamentos;
        db.salvarPagamentos(pagDados);
    }
}

// ─── Webhooks Discord ───
function enviarWebhookDiscord(url, payload) {
    if (!url) return;
    try {
        const data = JSON.stringify(payload);
        const u = new URL(url);
        const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 5000 });
        req.on('error', () => {});
        req.write(data);
        req.end();
    } catch {}
}

function obterAvatarUsuario(userID) {
    const dados = h.carregarUsuarios();
    for (const u of (dados.usuarios || [])) {
        if (u && h.getString(u, 'user_id') === userID) return [h.getString(u, 'avatar'), h.getString(u, 'username')];
    }
    return ['', 'Usuario'];
}

function enviarWebhookCredito(nome, cpf, ip, creditos, valor, txid, userID, avatar) {
    const cpfCortado = cpf.length >= 11 ? cpf.slice(0, 3) + '.***.***-' + cpf.slice(-2) : '***';
    const embed = { author: { name: 'Credito Adicionado' }, description: `**Usuario:** ${nome}\n**User ID:** \`${userID}\`\n**CPF:** \`${cpfCortado}\` | **IP:** \`${ip}\``, color: 0x57F287, fields: [{ name: '\u{1F4B0} Creditos', value: `\`+${creditos}\``, inline: true }, { name: '\u{1F4B5} Valor', value: `\`R$ ${valor.toFixed(2)}\``, inline: true }, { name: '\u{1F4DD} TXID', value: `\`${txid}\``, inline: false }], footer: { text: 'Salas FF' }, timestamp: new Date().toISOString() };
    enviarWebhookDiscord(WEBHOOK_CREDITO, { embeds: [embed] });
}

function enviarWebhookCompraSala(nome, cpf, ip, quantidade, valor, txid, userID, avatar, keyGerada) {
    const cpfCortado = cpf.length >= 11 ? cpf.slice(0, 3) + '.***.***-' + cpf.slice(-2) : '***';
    const embed = { author: { name: 'Compra de Salas' }, description: `**Usuario:** ${nome}\n**User ID:** \`${userID}\`\n**CPF:** \`${cpfCortado}\` | **IP:** \`${ip}\``, color: 0x5865F2, fields: [{ name: '\u{1F3E0} Quantidade', value: `\`${quantidade} sala(s)\``, inline: true }, { name: '\u{1F4B5} Valor', value: `\`R$ ${valor.toFixed(2)}\``, inline: true }, { name: '\u{1F511} Key Gerada', value: `\`${keyGerada}\``, inline: false }, { name: '\u{1F4DD} TXID', value: `\`${txid}\``, inline: false }], footer: { text: 'Salas FF' }, timestamp: new Date().toISOString() };
    enviarWebhookDiscord(WEBHOOK_COMPRA_SALA, { embeds: [embed] });
}

// ─── Sessão de pagamento ───
async function pagamentoValidarSessao(req, res) {
    const cookies = mw.parseCookies(req);
    const token = cookies.dash_session || '';
    if (!token) { mw.jsonResponse(res, { sucesso: false, erro: 'NAO_AUTENTICADO', msg: 'Voce precisa estar logado' }, 401); return null; }
    const sessao = h.validarSessaoDashboard(token);
    if (!sessao) { mw.jsonResponse(res, { sucesso: false, erro: 'SESSAO_INVALIDA', msg: 'Sua sessao expirou' }, 401); return null; }
    const corpo = await mw.parseBody(req);
    const csrfToken = h.getString(corpo, '_csrf');
    if (!csrfToken) { mw.jsonResponse(res, { sucesso: false, erro: 'CSRF_AUSENTE', msg: 'Token de seguranca ausente' }, 403); return null; }
    if (!h.validarCSRFDashboard(token, csrfToken)) { mw.jsonResponse(res, { sucesso: false, erro: 'CSRF_INVALIDO', msg: 'Token de seguranca invalido' }, 403); return null; }
    const userID = h.getString(sessao, 'user_id');
    const dados = (typeof corpo.dados === 'object' && corpo.dados) ? corpo.dados : {};
    return { userID, dados, corpo };
}

// ─── processarPagamentoConfirmado ───
function processarPagamentoConfirmado(pagamento) {
    const tipo = h.getString(pagamento, 'tipo');
    const quantidade = h.getFloat(pagamento, 'quantidade');
    const userID = h.getString(pagamento, 'user_id');
    const valor = h.getFloat(pagamento, 'valor');
    const destinoUserID = h.getString(pagamento, 'destino_user_id');
    if (!userID || !tipo) return '';
    const userIDKey = destinoUserID || userID;
    const saldos = carregarSaldos();
    const us = obterSaldoUsuario(saldos, userID);
    us.total_gasto = getFloatDefault(us, 'total_gasto', 0) + valor;
    if (tipo === 'salas') us.total_salas_compradas = getFloatDefault(us, 'total_salas_compradas', 0) + Math.floor(quantidade);
    salvarSaldos(saldos);
    registrarVendaFornecedor(userID, valor);
    if (tipo === 'salas') {
        const keysData = h.carregarKeysDB();
        const hashKey = gerarTokenHex(8).toUpperCase();
        const novaKey = 'FFSL-' + hashKey;
        let nomeKey = `Key Comprada - ${Math.floor(quantidade)} salas`;
        if (destinoUserID && destinoUserID !== userID) nomeKey = `Key Recebida - ${Math.floor(quantidade)} salas (de ${userID})`;
        const novaKeyInfo = { key: novaKey, nome: nomeKey, ativa: true, ilimitada: false, limite_usos: Math.floor(quantidade), usos_totais: 0, criada_em: h.obterHoraBrasilia(), ultima_request: null, user_id: userIDKey, comprado_por: destinoUserID ? userID : null };
        const keys = keysData.keys || [];
        keys.push(novaKeyInfo);
        keysData.keys = keys;
        h.salvarKeysDB(keysData);
        console.log(`  \x1b[96m\x1b[1mSALA\x1b[0m \x1b[97m${userIDKey}\x1b[0m \x1b[90mcriou\x1b[0m \x1b[96m${Math.floor(quantidade)} sala(s)\x1b[0m`);
        return novaKey;
    } else if (tipo === 'saldo' || tipo === 'saldo-credito') {
        adicionarCreditosAoUsuario(userIDKey, Math.floor(quantidade));
        console.log(`  \x1b[92m\x1b[1mSALDO\x1b[0m \x1b[97m${userIDKey}\x1b[0m \x1b[90m+${Math.floor(quantidade)} creditos\x1b[0m`);
        return '';
    }
    return '';
}

// ─── Payment Handlers ───
async function PagamentoConfig(req, res) {
    const sess = await pagamentoValidarSessao(req, res); if (!sess) return;
    const configPag = db.carregarPagamentosConfig() || {};
    mw.jsonResponse(res, { sucesso: true, valor_por_sala: getFloatDefault(configPag, 'valor_por_sala', 0.10), valor_por_credito: getFloatDefault(configPag, 'valor_por_credito', 0.10), minimo_salas: getFloatDefault(configPag, 'minimo_salas', 20), conversao: getOrDefault(configPag, 'conversao_creditos', { reais: 3, creditos: 30 }), pagamentos_online: getBoolDefault(configPag, 'pagamentos_online', true), telegram_contato: getStringDefault(configPag, 'telegram_contato', 'awstokenbot'), gateway_ativo: getStringDefault(configPag, 'gateway_ativo', 'efi') }, 200);
}

async function PagamentoSaldo(req, res) {
    const sess = await pagamentoValidarSessao(req, res); if (!sess) return;
    const saldos = carregarSaldos();
    const us = obterSaldoUsuario(saldos, sess.userID);
    mw.jsonResponse(res, { sucesso: true, creditos: getFloatDefault(us, 'creditos', 0), total_gasto: getFloatDefault(us, 'total_gasto', 0), total_salas_compradas: getFloatDefault(us, 'total_salas_compradas', 0) }, 200);
}

async function CriarPagamento(req, res) {
    const sess = await pagamentoValidarSessao(req, res); if (!sess) return;
    const { userID, dados } = sess;
    const configPag = db.carregarPagamentosConfig() || { valor_por_sala: 0.10, valor_por_credito: 0.10, pagamentos_online: true, gateway_ativo: 'efi' };
    if (!getBoolDefault(configPag, 'pagamentos_online', true)) {
        const tc = getStringDefault(configPag, 'telegram_contato', 'awstokenbot');
        return mw.jsonResponse(res, { sucesso: false, erro: 'PAGAMENTOS_OFFLINE', msg: `Pagamento automatico esta temporariamente indisponivel. Entre em contato pelo Telegram @${tc}` }, 503);
    }
    if (!verificarFornecedor(userID)) return mw.jsonResponse(res, { sucesso: false, erro: 'ACESSO_NEGADO', msg: 'Apenas fornecedores podem criar pagamentos.' }, 403);
    if (verificarRateLimit(userID)) return mw.jsonResponse(res, { sucesso: false, erro: 'RATE_LIMIT', msg: 'Muitas tentativas. Aguarde um momento.' }, 429);
    const tipo = h.getString(dados, 'tipo');
    let quantidade = h.getFloat(dados, 'quantidade');
    const cpf = h.getString(dados, 'cpf');
    const nome = h.getString(dados, 'nome');
    const destinoUserID = (h.getString(dados, 'destino_user_id') || '').trim();
    if (!tipo || !['salas', 'saldo', 'saldo-credito'].includes(tipo)) return mw.jsonResponse(res, { sucesso: false, erro: 'TIPO_INVALIDO', msg: 'Tipo de compra invalido' }, 400);
    if (quantidade <= 0) return mw.jsonResponse(res, { sucesso: false, erro: 'QUANTIDADE_INVALIDA', msg: 'Quantidade deve ser maior que zero' }, 400);
    if (quantidade > 10000) return mw.jsonResponse(res, { sucesso: false, erro: 'QUANTIDADE_EXCEDIDA', msg: 'Quantidade maxima por compra e 10.000' }, 400);
    quantidade = Math.floor(quantidade);
    const cpfLimpo = limparCPF(cpf);
    if (!cpfLimpo || !validarCPF(cpfLimpo)) return mw.jsonResponse(res, { sucesso: false, erro: 'CPF_INVALIDO', msg: 'CPF invalido.' }, 400);
    if (!nome || nome.length < 3) return mw.jsonResponse(res, { sucesso: false, erro: 'NOME_INVALIDO', msg: 'Nome deve ter pelo menos 3 caracteres' }, 400);
    const valorPorSala = getFloatDefault(configPag, 'valor_por_sala', 0.10);
    const valorPorCredito = getFloatDefault(configPag, 'valor_por_credito', 0.10);
    let valor, descricao;
    if (tipo === 'salas') { valor = quantidade * valorPorSala; descricao = `Compra de ${quantidade} salas - Salas FF`; }
    else if (tipo === 'saldo-credito') { valor = quantidade; descricao = `Saldo Bot - R$ ${valor.toFixed(2)} - Salas FF`; }
    else { valor = quantidade * valorPorCredito; descricao = `Adicionar ${quantidade} creditos - Salas FF`; }
    if (valor < 0.01) return mw.jsonResponse(res, { sucesso: false, erro: 'VALOR_MINIMO', msg: 'Valor minimo e R$ 0,01' }, 400);
    const respostaPix = await efiPix.criarCobrancaPixEfi(valor, cpf, nome, descricao);
    if (respostaPix.erro) return mw.jsonResponse(res, { sucesso: false, erro: 'ERRO_PIX', msg: respostaPix.erro }, 500);
    const txid = h.getString(respostaPix, 'txid');
    const qrcodeImg = h.getString(respostaPix, 'qrcode_imagem');
    const qrcodeTexto = h.getString(respostaPix, 'qrcode_texto');
    const linkPagamento = h.getString(respostaPix, 'link_pagamento');
    const expiracaoPix = getFloatDefault(respostaPix, 'expiracao', 3600);
    const cpfMascarado = cpfLimpo.length >= 5 ? cpfLimpo.slice(0, 3) + '***' + cpfLimpo.slice(-2) : '***';
    const pagamento = { id: gerarTokenHex(8), txid, user_id: userID, tipo, quantidade, valor, cpf: cpfMascarado, nome, status: 'PENDENTE', criado_em: h.obterHoraBrasilia(), pago_em: null, qrcode_imagem: qrcodeImg, qrcode_texto: qrcodeTexto, link_pagamento: linkPagamento, destino_user_id: destinoUserID, gateway: 'efi' };
    const pagDados = db.carregarPagamentos() || { pagamentos: [] };
    const pagamentos = pagDados.pagamentos || [];
    pagamentos.push(pagamento);
    pagDados.pagamentos = pagamentos;
    db.salvarPagamentos(pagDados);
    const txidShort = txid.length > 12 ? txid.slice(0, 12) + '...' : txid;
    console.log(`  \x1b[94m\x1b[1mPIX\x1b[0m \x1b[90mCobranca criada\x1b[0m \x1b[92mR$${valor.toFixed(2)}\x1b[0m \x1b[2m(${txidShort})\x1b[0m`);
    mw.jsonResponse(res, { sucesso: true, txid, valor, qrcode_imagem: qrcodeImg, qrcode_texto: qrcodeTexto, link_pagamento: linkPagamento, expiracao: expiracaoPix }, 200);
}

async function VerificarPagamento(req, res) {
    const sess = await pagamentoValidarSessao(req, res); if (!sess) return;
    const { userID, dados } = sess;
    const txid = h.getString(dados, 'txid');
    if (!txid || txid.length < 5) return mw.jsonResponse(res, { sucesso: false, erro: 'TXID_INVALIDO', msg: 'Identificador de pagamento invalido' }, 400);
    let pagDados = db.carregarPagamentos();
    if (!pagDados) return mw.jsonResponse(res, { sucesso: false, erro: 'PAGAMENTO_NAO_ENCONTRADO', msg: 'Pagamento nao encontrado' }, 404);
    let pagamentos = pagDados.pagamentos || [];
    let pagEncontrado = pagamentos.find(p => p && h.getString(p, 'txid') === txid && h.getString(p, 'user_id') === userID);
    if (!pagEncontrado) return mw.jsonResponse(res, { sucesso: false, erro: 'PAGAMENTO_NAO_ENCONTRADO', msg: 'Pagamento nao encontrado' }, 404);
    if (h.getString(pagEncontrado, 'status') === 'PAGO') return mw.jsonResponse(res, { sucesso: true, status: 'PAGO', msg: 'Pagamento ja foi processado', tipo: h.getString(pagEncontrado, 'tipo'), quantidade: h.getFloat(pagEncontrado, 'quantidade'), key_gerada: pagEncontrado.key_gerada }, 200);
    const respostaGateway = await efiPix.verificarPagamentoEfi(txid);
    if (respostaGateway.erro) return mw.jsonResponse(res, { sucesso: false, erro: 'ERRO_VERIFICACAO', msg: respostaGateway.erro }, 500);
    const statusPix = h.getString(respostaGateway, 'status');
    if (statusPix === 'CONCLUIDA') {
        pagDados = db.carregarPagamentos();
        pagamentos = pagDados.pagamentos || [];
        for (let i = 0; i < pagamentos.length; i++) {
            const pag = pagamentos[i];
            if (!pag || h.getString(pag, 'txid') !== txid) continue;
            if (h.getString(pag, 'status') === 'PAGO') return mw.jsonResponse(res, { sucesso: true, status: 'PAGO', msg: 'Pagamento ja foi processado', tipo: h.getString(pag, 'tipo'), quantidade: h.getFloat(pag, 'quantidade'), key_gerada: pag.key_gerada }, 200);
            pag.status = 'PAGO'; pag.pago_em = h.obterHoraBrasilia();
            let keyGerada = '';
            if (pag.partner_key || pag.user_id.startsWith('discord_')) {
                const par = require('./parceria_handlers.js');
                keyGerada = par.processarPagamentoConfirmadoParceria(pag.user_id.replace('discord_', ''), pag.quantidade, pag.valor, pag.partner_key, pag);
            } else {
                keyGerada = processarPagamentoConfirmado(pag);
            }
            if (keyGerada) pag.key_gerada = keyGerada;
            pagamentos[i] = pag; pagDados.pagamentos = pagamentos;
            db.salvarPagamentos(pagDados);
            console.log(`  \x1b[92m\x1b[1mPAGO\x1b[0m \x1b[97m${h.getString(pag, 'user_id')}\x1b[0m \x1b[90mconfirmou pagamento\x1b[0m`);
            setImmediate(() => {
                const [pAvatar, pUsername] = obterAvatarUsuario(h.getString(pag, 'user_id'));
                const pNome = h.getString(pag, 'nome') || pUsername;
                const pCPF = h.getString(pag, 'cpf') || '***';
                const pIP = (req.socket && req.socket.remoteAddress) || 'Desconhecido';
                if (h.getString(pag, 'tipo') === 'saldo') enviarWebhookCredito(pNome, pCPF, pIP, h.getFloat(pag, 'quantidade'), h.getFloat(pag, 'valor'), txid, h.getString(pag, 'user_id'), pAvatar);
                else if (h.getString(pag, 'tipo') === 'salas' && keyGerada) enviarWebhookCompraSala(pNome, pCPF, pIP, h.getFloat(pag, 'quantidade'), h.getFloat(pag, 'valor'), txid, h.getString(pag, 'user_id'), pAvatar, keyGerada);
            });
            return mw.jsonResponse(res, { sucesso: true, status: 'PAGO', msg: 'Pagamento confirmado com sucesso!', tipo: h.getString(pag, 'tipo'), quantidade: h.getFloat(pag, 'quantidade'), key_gerada: keyGerada || null }, 200);
        }
    }
    mw.jsonResponse(res, { sucesso: true, status: statusPix, msg: 'Aguardando pagamento...' }, 200);
}

async function VerificarPagamentoAuto(req, res) {
    const sess = await pagamentoValidarSessao(req, res); if (!sess) return;
    const { userID } = sess;
    let pagDados = db.carregarPagamentos();
    if (!pagDados) return mw.jsonResponse(res, { sucesso: true, verificados: 0, confirmados: 0, pagamentos: [] }, 200);
    const pagamentos = pagDados.pagamentos || [];
    const pendentes = pagamentos.filter(p => p && h.getString(p, 'user_id') === userID && (h.getString(p, 'status') === 'PENDENTE' || h.getString(p, 'status') === 'CANCELADA'));
    const pagamentosConfirmados = [];
    const maxVerificar = Math.min(pendentes.length, 10);
    for (let idx = 0; idx < maxVerificar; idx++) {
        const pag = pendentes[idx];
        const txid = h.getString(pag, 'txid');
        const respostaGateway = await efiPix.verificarPagamentoEfi(txid);
        if (respostaGateway.erro) continue;
        if (h.getString(respostaGateway, 'status') !== 'CONCLUIDA') continue;
        pagDados = db.carregarPagamentos();
        const pags = pagDados.pagamentos || [];
        for (let i = 0; i < pags.length; i++) {
            const pagDB = pags[i];
            if (!pagDB || h.getString(pagDB, 'txid') !== txid || h.getString(pagDB, 'status') === 'PAGO') continue;
            pagDB.status = 'PAGO'; pagDB.pago_em = h.obterHoraBrasilia();
            let keyGerada = '';
            if (pagDB.partner_key || pagDB.user_id.startsWith('discord_')) {
                const par = require('./parceria_handlers.js');
                keyGerada = par.processarPagamentoConfirmadoParceria(pagDB.user_id.replace('discord_', ''), pagDB.quantidade, pagDB.valor, pagDB.partner_key, pagDB);
            } else {
                keyGerada = processarPagamentoConfirmado(pagDB);
            }
            if (keyGerada) pagDB.key_gerada = keyGerada;
            pags[i] = pagDB; pagDados.pagamentos = pags;
            db.salvarPagamentos(pagDados);
            pagamentosConfirmados.push({ txid, tipo: h.getString(pagDB, 'tipo'), quantidade: h.getFloat(pagDB, 'quantidade'), key_gerada: keyGerada });
            break;
        }
    }
    mw.jsonResponse(res, { sucesso: true, verificados: pendentes.length, confirmados: pagamentosConfirmados.length, pagamentos: pagamentosConfirmados }, 200);
}

async function ComprarComSaldo(req, res) {
    const sess = await pagamentoValidarSessao(req, res); if (!sess) return;
    const { userID, dados } = sess;
    if (!verificarFornecedor(userID)) return mw.jsonResponse(res, { sucesso: false, erro: 'ACESSO_NEGADO', msg: 'Apenas fornecedores podem usar creditos.' }, 403);
    const destinoUserID = (h.getString(dados, 'destino_user_id') || '').trim();
    if (destinoUserID) {
        const usuariosDados = h.carregarUsuarios();
        if (!(usuariosDados.usuarios || []).some(u => u && h.getString(u, 'user_id') === destinoUserID)) return mw.jsonResponse(res, { sucesso: false, erro: 'USUARIO_NAO_ENCONTRADO', msg: 'O usuario de destino nao foi encontrado' }, 400);
    }
    const userIDKey = destinoUserID || userID;
    const quantidade = h.getFloat(dados, 'quantidade');
    if (quantidade < 1) return mw.jsonResponse(res, { sucesso: false, erro: 'QUANTIDADE_INVALIDA', msg: 'Quantidade deve ser maior que zero' }, 400);
    const qtdInt = Math.floor(quantidade);
    const saldos = carregarSaldos();
    const us = obterSaldoUsuario(saldos, userID);
    const creditosAtuais = getFloatDefault(us, 'creditos', 0);
    if (creditosAtuais < qtdInt) return mw.jsonResponse(res, { sucesso: false, erro: 'SALDO_INSUFICIENTE', msg: `Voce tem ${creditosAtuais} creditos, precisa de ${qtdInt}` }, 400);
    us.creditos = creditosAtuais - qtdInt;
    us.total_salas_compradas = getFloatDefault(us, 'total_salas_compradas', 0) + qtdInt;
    salvarSaldos(saldos);
    const hashKey = gerarTokenHex(8).toUpperCase();
    const novaKey = 'FFSL-' + hashKey;
    let nomeKey = `Key Comprada - ${qtdInt} salas`;
    if (destinoUserID && destinoUserID !== userID) nomeKey = `Key Recebida - ${qtdInt} salas (de ${userID})`;
    const novaKeyInfo = { key: novaKey, nome: nomeKey, ativa: true, ilimitada: false, limite_usos: qtdInt, usos_totais: 0, criada_em: h.obterHoraBrasilia(), ultima_request: null, user_id: userIDKey, comprado_por: destinoUserID ? userID : null };
    const keysData = h.carregarKeysDB();
    const keys = keysData.keys || [];
    keys.push(novaKeyInfo); keysData.keys = keys;
    h.salvarKeysDB(keysData);
    const saldosAtualizado = carregarSaldos();
    const usAtualizado = obterSaldoUsuario(saldosAtualizado, userID);
    mw.jsonResponse(res, { sucesso: true, key: novaKey, quantidade: qtdInt, creditos_restantes: getFloatDefault(usAtualizado, 'creditos', 0), destino: userIDKey }, 200);
}

async function PagamentoMinhasKeys(req, res) {
    const sess = await pagamentoValidarSessao(req, res); if (!sess) return;
    const dados = h.carregarKeysDB();
    const minhasKeys = [];
    for (const k of (dados.keys || [])) {
        if (!k || h.getString(k, 'user_id') !== sess.userID) continue;
        minhasKeys.push({ key: h.getString(k, 'key'), nome: h.getString(k, 'nome'), ativa: k.ativa !== false, limite_usos: h.getFloat(k, 'limite_usos'), usos_totais: h.getFloat(k, 'usos_totais'), criada_em: h.getString(k, 'criada_em'), ultima_request: h.getString(k, 'ultima_request') });
    }
    mw.jsonResponse(res, { sucesso: true, keys: minhasKeys, total: minhasKeys.length, tem_keys: minhasKeys.length > 0 }, 200);
}

async function PagamentoMeusPagamentos(req, res) {
    const sess = await pagamentoValidarSessao(req, res); if (!sess) return;
    if (!verificarFornecedor(sess.userID)) return mw.jsonResponse(res, { sucesso: false, erro: 'ACESSO_NEGADO', msg: 'Apenas fornecedores podem ver pagamentos.' }, 403);
    const pagDados = db.carregarPagamentos();
    if (!pagDados) return mw.jsonResponse(res, { sucesso: true, pagamentos: [], total: 0 }, 200);
    const configPag = db.carregarPagamentosConfig();
    const tempoExpiracao = (configPag && h.getFloat(configPag, 'expiracao_pix') > 0) ? h.getFloat(configPag, 'expiracao_pix') : 3600;
    const agora = Date.now();
    const meus = [];
    for (const p of (pagDados.pagamentos || [])) {
        if (!p || h.getString(p, 'user_id') !== sess.userID) continue;
        let statusAtual = h.getString(p, 'status');
        let tempoRestante = 0, expirado = false;
        if (statusAtual === 'PENDENTE') {
            const criadoEm = h.getString(p, 'criado_em');
            if (criadoEm) { const t = new Date(criadoEm).getTime(); const passado = (agora - t) / 1000; tempoRestante = tempoExpiracao - passado; if (tempoRestante <= 0) { tempoRestante = 0; expirado = true; statusAtual = 'EXPIRADO'; } }
        }
        const pagInfo = { id: h.getString(p, 'id'), txid: h.getString(p, 'txid'), tipo: h.getString(p, 'tipo'), quantidade: h.getFloat(p, 'quantidade'), valor: h.getFloat(p, 'valor'), status: statusAtual, criado_em: h.getString(p, 'criado_em'), pago_em: h.getString(p, 'pago_em'), key_gerada: p.key_gerada, expirado, tempo_restante: Math.floor(tempoRestante) };
        if (h.getString(p, 'status') === 'PENDENTE' && !expirado) { pagInfo.qrcode_imagem = h.getString(p, 'qrcode_imagem'); pagInfo.qrcode_texto = h.getString(p, 'qrcode_texto'); pagInfo.link_pagamento = h.getString(p, 'link_pagamento'); }
        meus.push(pagInfo);
    }
    mw.jsonResponse(res, { sucesso: true, pagamentos: meus, total: meus.length }, 200);
}

async function PagamentoVerificarTipoUsuario(req, res) {
    const sess = await pagamentoValidarSessao(req, res); if (!sess) return;
    const { userID } = sess;
    let isFornecedorPuro = false;
    const fornecedores = db.carregarFornecedores();
    if (fornecedores) { for (const f of (fornecedores.fornecedores || [])) { if ((typeof f === 'string' && f === userID) || (typeof f === 'object' && f && h.getString(f, 'user_id') === userID)) { isFornecedorPuro = true; break; } } }
    let isVip = false, vipExpiraEm = null, vipTipo = null;
    const vips = db.carregarTelegramVips();
    if (vips && typeof vips.vips === 'object' && !Array.isArray(vips.vips) && vips.vips) {
        const info = vips.vips[userID];
        if (info && typeof info === 'object') {
            vipTipo = h.getString(info, 'tipo');
            if (vipTipo === 'permanente') isVip = true;
            else { const exp = h.getString(info, 'expira_em'); if (exp) { try { if (new Date(exp) > new Date()) { isVip = true; vipExpiraEm = exp; } } catch {} } }
        }
    }
    const isFornecedor = isFornecedorPuro || isVip;
    let tipo = 'normal';
    if (isVip && isFornecedorPuro) tipo = 'vip_plus';
    else if (isVip) tipo = 'vip';
    else if (isFornecedorPuro) tipo = 'fornecedor';
    const configPag = db.carregarPagamentosConfig() || { valor_por_sala: 0.10, valor_por_credito: 0.10 };
    const precos = { valor_por_sala: getFloatDefault(configPag, 'valor_por_sala', 0.10), valor_por_credito: getFloatDefault(configPag, 'valor_por_credito', 0.10) };
    precos.minimo_salas = isFornecedor ? 1 : getFloatDefault(configPag, 'minimo_salas', 20);
    precos.minimo_creditos = isFornecedor ? 1 : getFloatDefault(configPag, 'minimo_creditos', 1);
    mw.jsonResponse(res, { sucesso: true, is_fornecedor: isFornecedor, is_vip: isVip, is_fornecedor_puro: isFornecedorPuro, tipo, vip_expira_em: vipExpiraEm, vip_tipo: vipTipo, precos }, 200);
}

async function PagamentoBuscarUsuarioDestino(req, res) {
    const sess = await pagamentoValidarSessao(req, res); if (!sess) return;
    if (!verificarFornecedor(sess.userID)) return mw.jsonResponse(res, { sucesso: false, erro: 'NAO_AUTORIZADO', msg: 'Apenas fornecedores podem usar esta funcao' }, 403);
    const targetID = h.getString(sess.dados, 'user_id');
    if (!targetID) return mw.jsonResponse(res, { sucesso: false, erro: 'USER_ID_OBRIGATORIO', msg: 'User ID obrigatorio' }, 400);
    const usuariosDados = h.carregarUsuarios();
    for (const u of (usuariosDados.usuarios || [])) {
        if (u && h.getString(u, 'user_id') === targetID) return mw.jsonResponse(res, { sucesso: true, encontrado: true, usuario: { user_id: targetID, username: h.getString(u, 'username'), avatar: h.getString(u, 'avatar') } }, 200);
    }
    mw.jsonResponse(res, { sucesso: true, encontrado: false, msg: 'Usuario nao encontrado no sistema' }, 200);
}

async function PagamentoAvisos(req, res) {
    const sess = await pagamentoValidarSessao(req, res); if (!sess) return;
    const avisos = db.carregarAvisosMap() || { avisos: [] };
    mw.jsonResponse(res, { sucesso: true, avisos: avisos.avisos || [] }, 200);
}

// ─── EFI Webhook ───
async function CallbackEfiWebhook(req, res) {
    if (req.method === 'POST') {
        const corpo = await mw.parseBody(req);
        const pixArray = corpo.pix;
        if (!Array.isArray(pixArray) || pixArray.length === 0) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"ok"}'); return; }
        for (const pixItem of pixArray) {
            const txid = h.getString(pixItem, 'txid');
            if (!txid) continue;
            console.log(`  \x1b[94m[EFI WEBHOOK]\x1b[0m Notificacao PIX recebida: txid=${txid}`);
            setImmediate(() => processarWebhookEfiPagamento(txid, req));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"ok"}'); return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"ok"}');
}

async function processarWebhookEfiPagamento(txid, req) {
    let pagamentosDB = db.carregarPagamentos();
    if (!pagamentosDB) return false;
    const pagamentos = pagamentosDB.pagamentos || [];
    let encontrado = false;
    for (const p of pagamentos) {
        if (!p || h.getString(p, 'txid') !== txid) continue;
        if (h.getString(p, 'status') === 'PAGO') return true;
        if (h.getString(p, 'status') === 'PENDENTE' || h.getString(p, 'status') === 'CANCELADA') encontrado = true;
        break;
    }
    if (!encontrado) return false;
    const resultado = await efiPix.verificarPagamentoEfi(txid);
    if (resultado.erro || h.getString(resultado, 'status') !== 'CONCLUIDA') return false;
    pagamentosDB = db.carregarPagamentos();
    if (!pagamentosDB) return false;
    const pags = pagamentosDB.pagamentos || [];
    for (let i = 0; i < pags.length; i++) {
        const pag = pags[i];
        if (!pag || h.getString(pag, 'txid') !== txid || h.getString(pag, 'status') === 'PAGO') continue;
        pag.status = 'PAGO'; pag.pago_em = h.obterHoraBrasilia();
        let keyGerada = '';
        if (pag.partner_key || pag.user_id.startsWith('discord_')) {
            const par = require('./parceria_handlers.js');
            keyGerada = par.processarPagamentoConfirmadoParceria(pag.user_id.replace('discord_', ''), pag.quantidade, pag.valor, pag.partner_key, pag);
        } else {
            keyGerada = processarPagamentoConfirmado(pag);
        }
        if (keyGerada) pag.key_gerada = keyGerada;
        pags[i] = pag; pagamentosDB.pagamentos = pags;
        db.salvarPagamentos(pagamentosDB);
        console.log(`  \x1b[92m\x1b[1mPAGO\x1b[0m \x1b[97m${h.getString(pag, 'user_id')}\x1b[0m \x1b[90mconfirmou pagamento via webhook\x1b[0m`);
        setImmediate(() => {
            const [pAvatar, pUsername] = obterAvatarUsuario(h.getString(pag, 'user_id'));
            const pNome = h.getString(pag, 'nome') || pUsername;
            const pCPF = h.getString(pag, 'cpf') || '***';
            const pIP = '';
            if (h.getString(pag, 'tipo') === 'salas') enviarWebhookCompraSala(pNome, pCPF, pIP, h.getFloat(pag, 'quantidade'), h.getFloat(pag, 'valor'), txid, h.getString(pag, 'user_id'), pAvatar, keyGerada);
            else enviarWebhookCredito(pNome, pCPF, pIP, h.getFloat(pag, 'quantidade'), h.getFloat(pag, 'valor'), txid, h.getString(pag, 'user_id'), pAvatar);
        });
        return true;
    }
    return false;
}

// ─── Admin Handlers ───
async function AdminPagamentoConfig(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { sucesso: false, erro: 'Acesso negado' }, 403);
    const corpo = await mw.parseBody(req);
    if (h.getString(corpo, 'acao') === 'salvar') {
        const configAtual = db.carregarPagamentosConfig() || {};
        for (const [k, v] of Object.entries(corpo)) { if (k !== 'acao' && k !== '_csrf') configAtual[k] = v; }
        db.salvarPagamentosConfig(configAtual);
        return mw.jsonResponse(res, { sucesso: true }, 200);
    }
    mw.jsonResponse(res, { sucesso: true, config: db.carregarPagamentosConfig() || {} }, 200);
}

async function AdminPagamentoTodos(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { sucesso: false, erro: 'Acesso negado' }, 403);
    const dados = db.carregarPagamentos() || { pagamentos: [] };
    mw.jsonResponse(res, { sucesso: true, pagamentos: dados.pagamentos || [] }, 200);
}

async function AdminUsuarios(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { sucesso: false, erro: 'Acesso negado' }, 403);
    const sessoesData = db.carregarSessoes() || { sessoes: [] };
    const keysData = db.carregarKeysInfo() || { keys: [] };
    const pagamentosData = db.carregarPagamentos() || { pagamentos: [] };
    const saldosData = db.carregarSaldos() || { usuarios: {} };
    let sessoesList = [];
    if (Array.isArray(sessoesData.sessoes)) sessoesList = sessoesData.sessoes;
    else if (typeof sessoesData.sessoes === 'object' && sessoesData.sessoes) sessoesList = Object.values(sessoesData.sessoes);
    const keysList = keysData.keys || [];
    const pagsList = pagamentosData.pagamentos || [];
    const saldosUsuarios = saldosData.usuarios || {};
    const usuarios = [];
    let totalCompras = 0, receitaTotal = 0, usuariosComKeys = 0;
    for (const s of sessoesList) {
        if (!s) continue;
        const userID = h.getString(s, 'user_id'); if (!userID) continue;
        let userKeys = 0;
        for (const k of keysList) { if (k && String(k.user_id) === userID) userKeys++; }
        let userCompras = 0, userGasto = 0;
        for (const p of pagsList) { if (p && String(p.user_id) === userID && h.getString(p, 'status') === 'PAGO') { userCompras++; userGasto += h.getFloat(p, 'valor'); } }
        totalCompras += userCompras; receitaTotal += userGasto;
        if (userKeys > 0) usuariosComKeys++;
        let userCreditos = 0, userTotalGasto = 0;
        const saldoInfo = saldosUsuarios[userID];
        if (saldoInfo && typeof saldoInfo === 'object') { userCreditos = h.getFloat(saldoInfo, 'creditos'); userTotalGasto = h.getFloat(saldoInfo, 'total_gasto'); }
        let nome = h.getString(s, 'nome') || h.getString(s, 'username') || 'N/A';
        let ultimoAcesso = h.getString(s, 'ultimo_acesso') || h.getString(s, 'criado_em') || 'N/A';
        usuarios.push({ user_id: userID, nome, username: h.getString(s, 'username'), avatar: h.getString(s, 'avatar'), total_keys: userKeys, total_compras: userCompras, saldo: userCreditos, total_gasto: userTotalGasto, ultimo_acesso: ultimoAcesso });
    }
    mw.jsonResponse(res, { sucesso: true, usuarios, total: usuarios.length, com_keys: usuariosComKeys, total_compras: totalCompras, receita_total: receitaTotal }, 200);
}

async function AdminAddSaldo(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { sucesso: false, erro: 'Acesso negado' }, 403);
    const corpo = await mw.parseBody(req);
    const userID = h.getString(corpo, 'user_id');
    let quantidade = h.getFloat(corpo, 'quantidade'); if (quantidade === 0) quantidade = h.getFloat(corpo, 'valor');
    if (!userID) return mw.jsonResponse(res, { sucesso: false, erro: 'user_id obrigatorio' }, 400);
    if (quantidade < 1) return mw.jsonResponse(res, { sucesso: false, erro: 'Quantidade invalida' }, 400);
    const saldos = carregarSaldos();
    const us = obterSaldoUsuario(saldos, userID);
    const novoSaldo = getFloatDefault(us, 'creditos', 0) + quantidade;
    us.creditos = novoSaldo;
    salvarSaldos(saldos);
    mw.jsonResponse(res, { sucesso: true, msg: 'Saldo adicionado com sucesso', user_id: userID, quantidade_adicionada: Math.floor(quantidade), novo_saldo: novoSaldo, creditos: novoSaldo }, 200);
}

async function AdminRemoverSaldo(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { sucesso: false, erro: 'Acesso negado' }, 403);
    const corpo = await mw.parseBody(req);
    const userID = h.getString(corpo, 'user_id');
    const valor = h.getFloat(corpo, 'valor');
    if (!userID) return mw.jsonResponse(res, { sucesso: false, erro: 'user_id obrigatorio' }, 400);
    const saldos = carregarSaldos();
    const us = obterSaldoUsuario(saldos, userID);
    let novoSaldo = getFloatDefault(us, 'creditos', 0) - valor;
    if (novoSaldo < 0) novoSaldo = 0;
    us.creditos = novoSaldo;
    salvarSaldos(saldos);
    mw.jsonResponse(res, { sucesso: true, creditos: novoSaldo }, 200);
}

async function AdminAdicionarFornecedor(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { sucesso: false, erro: 'Acesso negado' }, 403);
    const corpo = await mw.parseBody(req);
    const userID = h.getString(corpo, 'user_id');
    if (!userID) return mw.jsonResponse(res, { sucesso: false, erro: 'USER_ID_OBRIGATORIO' }, 400);
    const fornecedores = db.carregarFornecedores() || { fornecedores: [], fornecedores_info: {} };
    if (!fornecedores.fornecedores) fornecedores.fornecedores = [];
    if (!fornecedores.fornecedores_info) fornecedores.fornecedores_info = {};
    for (const f of fornecedores.fornecedores) {
        if ((typeof f === 'string' && f === userID) || (typeof f === 'object' && f && h.getString(f, 'user_id') === userID))
            return mw.jsonResponse(res, { sucesso: false, erro: 'JA_E_FORNECEDOR', msg: 'Este usuario ja e um fornecedor' }, 400);
    }
    fornecedores.fornecedores.push(userID);
    if (!fornecedores.fornecedores_info) fornecedores.fornecedores_info = {};
    fornecedores.fornecedores_info[userID] = { adicionado_em: h.obterHoraBrasilia() };
    db.salvarFornecedores(fornecedores);
    console.log(`  \x1b[92m[ADMIN]\x1b[0m Adicionou ${userID} como fornecedor`);
    mw.jsonResponse(res, { sucesso: true, msg: 'Fornecedor adicionado com sucesso' }, 200);
}

async function AdminRemoverFornecedor(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { sucesso: false, erro: 'Acesso negado' }, 403);
    const corpo = await mw.parseBody(req);
    const userID = h.getString(corpo, 'user_id');
    if (!userID) return mw.jsonResponse(res, { sucesso: false, erro: 'USER_ID_OBRIGATORIO' }, 400);
    const fornecedores = db.carregarFornecedores();
    if (!fornecedores) return mw.jsonResponse(res, { sucesso: false, erro: 'NAO_E_FORNECEDOR', msg: 'Este usuario nao e um fornecedor' }, 400);
    const lista = fornecedores.fornecedores || [];
    let removido = false;
    const novaLista = lista.filter(f => {
        if (typeof f === 'string' && f === userID) { removido = true; return false; }
        if (typeof f === 'object' && f && h.getString(f, 'user_id') === userID) { removido = true; return false; }
        return true;
    });
    if (!removido) return mw.jsonResponse(res, { sucesso: false, erro: 'NAO_E_FORNECEDOR', msg: 'Este usuario nao e um fornecedor' }, 400);
    fornecedores.fornecedores = novaLista;
    db.salvarFornecedores(fornecedores);
    console.log(`  \x1b[92m[ADMIN]\x1b[0m Removeu ${userID} dos fornecedores`);
    mw.jsonResponse(res, { sucesso: true, msg: 'Fornecedor removido com sucesso' }, 200);
}

async function AdminListarFornecedores(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { sucesso: false, erro: 'Acesso negado' }, 403);
    const fornecedores = db.carregarFornecedores() || { fornecedores: [] };
    const usuariosDados = h.carregarUsuarios();
    const usuariosMap = {};
    for (const u of (usuariosDados.usuarios || [])) { if (u) usuariosMap[h.getString(u, 'user_id')] = u; }
    const fornecedoresInfo = fornecedores.fornecedores_info || {};
    const normalizados = [];
    for (const f of (fornecedores.fornecedores || [])) {
        let userID = typeof f === 'string' ? f : h.getString(f, 'user_id');
        if (!userID) continue;
        const userInfo = usuariosMap[userID];
        let username = 'N/A', avatar = '';
        if (userInfo) { username = h.getString(userInfo, 'username') || 'N/A'; avatar = h.getString(userInfo, 'avatar'); }
        let adicionadoEm = 'N/A';
        const infoRaw = fornecedoresInfo[userID];
        if (infoRaw && typeof infoRaw === 'object') { const ae = h.getString(infoRaw, 'adicionado_em'); if (ae) adicionadoEm = ae; }
        normalizados.push({ user_id: userID, username, avatar, adicionado_em: adicionadoEm });
    }
    const cfg = fornecedores.config || {};
    mw.jsonResponse(res, { sucesso: true, fornecedores: normalizados, total: normalizados.length, preco_sala: getFloatDefault(cfg, 'preco_por_sala', 0.10), preco_credito: getFloatDefault(cfg, 'preco_por_credito', 0.10) }, 200);
}

async function AdminSalvarPrecosFornecedor(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { sucesso: false, erro: 'Acesso negado' }, 403);
    const corpo = await mw.parseBody(req);
    let precoSala = typeof corpo.preco_sala === 'number' ? corpo.preco_sala : 0.10;
    let precoCredito = typeof corpo.preco_credito === 'number' ? corpo.preco_credito : 0.10;
    if (precoSala < 0.01 || precoCredito < 0.01) return mw.jsonResponse(res, { sucesso: false, erro: 'PRECO_MINIMO', msg: 'Preco minimo e R$ 0,01' }, 400);
    const fornecedores = db.carregarFornecedores() || {};
    const cfg = fornecedores.config || {};
    cfg.preco_por_sala = precoSala; cfg.preco_por_credito = precoCredito;
    fornecedores.config = cfg;
    db.salvarFornecedores(fornecedores);
    console.log(`  \x1b[92m[ADMIN]\x1b[0m Precos fornecedor atualizados: sala=${precoSala.toFixed(2)}, credito=${precoCredito.toFixed(2)}`);
    mw.jsonResponse(res, { sucesso: true, msg: 'Precos atualizados com sucesso' }, 200);
}

async function AdminAddKey(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { sucesso: false, erro: 'Acesso negado' }, 403);
    const corpo = await mw.parseBody(req);
    const userID = h.getString(corpo, 'user_id');
    const nome = h.getString(corpo, 'nome') || 'Key Admin';
    let limiteUsos = h.getFloat(corpo, 'limite_usos'); if (limiteUsos === 0) limiteUsos = h.getFloat(corpo, 'quantidade');
    if (limiteUsos < 1) limiteUsos = 10;
    if (!userID) return mw.jsonResponse(res, { sucesso: false, erro: 'user_id obrigatorio' }, 400);
    const novaKey = cryptoUtils.gerarHashKey();
    const novaEntrada = { key: novaKey, nome, ativa: true, ilimitada: false, limite_usos: limiteUsos, usos_totais: 0, criada_em: h.obterHoraBrasilia(), ultima_request: null, user_id: userID };
    const dados = h.carregarKeysDB();
    const keys = dados.keys || [];
    keys.push(novaEntrada); dados.keys = keys;
    h.salvarKeysDB(dados);
    const saldos = carregarSaldos();
    const us = obterSaldoUsuario(saldos, userID);
    us.total_salas_compradas = getFloatDefault(us, 'total_salas_compradas', 0) + limiteUsos;
    salvarSaldos(saldos);
    mw.jsonResponse(res, { sucesso: true, msg: 'Key criada com sucesso', key: novaKey, user_id: userID, nome, limite_usos: Math.floor(limiteUsos) }, 200);
}

async function AdminBuscarUsuarios(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { sucesso: false, erro: 'Acesso negado' }, 403);
    const corpo = await mw.parseBody(req);
    let busca = (h.getString(corpo, 'termo') || h.getString(corpo, 'busca') || '').toLowerCase();
    const dados = h.carregarUsuarios();
    let resultados = [];
    for (const u of (dados.usuarios || [])) {
        if (!u) continue;
        if (!busca || (h.getString(u, 'username') || '').toLowerCase().includes(busca) || (h.getString(u, 'user_id') || '').includes(busca)) {
            const did = h.getString(u, 'user_id');
            u.is_fornecedor = verificarFornecedor(did);
            resultados.push(u);
        }
    }
    if (resultados.length > 20) resultados = resultados.slice(0, 20);
    mw.jsonResponse(res, { sucesso: true, usuarios: resultados, total: resultados.length }, 200);
}

// ─── Telegram VIP / Admin Handlers ───
function calcularExpiracao(tipoDuracao) {
    const agora = new Date();
    switch (tipoDuracao) {
        case 'permanente': return null;
        case 'semanal': return new Date(agora.getTime() + 7 * 24 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
        case 'mensal': return new Date(agora.getTime() + 30 * 24 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
        case 'diario': return new Date(agora.getTime() + 24 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
        default: return null;
    }
}

async function AdminTelegramAdicionarVip(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { sucesso: false, erro: 'Acesso negado' }, 403);
    const corpo = await mw.parseBody(req);
    let userID = h.getString(corpo, 'user_id') || h.getString(corpo, 'telegram_id');
    if (!userID) return mw.jsonResponse(res, { sucesso: false, erro: 'User ID e obrigatorio' }, 400);
    let tipoDuracao = h.getString(corpo, 'tipo_duracao') || 'permanente';
    if (!['permanente', 'semanal', 'mensal', 'diario'].includes(tipoDuracao)) return mw.jsonResponse(res, { sucesso: false, erro: 'Tipo de duracao invalido' }, 400);
    const vipsData = db.carregarTelegramVips() || { vips: {}, config: {} };
    const vipsMap = (typeof vipsData.vips === 'object' && !Array.isArray(vipsData.vips)) ? vipsData.vips : {};
    vipsMap[userID] = { user_id: userID, tipo: tipoDuracao, expira_em: calcularExpiracao(tipoDuracao), adicionado_em: h.obterHoraBrasilia() };
    vipsData.vips = vipsMap;
    db.salvarTelegramVips(vipsData);
    console.log(`  \x1b[92m[ADMIN]\x1b[0m Adicionou VIP: ${userID} (tipo: ${tipoDuracao})`);
    mw.jsonResponse(res, { sucesso: true, msg: 'VIP adicionado com sucesso' }, 200);
}

async function AdminTelegramRemoverVip(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { sucesso: false, erro: 'Acesso negado' }, 403);
    const corpo = await mw.parseBody(req);
    const userID = h.getString(corpo, 'user_id') || h.getString(corpo, 'telegram_id');
    if (!userID) return mw.jsonResponse(res, { sucesso: false, erro: 'USER_ID_OBRIGATORIO' }, 400);
    const vipsData = db.carregarTelegramVips();
    if (!vipsData) return mw.jsonResponse(res, { sucesso: true, msg: 'VIP removido com sucesso' }, 200);
    if (typeof vipsData.vips === 'object' && !Array.isArray(vipsData.vips) && vipsData.vips) {
        if (vipsData.vips[userID]) delete vipsData.vips[userID];
        else { for (const [key, dados] of Object.entries(vipsData.vips)) { if (typeof dados === 'object' && dados && h.getString(dados, 'user_id') === userID) { delete vipsData.vips[key]; break; } } }
    } else if (Array.isArray(vipsData.vips)) {
        vipsData.vips = vipsData.vips.filter(item => { if (typeof item === 'object' && item) return h.getString(item, 'user_id') !== userID && h.getString(item, 'telegram_id') !== userID; return true; });
    }
    db.salvarTelegramVips(vipsData);
    console.log(`  \x1b[92m[ADMIN]\x1b[0m Removeu VIP: ${userID}`);
    mw.jsonResponse(res, { sucesso: true, msg: 'VIP removido com sucesso' }, 200);
}

async function AdminTelegramAdicionarAdmin(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { sucesso: false, erro: 'Acesso negado' }, 403);
    const corpo = await mw.parseBody(req);
    const telegramID = h.getString(corpo, 'telegram_id');
    if (!telegramID) return mw.jsonResponse(res, { sucesso: false, erro: 'telegram_id obrigatorio' }, 400);
    const teleConfig = db.carregarUserConfig() || { admins: [], dono: '' };
    const admins = teleConfig.admins || [];
    admins.push(telegramID); teleConfig.admins = admins;
    db.salvarUserConfig(teleConfig);
    mw.jsonResponse(res, { sucesso: true }, 200);
}

async function AdminTelegramRemoverAdmin(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { sucesso: false, erro: 'Acesso negado' }, 403);
    const corpo = await mw.parseBody(req);
    const telegramID = h.getString(corpo, 'telegram_id');
    const teleConfig = db.carregarUserConfig();
    if (!teleConfig) return mw.jsonResponse(res, { sucesso: true }, 200);
    teleConfig.admins = (teleConfig.admins || []).filter(a => a !== telegramID);
    db.salvarUserConfig(teleConfig);
    mw.jsonResponse(res, { sucesso: true }, 200);
}

async function AdminTelegramDefinirDono(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { sucesso: false, erro: 'Acesso negado' }, 403);
    const corpo = await mw.parseBody(req);
    const teleConfig = db.carregarUserConfig() || { admins: [], dono: '' };
    teleConfig.dono = h.getString(corpo, 'telegram_id');
    db.salvarUserConfig(teleConfig);
    mw.jsonResponse(res, { sucesso: true }, 200);
}

async function AdminTelegramListarPermissoes(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { sucesso: false, erro: 'Acesso negado' }, 403);
    const vipsData = db.carregarTelegramVips() || { vips: {}, config: {} };
    const sessoesData = h.carregarSessoes();
    const usuariosMap = {};
    for (const s of (sessoesData.sessoes || [])) { if (s) usuariosMap[h.getString(s, 'user_id')] = s; }
    const now = new Date();
    const vipsList = [];
    if (typeof vipsData.vips === 'object' && !Array.isArray(vipsData.vips) && vipsData.vips) {
        for (const [key, dados] of Object.entries(vipsData.vips)) {
            const dadosMap = (typeof dados === 'object' && dados) ? dados : {};
            const userID = h.getString(dadosMap, 'user_id') || key;
            const userInfo = usuariosMap[userID];
            let username = 'N/A', avatarURL = '/static/img/avatar-default.png';
            if (userInfo) { username = h.getString(userInfo, 'username') || 'N/A'; }
            let expirado = false;
            const expiraEm = h.getString(dadosMap, 'expira_em');
            if (expiraEm) { try { expirado = now > new Date(expiraEm); } catch {} }
            vipsList.push({ user_id: userID, username, avatar: avatarURL, tipo: h.getString(dadosMap, 'tipo') || 'permanente', expira_em: dadosMap.expira_em, adicionado_em: getStringDefault(dadosMap, 'adicionado_em', 'N/A'), expirado });
        }
    } else if (Array.isArray(vipsData.vips)) {
        for (const item of vipsData.vips) {
            if (typeof item === 'string') { vipsList.push({ user_id: item, username: 'N/A', tipo: 'permanente', avatar: '/static/img/avatar-default.png', expirado: false }); continue; }
            if (typeof item === 'object' && item) {
                const userID = h.getString(item, 'user_id');
                const userInfo = usuariosMap[userID];
                let username = 'N/A'; if (userInfo) username = h.getString(userInfo, 'username') || 'N/A';
                let expirado = false;
                const expiraEm = h.getString(item, 'expira_em');
                if (expiraEm) { try { expirado = now > new Date(expiraEm); } catch {} }
                vipsList.push({ user_id: userID, username, avatar: '/static/img/avatar-default.png', tipo: h.getString(item, 'tipo') || 'permanente', expira_em: item.expira_em, adicionado_em: getStringDefault(item, 'adicionado_em', 'N/A'), expirado });
            }
        }
    }
    mw.jsonResponse(res, { sucesso: true, vips: vipsList, config: vipsData.config || {} }, 200);
}

async function AdminTelegramSalvarConfig(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { sucesso: false, erro: 'Acesso negado' }, 403);
    const corpo = await mw.parseBody(req);
    const vipsData = db.carregarTelegramVips() || { vips: {}, config: {} };
    const vipsConfig = vipsData.config || {};
    for (const [k, v] of Object.entries(corpo)) { if (k !== '_csrf') vipsConfig[k] = v; }
    vipsData.config = vipsConfig;
    db.salvarTelegramVips(vipsData);
    mw.jsonResponse(res, { sucesso: true }, 200);
}

// ─── Telegram API Handlers ───
async function TelegramVerificarPermissao(req, res) {
    const corpo = await mw.parseBody(req);
    const telegramID = h.getString(corpo, 'telegram_id');
    const teleConfig = db.carregarUserConfig() || { admins: [], dono: '' };
    const isDono = h.getString(teleConfig, 'dono') === telegramID;
    let isAdmin = false;
    for (const a of (teleConfig.admins || [])) { if (a === telegramID) { isAdmin = true; break; } }
    let isVip = false;
    const vips = db.carregarTelegramVips();
    if (vips) {
        if (typeof vips.vips === 'object' && !Array.isArray(vips.vips) && vips.vips) {
            const vipInfo = vips.vips[telegramID];
            if (vipInfo) {
                if (typeof vipInfo === 'object') {
                    const expiraEm = h.getString(vipInfo, 'expira_em');
                    if (!expiraEm || h.getString(vipInfo, 'tipo') === 'permanente') isVip = true;
                    else { try { if (new Date() < new Date(expiraEm)) isVip = true; } catch {} }
                } else isVip = true;
            }
        } else if (Array.isArray(vips.vips)) {
            for (const v of vips.vips) { if (typeof v === 'object' && v && (h.getString(v, 'telegram_id') === telegramID || h.getString(v, 'user_id') === telegramID)) { isVip = true; break; } }
        }
    }
    mw.jsonResponse(res, { sucesso: true, dono: isDono, admin: isAdmin || isDono, vip: isVip }, 200);
}

async function TelegramObterKeysUsuario(req, res) {
    const corpo = await mw.parseBody(req);
    const telegramID = h.getString(corpo, 'telegram_id');
    if (!telegramID) return mw.jsonResponse(res, { sucesso: false, erro: 'telegram_id obrigatorio' }, 400);
    const userKeys = db.carregarUserKeys() || {};
    const keysList = userKeys[telegramID] || [];
    const dadosKeys = h.carregarKeysDB();
    const allKeys = dadosKeys.keys || [];
    const keysInfo = [];
    for (const k of keysList) {
        if (typeof k !== 'string') continue;
        const found = allKeys.find(ak => ak && h.getString(ak, 'key') === k);
        if (found) keysInfo.push(found);
    }
    mw.jsonResponse(res, { sucesso: true, keys: keysInfo, total: keysInfo.length }, 200);
}

async function TelegramUsarKey(req, res) {
    const corpo = await mw.parseBody(req);
    const oauthKey = h.getString(corpo, 'oauth_key');
    if (!oauthKey) return mw.jsonResponse(res, { sucesso: false, erro: 'oauth_key obrigatorio' }, 400);
    const [keyValida, resultado] = h.validarEConsumirUsoCriarSala(oauthKey);
    if (!keyValida) return mw.jsonResponse(res, { sucesso: false, erro: typeof resultado === 'string' ? resultado : 'key_invalida' }, 200);
    h.devolverUsoKey(oauthKey);
    mw.jsonResponse(res, { sucesso: false, erro: 'sem_contas' }, 503);
}

async function TelegramObterConfig(req, res) {
    const teleConfig = db.carregarUserConfig() || {};
    mw.jsonResponse(res, { sucesso: true, config: teleConfig }, 200);
}

async function TelegramAtualizarAutoStart(req, res) {
    const corpo = await mw.parseBody(req);
    const sshash = h.getString(corpo, 'sshash');
    let autoStartMin = h.getFloat(corpo, 'auto_start_min');
    if (autoStartMin < 1 || autoStartMin > 15) autoStartMin = 5;
    if (!sshash) return mw.jsonResponse(res, { sucesso: false, erro: 'sshash obrigatorio' }, 400);
    const salas = h.carregarSalasDB();
    if (!salas[sshash]) return mw.jsonResponse(res, { sucesso: false, erro: 'sshash nao encontrado' }, 404);
    const salaInfo = typeof salas[sshash] === 'object' ? salas[sshash] : {};
    salaInfo.auto_start_min = autoStartMin;
    salaInfo.auto_start_em = h.obterHoraBrasilia();
    salas[sshash] = salaInfo;
    h.salvarSalasDB(salas);
    mw.jsonResponse(res, { sucesso: true, auto_start_min: autoStartMin }, 200);
}

// ─── Dashboard Admin Handlers ───
async function AdminDashboardAdicionarAdmin(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { sucesso: false, erro: 'Acesso negado' }, 403);
    const corpo = await mw.parseBody(req);
    const userID = h.getString(corpo, 'user_id');
    if (!userID) return mw.jsonResponse(res, { sucesso: false, erro: 'user_id obrigatorio' }, 400);
    const admins = h.carregarAdminsDashboard();
    const adminsMap = admins.admins || {};
    adminsMap[userID] = { user_id: userID, adicionado_em: h.obterHoraBrasilia(), cargo: 'admin' };
    admins.admins = adminsMap;
    db.salvarAdminsDashboard(admins);
    mw.jsonResponse(res, { sucesso: true }, 200);
}

async function AdminDashboardRemoverAdmin(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { sucesso: false, erro: 'Acesso negado' }, 403);
    const corpo = await mw.parseBody(req);
    const userID = h.getString(corpo, 'user_id');
    const infoAdmin = db.carregarInfoAdmin();
    if (infoAdmin && h.getString(infoAdmin, 'dono') === userID) return mw.jsonResponse(res, { sucesso: false, erro: 'Nao pode remover o dono' }, 200);
    const admins = h.carregarAdminsDashboard();
    const adminsMap = admins.admins || {};
    delete adminsMap[userID];
    admins.admins = adminsMap;
    db.salvarAdminsDashboard(admins);
    mw.jsonResponse(res, { sucesso: true }, 200);
}

async function AdminDashboardListarAdmins(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { sucesso: false, erro: 'Acesso negado' }, 403);
    const admins = h.carregarAdminsDashboard();
    const adminsMap = admins.admins || {};
    const donoAdminID = config.donoAdminID || '';
    if (donoAdminID && !adminsMap[donoAdminID]) {
        adminsMap[donoAdminID] = { user_id: donoAdminID, adicionado_em: h.obterHoraBrasilia(), cargo: 'dono' };
        admins.admins = adminsMap;
        db.salvarAdminsDashboard(admins);
    }
    const sessoesData = h.carregarSessoes();
    const usuariosMap = {};
    for (const s of (sessoesData.sessoes || [])) { if (s) usuariosMap[h.getString(s, 'user_id')] = s; }
    const resultado = [];
    for (const [userID, v] of Object.entries(adminsMap)) {
        const info = (typeof v === 'object' && v) ? v : {};
        const userInfo = usuariosMap[userID];
        let username = 'N/A', avatarURL = '/static/img/avatar-default.png';
        if (userInfo) { username = h.getString(userInfo, 'username') || 'N/A'; }
        resultado.push({ user_id: userID, username, avatar: avatarURL, cargo: h.getString(info, 'cargo') || 'admin', adicionado_em: getStringDefault(info, 'adicionado_em', 'N/A') });
    }
    const sorted = resultado.sort((a, b) => a.cargo === 'dono' ? -1 : b.cargo === 'dono' ? 1 : 0);
    mw.jsonResponse(res, { sucesso: true, admins: sorted, total: sorted.length }, 200);
}

// ─── Avisos ───
async function AdminAvisosListar(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { sucesso: false, erro: 'Acesso negado' }, 403);
    const avisos = db.carregarAvisosMap() || { avisos: [] };
    mw.jsonResponse(res, { sucesso: true, avisos: avisos.avisos || [] }, 200);
}

async function AdminAvisosCriar(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { sucesso: false, erro: 'Acesso negado' }, 403);
    const corpo = await mw.parseBody(req);
    let titulo = (h.getString(corpo, 'titulo') || '').trim();
    let conteudo = (h.getString(corpo, 'conteudo') || '').trim();
    let imagem = (h.getString(corpo, 'imagem') || '').trim();
    if (titulo.length < 3) return mw.jsonResponse(res, { sucesso: false, msg: 'Titulo deve ter pelo menos 3 caracteres' }, 400);
    if (conteudo.length < 3) return mw.jsonResponse(res, { sucesso: false, msg: 'Conteudo deve ter pelo menos 3 caracteres' }, 400);
    if (titulo.length > 100) titulo = titulo.slice(0, 100);
    if (conteudo.length > 2000) conteudo = conteudo.slice(0, 2000);
    if (imagem) {
        if (!imagem.startsWith('data:image/')) return mw.jsonResponse(res, { sucesso: false, msg: 'Formato de imagem invalido' }, 400);
        const partes = imagem.split(','); if (partes.length !== 2) return mw.jsonResponse(res, { sucesso: false, msg: 'Formato de imagem invalido' }, 400);
        if (partes[1].length > 5 * 1024 * 1024 * 4 / 3) return mw.jsonResponse(res, { sucesso: false, msg: 'Imagem deve ter no maximo 5MB' }, 400);
    }
    const avisos = db.carregarAvisosMap() || { avisos: [] };
    const lista = avisos.avisos || [];
    const novoAviso = { id: Date.now().toString(16), titulo, conteudo, imagem, criado_em: h.obterHoraBrasilia() };
    avisos.avisos = [novoAviso, ...lista];
    db.salvarAvisosMap(avisos);
    mw.jsonResponse(res, { sucesso: true, msg: 'Aviso criado com sucesso', aviso: novoAviso }, 200);
}

async function AdminAvisosDeletar(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { sucesso: false, erro: 'Acesso negado' }, 403);
    const corpo = await mw.parseBody(req);
    const avisoID = h.getString(corpo, 'id');
    const avisos = db.carregarAvisosMap();
    if (!avisos) return mw.jsonResponse(res, { sucesso: true }, 200);
    avisos.avisos = (avisos.avisos || []).filter(a => a && h.getString(a, 'id') !== avisoID);
    db.salvarAvisosMap(avisos);
    mw.jsonResponse(res, { sucesso: true }, 200);
}

module.exports = {
    PagamentoConfig, PagamentoSaldo, CriarPagamento, VerificarPagamento, VerificarPagamentoAuto,
    ComprarComSaldo, PagamentoMinhasKeys, PagamentoMeusPagamentos, PagamentoVerificarTipoUsuario,
    PagamentoBuscarUsuarioDestino, PagamentoBuscarUsuario: PagamentoBuscarUsuarioDestino,
    PagamentoAvisos,
    CallbackEfiWebhook, CallbackMPWebhook: CallbackEfiWebhook,
    AdminPagamentoConfig, AdminPagamentoTodos, AdminUsuarios,
    AdminAddSaldo, AdminRemoverSaldo,
    AdminAdicionarFornecedor, AdminRemoverFornecedor, AdminListarFornecedores, AdminSalvarPrecosFornecedor,
    AdminAddKey, AdminBuscarUsuarios,
    AdminTelegramAdicionarVip, AdminTelegramRemoverVip,
    AdminTelegramAdicionarAdmin, AdminTelegramRemoverAdmin, AdminTelegramDefinirDono,
    AdminTelegramListarPermissoes, AdminTelegramSalvarConfig,
    TelegramVerificarPermissao, TelegramObterKeysUsuario, TelegramUsarKey, TelegramObterConfig, TelegramAtualizarAutoStart,
    AdminDashboardAdicionarAdmin, AdminDashboardRemoverAdmin, AdminDashboardListarAdmins,
    AdminAvisosListar, AdminAvisosCriar, AdminAvisosDeletar,
    IniciarLimpezaFornecedores, iniciarLimpezaFornecedores: IniciarLimpezaFornecedores, verificarFornecedor, adicionarCreditosAoUsuario,
};
