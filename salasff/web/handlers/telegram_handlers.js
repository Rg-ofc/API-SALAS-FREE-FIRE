/**
 * telegram_handlers.js — Handlers do Telegram admin
 * Convertido de internal/http/handlers/telegram_handlers.go
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const config = require('../config');
const cryptoUtils = require('../crypto_utils');
const mw = require('../middleware/middleware');
const h = require('./helpers');
const db = require('../../db_postgres');

const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || '';
const dominioBase = '';

const transmissoesAtivas = new Map();

// ─── Telegram API helpers ───
function telegramPost(endpoint, payload) {
    return new Promise((resolve) => {
        const data = JSON.stringify(payload);
        const url = new URL(`https://api.telegram.org/bot${telegramBotToken}/${endpoint}`);
        const req = https.request({ hostname: url.hostname, path: url.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 15000 }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(res.statusCode === 200));
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.write(data);
        req.end();
    });
}

async function enviarMensagemTelegram(chatID, mensagem) {
    if (await telegramPost('sendMessage', { chat_id: chatID, text: mensagem, parse_mode: 'Markdown' })) return true;
    if (await telegramPost('sendMessage', { chat_id: chatID, text: mensagem, parse_mode: 'HTML' })) return true;
    return telegramPost('sendMessage', { chat_id: chatID, text: mensagem });
}

async function enviarFotoTelegram(chatID, fotoURL, caption) {
    const payload = { chat_id: chatID, photo: fotoURL };
    if (caption) { payload.caption = caption; payload.parse_mode = 'Markdown'; }
    if (await telegramPost('sendPhoto', payload)) return true;
    if (caption) {
        payload.parse_mode = 'HTML';
        if (await telegramPost('sendPhoto', payload)) return true;
        delete payload.parse_mode;
        return telegramPost('sendPhoto', payload);
    }
    return false;
}

async function enviarGrupoFotosTelegram(chatID, fotoURLs, caption) {
    const media = fotoURLs.map((foto, i) => {
        const item = { type: 'photo', media: foto };
        if (i === 0 && caption) { item.caption = caption; item.parse_mode = 'Markdown'; }
        return item;
    });
    if (await telegramPost('sendMediaGroup', { chat_id: chatID, media })) return true;
    if (media.length > 0 && caption) {
        media[0].parse_mode = 'HTML';
        if (await telegramPost('sendMediaGroup', { chat_id: chatID, media })) return true;
        delete media[0].parse_mode;
        return telegramPost('sendMediaGroup', { chat_id: chatID, media });
    }
    return false;
}

async function transmitirEmBackground(transmissaoID, usuarios, mensagem, fotos) {
    let sucesso = 0, erros = 0;
    const entries = Object.entries(usuarios);
    const total = entries.length;
    const tempoInicio = Date.now();
    let msgFormatada = mensagem ? '\u{1F4E2} *Aviso do ADM*\n\n' + mensagem : '';
    fotos = fotos.map(f => f.startsWith('/') ? dominioBase + f : f);
    transmissoesAtivas.set(transmissaoID, { status: 'enviando', enviados: 0, erros: 0, total });
    for (const [tid, infoRaw] of entries) {
        const info = (typeof infoRaw === 'object' && infoRaw) ? infoRaw : {};
        const userID = info.id || tid;
        let ok = false;
        if (fotos.length > 1) ok = await enviarGrupoFotosTelegram(userID, fotos, msgFormatada);
        else if (fotos.length === 1) ok = await enviarFotoTelegram(userID, fotos[0], msgFormatada);
        else if (msgFormatada) ok = await enviarMensagemTelegram(userID, msgFormatada);
        if (ok) sucesso++; else erros++;
        transmissoesAtivas.set(transmissaoID, { status: 'enviando', enviados: sucesso, erros, total });
        await new Promise(r => setTimeout(r, 50));
    }
    const duracao = (Date.now() - tempoInicio) / 1000;
    const mediaPorSegundo = duracao > 0 ? Math.round(total / duracao * 100) / 100 : 0;
    const transmissoes = db.carregarTransmissoes() || { transmissoes: [] };
    for (const tr of (transmissoes.transmissoes || [])) {
        if (tr && h.getString(tr, 'id') === transmissaoID) {
            tr.status = 'concluida'; tr.enviados = sucesso; tr.erros = erros;
            tr.finalizada_em = h.obterHoraBrasilia();
            tr.duracao_segundos = Math.round(duracao * 100) / 100;
            tr.media_por_segundo = mediaPorSegundo;
            break;
        }
    }
    db.salvarTransmissoes(transmissoes);
    transmissoesAtivas.set(transmissaoID, { status: 'concluida', enviados: sucesso, erros, total });
}

// ─── Handlers ───
function TelegramAPIVerificarSessao(req, res) {
    if (h.verificarAdminLogado(req)) {
        const sess = h.getAdminSession(req);
        return mw.jsonResponse(res, { autenticado: true, sucesso: true, csrf: sess.csrfToken, admin: { user_id: sess.adminUserID, username: sess.adminUsername, avatar: sess.adminAvatar } }, 200);
    }
    mw.jsonResponse(res, { autenticado: false, sucesso: false, erro: 'Sessao invalida' }, 401);
}

function TelegramAdminPagina(req, res) {
    const htmlFile = path.join(config.SrcWebTelegramDir(), 'html', 'telegramadmin.html');
    if (!fs.existsSync(htmlFile)) return mw.jsonResponse(res, { erro: 'Pagina nao encontrada' }, 404);
    mw.serveFile(res, req, htmlFile);
}

function TelegramAPIUsuarios(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { sucesso: false, erro: 'Acesso negado' }, 403);
    const usersBot = db.carregarTelegramUsers() || {};
    const userKeys = db.carregarUserKeys() || {};
    const userConfig = db.carregarUserConfig() || {};
    const dadosKeys = h.carregarKeysDB();
    const allKeys = dadosKeys.keys || [];
    const usuariosList = [];
    if (usersBot.usuarios && Array.isArray(usersBot.usuarios)) {
        return mw.jsonResponse(res, { sucesso: true, usuarios: usersBot.usuarios, total: usersBot.usuarios.length }, 200);
    }
    for (const [tid, infoRaw] of Object.entries(usersBot)) {
        const info = (typeof infoRaw === 'object' && infoRaw) ? infoRaw : {};
        const keys = Array.isArray(userKeys[tid]) ? userKeys[tid] : [];
        let totalSalas = 0, temIlimitado = false;
        const keysDetalhadas = [];
        for (const k of keys) {
            const ks = String(k);
            for (const ak of allKeys) {
                if (!ak || h.getString(ak, 'key') !== ks) continue;
                const ilimitada = h.getBool(ak, 'ilimitada');
                const limite = h.getFloat(ak, 'limite_usos');
                const usos = h.getFloat(ak, 'usos_totais');
                const restante = Math.max(0, limite - usos);
                keysDetalhadas.push({ nome: h.getString(ak, 'nome'), restante, limite, ilimitada });
                if (ilimitada) temIlimitado = true;
                else if (restante > 0) totalSalas += restante;
                break;
            }
        }
        if (temIlimitado) totalSalas = -1;
        const cfg = (typeof userConfig[tid] === 'object' && userConfig[tid]) ? userConfig[tid] : {};
        const autoStartMin = h.getFloat(cfg, 'auto_start') > 0 ? h.getFloat(cfg, 'auto_start') : 5;
        const senhaFixa = h.getString(cfg, 'senha_fixa');
        usuariosList.push({ id: h.getString(info, 'id'), telegram_id: tid, first_name: h.getString(info, 'first_name'), username: h.getString(info, 'username'), registrado_em: h.getString(info, 'registrado_em'), ultimo_uso: h.getString(info, 'ultimo_uso'), keys, keys_detalhadas: keysDetalhadas, total_keys: keys.length, total_salas: totalSalas, auto_start_min: autoStartMin, senha_fixa: senhaFixa, tem_senha_fixa: senhaFixa !== '' });
    }
    usuariosList.sort((a, b) => (b.ultimo_uso || '').localeCompare(a.ultimo_uso || ''));
    mw.jsonResponse(res, { sucesso: true, usuarios: usuariosList, total: usuariosList.length }, 200);
}

function TelegramAPIEstatisticas(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { sucesso: false, erro: 'Acesso negado' }, 403);
    const usersBot = db.carregarTelegramUsers() || {};
    const userKeys = db.carregarUserKeys() || {};
    const userConfig = db.carregarUserConfig() || {};
    let totalUsuarios = 0, totalComKeys = 0, totalKeysRegistradas = 0, totalComSenhaFixa = 0, usuariosAtivosHoje = 0;
    const hoje = h.obterHoraBrasilia().split(' ')[0];
    if (usersBot.usuarios && Array.isArray(usersBot.usuarios)) { totalUsuarios = usersBot.usuarios.length; }
    else {
        for (const [tid, infoRaw] of Object.entries(usersBot)) {
            totalUsuarios++;
            const keys = Array.isArray(userKeys[tid]) ? userKeys[tid] : [];
            if (keys.length > 0) { totalComKeys++; totalKeysRegistradas += keys.length; }
            const cfg = (typeof userConfig[tid] === 'object') ? userConfig[tid] : {};
            if (h.getString(cfg, 'senha_fixa')) totalComSenhaFixa++;
            const info = (typeof infoRaw === 'object') ? infoRaw : {};
            if (h.getString(info, 'ultimo_uso').startsWith(hoje)) usuariosAtivosHoje++;
        }
    }
    const transmissoes = db.carregarTransmissoes();
    const totalTransmissoes = transmissoes && Array.isArray(transmissoes.transmissoes) ? transmissoes.transmissoes.length : 0;
    mw.jsonResponse(res, { sucesso: true, total_usuarios: totalUsuarios, total_com_keys: totalComKeys, total_keys_registradas: totalKeysRegistradas, total_com_senha_fixa: totalComSenhaFixa, usuarios_ativos_hoje: usuariosAtivosHoje, total_transmissoes: totalTransmissoes }, 200);
}

async function TelegramAPITransmitir(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { sucesso: false, erro: 'Acesso negado' }, 403);
    const sess = h.getAdminSession(req);
    const corpo = await mw.parseBody(req);
    const mensagem = h.getString(corpo, 'mensagem');
    let fotos = [];
    if (Array.isArray(corpo.fotos)) fotos = corpo.fotos.filter(f => typeof f === 'string' && f.trim()).map(f => f.trim());
    else if (typeof corpo.fotos === 'string' && corpo.fotos.trim()) fotos = [corpo.fotos.trim()];
    if (!mensagem && fotos.length === 0) return mw.jsonResponse(res, { sucesso: false, erro: 'Envie pelo menos uma mensagem ou uma foto' }, 400);
    if (fotos.length > 10) return mw.jsonResponse(res, { sucesso: false, erro: 'Maximo de 10 fotos por transmissao' }, 400);
    const usersBot = db.carregarTelegramUsers() || {};
    if (Object.keys(usersBot).length === 0) return mw.jsonResponse(res, { sucesso: false, erro: 'Nenhum usuario registrado' }, 400);
    const transmissaoID = `TM-${Math.floor(Date.now() / 1000)}`;
    const qtdFotos = fotos.length;
    let descricao;
    if (qtdFotos > 0 && mensagem) descricao = `[${qtdFotos} foto${qtdFotos > 1 ? 's' : ''}] ${mensagem}`;
    else if (qtdFotos > 0) descricao = `[${qtdFotos} foto${qtdFotos > 1 ? 's' : ''}]`;
    else descricao = mensagem;
    const adminUsername = sess ? sess.adminUsername : 'Admin';
    const adminUserID = sess ? sess.adminUserID : '';
    const novaTransmissao = { id: transmissaoID, mensagem: descricao, fotos, admin_user_id: adminUserID, admin_username: adminUsername, total_usuarios: Object.keys(usersBot).length, enviados: 0, erros: 0, status: 'enviando', criada_em: h.obterHoraBrasilia(), finalizada_em: null, duracao_segundos: null, media_por_segundo: null };
    const transmissoes = db.carregarTransmissoes() || { transmissoes: [] };
    const lista = transmissoes.transmissoes || [];
    lista.unshift(novaTransmissao);
    transmissoes.transmissoes = lista;
    db.salvarTransmissoes(transmissoes);
    transmitirEmBackground(transmissaoID, usersBot, mensagem, fotos);
    mw.jsonResponse(res, { sucesso: true, transmissao_id: transmissaoID, total: Object.keys(usersBot).length, mensagem: 'Transmissao iniciada em background' }, 200);
}

function TelegramAPITransmissoes(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { sucesso: false, erro: 'Acesso negado' }, 403);
    const transmissoes = db.carregarTransmissoes() || { transmissoes: [] };
    for (const tr of (transmissoes.transmissoes || [])) {
        if (!tr) continue;
        const id = h.getString(tr, 'id');
        const ativa = transmissoesAtivas.get(id);
        if (ativa) { tr.status = ativa.status; tr.enviados = ativa.enviados; tr.erros = ativa.erros; }
    }
    mw.jsonResponse(res, { sucesso: true, transmissoes: transmissoes.transmissoes || [] }, 200);
}

function TelegramAPITransmissao(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { sucesso: false, erro: 'Acesso negado' }, 403);
    const transmissaoID = req.url.replace('/telegram/api/transmissao/', '').split('?')[0];
    if (!transmissaoID) return mw.jsonResponse(res, { sucesso: false, erro: 'ID obrigatorio' }, 400);
    const transmissoes = db.carregarTransmissoes();
    if (!transmissoes) return mw.jsonResponse(res, { sucesso: false, erro: 'Nao encontrada' }, 404);
    for (const tr of (transmissoes.transmissoes || [])) {
        if (!tr || h.getString(tr, 'id') !== transmissaoID) continue;
        const ativa = transmissoesAtivas.get(transmissaoID);
        if (ativa) { tr.status = ativa.status; tr.enviados = ativa.enviados; tr.erros = ativa.erros; }
        return mw.jsonResponse(res, { sucesso: true, transmissao: tr }, 200);
    }
    mw.jsonResponse(res, { sucesso: false, erro: 'Nao encontrada' }, 404);
}

function TelegramAPIUsuario(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { sucesso: false, erro: 'Acesso negado' }, 403);
    const telegramID = req.url.replace('/telegram/api/usuario/', '').split('?')[0];
    if (!telegramID) return mw.jsonResponse(res, { sucesso: false, erro: 'ID obrigatorio' }, 400);
    const usersBot = db.carregarTelegramUsers();
    if (!usersBot) return mw.jsonResponse(res, { sucesso: false, erro: 'Usuario nao encontrado' }, 404);
    if (usersBot.usuarios && Array.isArray(usersBot.usuarios)) {
        const user = usersBot.usuarios.find(u => u && (h.getString(u, 'telegram_id') === telegramID || h.getString(u, 'id') === telegramID));
        if (user) return mw.jsonResponse(res, { sucesso: true, usuario: user }, 200);
    } else if (usersBot[telegramID]) {
        const info = (typeof usersBot[telegramID] === 'object') ? usersBot[telegramID] : {};
        const userKeys = db.carregarUserKeys() || {};
        const userConfig = db.carregarUserConfig() || {};
        const keys = Array.isArray(userKeys[telegramID]) ? userKeys[telegramID] : [];
        const dadosKeys = h.carregarKeysDB();
        const allKeys = dadosKeys.keys || [];
        let totalSalas = 0, temIlimitado = false;
        const keysDetalhadas = [];
        for (const k of keys) {
            const ks = String(k);
            for (const ak of allKeys) {
                if (!ak || h.getString(ak, 'key') !== ks) continue;
                const ilimitada = h.getBool(ak, 'ilimitada');
                const limite = h.getFloat(ak, 'limite_usos');
                const usos = h.getFloat(ak, 'usos_totais');
                const restante = Math.max(0, limite - usos);
                keysDetalhadas.push({ nome: h.getString(ak, 'nome'), restante, limite, ilimitada });
                if (ilimitada) temIlimitado = true;
                else if (restante > 0) totalSalas += restante;
                break;
            }
        }
        if (temIlimitado) totalSalas = -1;
        const cfg = (typeof userConfig[telegramID] === 'object') ? userConfig[telegramID] : {};
        const autoStartMin = h.getFloat(cfg, 'auto_start') > 0 ? h.getFloat(cfg, 'auto_start') : 5;
        const senhaFixa = h.getString(cfg, 'senha_fixa');
        return mw.jsonResponse(res, { sucesso: true, usuario: { id: h.getString(info, 'id'), telegram_id: telegramID, first_name: h.getString(info, 'first_name'), username: h.getString(info, 'username'), registrado_em: h.getString(info, 'registrado_em'), ultimo_uso: h.getString(info, 'ultimo_uso'), keys, keys_detalhadas: keysDetalhadas, total_keys: keys.length, total_salas: totalSalas, auto_start_min: autoStartMin, senha_fixa: senhaFixa, tem_senha_fixa: senhaFixa !== '' } }, 200);
    }
    mw.jsonResponse(res, { sucesso: false, erro: 'Usuario nao encontrado' }, 404);
}

function TelegramServirCSS(req, res) {
    const filename = req.url.replace('/telegram/static/css/', '').split('?')[0];
    mw.serveStaticFile(res, req, path.join(config.SrcWebTelegramDir(), 'css'), filename);
}

function TelegramServirJS(req, res) {
    const filename = req.url.replace('/telegram/static/js/', '').split('?')[0];
    mw.serveStaticFile(res, req, path.join(config.SrcWebTelegramDir(), 'js'), filename);
}

async function TelegramAPIUploadImagem(req, res) {
    if (!h.verificarAdminLogado(req)) return mw.jsonResponse(res, { sucesso: false, erro: 'Acesso negado' }, 403);
    // Simple multipart handling - for production use busboy/multer
    const uploadsDir = config.UploadsDir();
    fs.mkdirSync(uploadsDir, { recursive: true });
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) return mw.jsonResponse(res, { sucesso: false, erro: 'Imagem obrigatoria' }, 400);
    const boundary = boundaryMatch[1];
    const parts = body.toString('binary').split('--' + boundary);
    for (const part of parts) {
        const filenameMatch = part.match(/filename="(.+?)"/);
        if (!filenameMatch) continue;
        const originalName = filenameMatch[1];
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const fileData = Buffer.from(part.slice(headerEnd + 4, part.length - 2), 'binary');
        const nomeArquivo = `${Date.now()}_${originalName}`;
        fs.writeFileSync(path.join(uploadsDir, nomeArquivo), fileData);
        return mw.jsonResponse(res, { sucesso: true, url: '/uploads/' + nomeArquivo, nome: nomeArquivo }, 200);
    }
    mw.jsonResponse(res, { sucesso: false, erro: 'Imagem obrigatoria' }, 400);
}

function APIImagem(req, res) {
    const url = new URL(req.url, 'http://localhost');
    let nomeArquivo = url.searchParams.get('nome') || url.searchParams.get('file') || '';
    if (!nomeArquivo) return mw.jsonResponse(res, { erro: 'Parametro nome obrigatorio' }, 400);
    nomeArquivo = mw.sanitizeFilename(nomeArquivo);
    if (nomeArquivo === '_invalid_') return mw.jsonResponse(res, { erro: 'Nome de arquivo invalido' }, 400);
    const caminho = path.join(config.UploadsDir(), nomeArquivo);
    if (!fs.existsSync(caminho)) return mw.jsonResponse(res, { erro: 'Imagem nao encontrada' }, 404);
    mw.serveFile(res, req, caminho);
}

async function TelegramRegistrarKey(req, res) {
    const corpo = await mw.parseBody(req);
    const telegramID = h.getString(corpo, 'telegram_id');
    const oauthKey = h.getString(corpo, 'oauth_key');
    if (!telegramID || !oauthKey) return mw.jsonResponse(res, { sucesso: false, erro: 'PARAMETROS_INVALIDOS', msg: 'telegram_id e oauth_key sao obrigatorios' }, 400);
    const [keyValida, resultado] = h.validarOAuthKey(oauthKey);
    if (!keyValida) return mw.jsonResponse(res, { sucesso: false, erro: resultado, msg: 'Key invalida' }, 401);
    const userKeys = db.carregarUserKeys() || {};
    const keysList = Array.isArray(userKeys[telegramID]) ? userKeys[telegramID] : [];
    if (keysList.some(k => String(k) === oauthKey)) return mw.jsonResponse(res, { sucesso: false, erro: 'KEY_JA_REGISTRADA' }, 200);
    keysList.push(oauthKey);
    userKeys[telegramID] = keysList;
    db.salvarUserKeys(userKeys);
    mw.jsonResponse(res, { sucesso: true, msg: 'Key registrada com sucesso' }, 200);
}

async function TelegramRemoverKey(req, res) {
    const corpo = await mw.parseBody(req);
    const telegramID = h.getString(corpo, 'telegram_id');
    const oauthKey = h.getString(corpo, 'oauth_key');
    if (!telegramID || !oauthKey) return mw.jsonResponse(res, { sucesso: false, erro: 'PARAMETROS_INVALIDOS' }, 400);
    const userKeys = db.carregarUserKeys();
    if (!userKeys) return mw.jsonResponse(res, { sucesso: false, erro: 'KEY_NAO_ENCONTRADA' }, 200);
    const keysList = Array.isArray(userKeys[telegramID]) ? userKeys[telegramID] : [];
    const novasKeys = keysList.filter(k => String(k) !== oauthKey);
    if (novasKeys.length === keysList.length) return mw.jsonResponse(res, { sucesso: false, erro: 'KEY_NAO_ENCONTRADA' }, 200);
    userKeys[telegramID] = novasKeys;
    db.salvarUserKeys(userKeys);
    mw.jsonResponse(res, { sucesso: true, msg: 'Key removida com sucesso' }, 200);
}

async function TelegramListarKeys(req, res) {
    const corpo = await mw.parseBody(req);
    let telegramID = h.getString(corpo, 'telegram_id');
    if (!telegramID) { const url = new URL(req.url, 'http://localhost'); telegramID = url.searchParams.get('telegram_id') || ''; }
    if (!telegramID) return mw.jsonResponse(res, { sucesso: false, erro: 'TELEGRAM_ID_OBRIGATORIO' }, 400);
    const userKeys = db.carregarUserKeys();
    if (!userKeys) return mw.jsonResponse(res, { sucesso: true, keys: [], total: 0 }, 200);
    const keysList = Array.isArray(userKeys[telegramID]) ? userKeys[telegramID] : [];
    const dadosKeys = h.carregarKeysDB();
    const allKeys = dadosKeys.keys || [];
    const keysInfo = [];
    for (const k of keysList) {
        const ks = String(k);
        for (const ak of allKeys) {
            if (!ak || h.getString(ak, 'key') !== ks) continue;
            keysInfo.push({ key: ks, nome: h.getString(ak, 'nome'), ativa: h.getBool(ak, 'ativa'), limite_usos: h.getFloat(ak, 'limite_usos'), usos_totais: h.getFloat(ak, 'usos_totais') });
            break;
        }
    }
    mw.jsonResponse(res, { sucesso: true, keys: keysInfo, total: keysInfo.length }, 200);
}

async function TelegramGerarKey(req, res) {
    const corpo = await mw.parseBody(req);
    const telegramID = h.getString(corpo, 'telegram_id');
    const userID = h.getString(corpo, 'user_id');
    let quantidade = parseInt(corpo.quantidade) || 5;
    if (quantidade <= 0) quantidade = 5;
    const novaKey = cryptoUtils.gerarHashKey();
    const nome = userID ? `Key Recebida - ${quantidade} salas (de ${userID})` : `Key Telegram - ${quantidade} salas`;
    const novaEntrada = { key: novaKey, nome, ativa: true, ilimitada: false, limite_usos: quantidade, usos_totais: 0, criada_em: h.obterHoraBrasilia(), ultima_request: null, user_id: userID, comprado_por: userID };
    const dados = h.carregarKeysDB();
    const keys = dados.keys || [];
    keys.push(novaEntrada);
    dados.keys = keys;
    h.salvarKeysDB(dados);
    if (telegramID) {
        const userKeys = db.carregarUserKeys() || {};
        const keysList = Array.isArray(userKeys[telegramID]) ? userKeys[telegramID] : [];
        keysList.push(novaKey);
        userKeys[telegramID] = keysList;
        db.salvarUserKeys(userKeys);
    }
    mw.jsonResponse(res, { sucesso: true, key: novaKey, nome }, 200);
}

async function TelegramVerificarVip(req, res) {
    const corpo = await mw.parseBody(req);
    let telegramID = h.getString(corpo, 'telegram_id');
    if (!telegramID) { const url = new URL(req.url, 'http://localhost'); telegramID = url.searchParams.get('telegram_id') || ''; }
    const vips = db.carregarTelegramVips();
    if (!vips) return mw.jsonResponse(res, { sucesso: true, vip: false }, 200);
    const vipsVal = vips.vips;
    if (typeof vipsVal === 'object' && !Array.isArray(vipsVal) && vipsVal) {
        const vipInfo = vipsVal[telegramID];
        if (vipInfo && typeof vipInfo === 'object') {
            const expiraEm = h.getString(vipInfo, 'expira_em');
            if (!expiraEm || h.getString(vipInfo, 'tipo') === 'permanente') return mw.jsonResponse(res, { sucesso: true, vip: true, info: vipInfo }, 200);
            try { if (new Date(expiraEm) > new Date()) return mw.jsonResponse(res, { sucesso: true, vip: true, info: vipInfo }, 200); } catch {}
        }
    } else if (Array.isArray(vipsVal)) {
        for (const vipInfo of vipsVal) {
            if (!vipInfo || typeof vipInfo !== 'object') continue;
            if (h.getString(vipInfo, 'telegram_id') === telegramID || h.getString(vipInfo, 'user_id') === telegramID) {
                return mw.jsonResponse(res, { sucesso: true, vip: true, info: vipInfo }, 200);
            }
        }
    }
    mw.jsonResponse(res, { sucesso: true, vip: false }, 200);
}

module.exports = {
    TelegramAPIVerificarSessao, TelegramAdminPagina, TelegramAPIUsuarios,
    TelegramAPIEstatisticas, TelegramAPITransmitir, TelegramAPITransmissoes,
    TelegramAPITransmissao, TelegramAPIUsuario, TelegramServirCSS, TelegramServirJS,
    TelegramAPIUploadImagem, APIImagem, TelegramRegistrarKey, TelegramRemoverKey,
    TelegramListarKeys, TelegramGerarKey, TelegramVerificarVip,
    enviarMensagemTelegram,
};
