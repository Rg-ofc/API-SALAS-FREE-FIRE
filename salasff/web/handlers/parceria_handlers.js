/**
 * parceria_handlers.js — Handlers da API de Parceria Seven SalasBot
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const db = require('../../db_postgres');
const h = require('./helpers');
const mw = require('../middleware/middleware');
const efiPix = require('./efi_pix');
const turbofyApi = require('./turbofy_api');

const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || '25566');

// Helper para fazer requisições à bridge
function bridgeRequest(path, data) {
    return new Promise((resolve) => {
        const body = JSON.stringify(data || {});
        const req = http.request({
            hostname: '127.0.0.1', port: BRIDGE_PORT, path, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout: 10000
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

// Validar Partner Key de Parceria
function validarParceria(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const partnerKey = url.searchParams.get('partnerKey');
    if (!partnerKey) {
        mw.jsonResponse(res, { erro: 'UNAUTHORIZED', error: 'UNAUTHORIZED', msg: 'Chave de parceria nao fornecida' }, 401);
        return false;
    }
    const partnerKeys = db.carregarPartnerKeys() || {};
    const keyInfo = partnerKeys[partnerKey];
    if (!keyInfo || !keyInfo.ativa) {
        mw.jsonResponse(res, { erro: 'UNAUTHORIZED', error: 'UNAUTHORIZED', msg: 'Chave de parceria invalida ou inativa' }, 401);
        return false;
    }
    return true;
}

// Processar key gerada no pagamento da Parceria
function processarPagamentoConfirmadoParceria(userId, quantity, valor, partnerKey, payment) {
    const userIDKey = 'discord_' + userId;

    // Split payment values if affiliate system is active
    let valAfiliado = 0;
    let valSistema = valor;

    if (partnerKey) {
        const partnerKeysMap = db.carregarPartnerKeys() || {};
        const keyInfo = partnerKeysMap[partnerKey];
        if (keyInfo) {
            if (keyInfo.afiliado_ativo === true) {
                const taxa = keyInfo.afiliado_taxa || 0;
                valAfiliado = valor * (taxa / 100);
                valSistema = valor - valAfiliado;

                // Accumulate on partnerKey object
                keyInfo.saldo_afiliado = (keyInfo.saldo_afiliado || 0) + valAfiliado;
                db.salvarPartnerKey(keyInfo);
            }
        }
    }

    if (payment) {
        payment.valor_afiliado = valAfiliado;
        payment.valor_sistema = valSistema;
    }

    // 1. Atualizar saldos do usuário
    const saldos = db.carregarSaldos() || {};
    const us = saldos[userIDKey] || { creditos: 0, total_gasto: 0, total_salas_compradas: 0 };
    us.total_gasto = (us.total_gasto || 0) + valor;
    us.total_salas_compradas = (us.total_salas_compradas || 0) + Math.floor(quantity);
    saldos[userIDKey] = us;
    db.salvarSaldos(saldos);

    // 2. Criar a nova key com o limite correspondente
    const keysData = h.carregarKeysDB() || { keys: [] };
    const hashKey = crypto.randomBytes(8).toString('hex').toUpperCase();
    const novaKey = 'FFSL-' + hashKey;
    const nomeKey = `Key Parceria - ${Math.floor(quantity)} salas`;

    const novaKeyInfo = {
        key: novaKey,
        nome: nomeKey,
        ativa: true,
        ilimitada: false,
        limite_usos: Math.floor(quantity),
        usos_totais: 0,
        criada_em: h.obterHoraBrasilia(),
        ultima_request: null,
        user_id: userIDKey,
        comprado_por: 'parceria',
        partner_key: partnerKey || null
    };

    const keys = keysData.keys || [];
    keys.push(novaKeyInfo);
    keysData.keys = keys;
    h.salvarKeysDB(keysData);

    console.log(`  \x1b[96m[PARCERIA]\x1b[0m Criada key ${novaKey} para ${userIDKey} (${quantity} salas)`);
    return novaKey;
}

// 1. Gerar Pagamento PIX
async function GeneratePayment(req, res) {
    if (!validarParceria(req, res)) return;

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const userId = url.searchParams.get('userId');
    const qtyStr = url.searchParams.get('quantity');

    if (!userId || !qtyStr) {
        return mw.jsonResponse(res, { erro: 'BAD_REQUEST', error: 'BAD_REQUEST', msg: 'Parametros userId e quantity sao obrigatorios' }, 400);
    }

    const quantity = parseInt(qtyStr);
    if (isNaN(quantity) || quantity <= 0) {
        return mw.jsonResponse(res, { erro: 'BAD_REQUEST', error: 'BAD_REQUEST', msg: 'Quantidade invalida' }, 400);
    }

    const partnerKey = url.searchParams.get('partnerKey');
    const partnerKeysMap = db.carregarPartnerKeys() || {};
    const keyInfo = partnerKeysMap[partnerKey] || {};

    const valorPorSala = keyInfo.valor_por_sala !== undefined ? parseFloat(keyInfo.valor_por_sala) : (db.carregarPagamentosConfig().valor_por_sala || 0.10);
    const price = quantity * valorPorSala;

    // Gerar Pix na Efí com dados de dummy válidos para o parceiro
    const resPix = await efiPix.criarCobrancaPixEfi(price, '56508142879', 'Rafael', `API Parceria: ${quantity} salas`);
    if (resPix.erro) {
        return mw.jsonResponse(res, { erro: 'FAILED', error: 'FAILED', msg: resPix.erro }, 500);
    }

    const orderId = crypto.randomBytes(12).toString('hex');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 minutos

    // Criar registro do pagamento com vinculação de chave de parceria
    const payment = {
        id: orderId,
        txid: resPix.txid,
        user_id: 'discord_' + userId,
        tipo: 'salas',
        quantidade: quantity,
        valor: price,
        cpf: '56508142879',
        nome: 'Rafael',
        status: 'PENDENTE',
        criado_em: h.obterHoraBrasilia(),
        pago_em: null,
        qrcode_imagem: resPix.qrcode_imagem,
        qrcode_texto: resPix.qrcode_texto,
        link_pagamento: resPix.link_pagamento,
        gateway: 'efi',
        expires_at: expiresAt,
        partner_key: partnerKey
    };

    db.salvarPagamento(payment);

    let pixQrCode = resPix.qrcode_imagem || '';
    if (pixQrCode && !pixQrCode.startsWith('data:') && !pixQrCode.startsWith('http')) {
        pixQrCode = 'data:image/png;base64,' + pixQrCode;
    }

    mw.jsonResponse(res, {
        orderId: orderId,
        pixCode: resPix.qrcode_texto,
        pixQrCode: pixQrCode,
        expiresAt: expiresAt,
        amount: Math.round(price * 100),
        quantity: quantity
    }, 200);
}

// 2. Verificar Status do Pagamento
async function OrderStatus(req, res) {
    if (!validarParceria(req, res)) return;

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const orderId = url.searchParams.get('orderId');

    if (!orderId) {
        return mw.jsonResponse(res, { erro: 'BAD_REQUEST', error: 'BAD_REQUEST', msg: 'Parametro orderId e obrigatorio' }, 400);
    }

    const pagDados = db.carregarPagamentos() || {};
    let pag = pagDados[orderId];
    if (!pag) return mw.jsonResponse(res, { erro: 'NOT_FOUND', error: 'NOT_FOUND' }, 404);

    if (pag.status === 'PAGO') {
        const userId = (pag.user_id || '').replace('discord_', '');
        const keysData = h.carregarKeysDB();
        const minhasKeys = (keysData.keys || []).filter(k => k && k.user_id === 'discord_' + userId && k.ativa);
        let roomsBalance = 0;
        minhasKeys.forEach(k => {
            if (k.ilimitada) { roomsBalance = 999999; }
            else { roomsBalance += Math.max(0, parseInt(k.limite_usos || 0) - parseInt(k.usos_totais || k.total_usos || 0)); }
        });
        return mw.jsonResponse(res, {
            orderId: orderId,
            status: 'completed',
            quantity: pag.quantidade,
            amount: Math.round(pag.valor * 100),
            expiresAt: pag.expires_at || new Date(new Date(pag.criado_em).getTime() + 5 * 60 * 1000).toISOString(),
            message: `${pag.quantidade} salas creditadas diretamente na conta do usuário.`,
            apiKey: pag.key_gerada || "ff_xxxxxxxxxxxx",
            roomsBalance: roomsBalance
        }, 200);
    }

    if (pag.status === 'CANCELADA') {
        return mw.jsonResponse(res, {
            orderId: orderId,
            status: 'canceled',
            quantity: pag.quantidade
        }, 200);
    }

    // Verificar na API da Efí se já foi pago
    const checkGateway = await efiPix.verificarPagamentoEfi(pag.txid);
    if (checkGateway.erro) {
        return mw.jsonResponse(res, { erro: 'FAILED', error: 'FAILED', msg: checkGateway.erro }, 500);
    }

    const statusPix = checkGateway.status;
    if (statusPix === 'CONCLUIDA') {
        // Obter nova versão dos dados para evitar condições de corrida
        const pagDadosAtualizado = db.carregarPagamentos() || {};
        pag = pagDadosAtualizado[orderId] || pag;

        pag.status = 'PAGO';
        pag.pago_em = h.obterHoraBrasilia();

        // Gerar a Key e salvar saldo
        const key = processarPagamentoConfirmadoParceria(pag.user_id.replace('discord_', ''), pag.quantidade, pag.valor, pag.partner_key, pag);
        pag.key_gerada = key;

        db.salvarPagamento(pag);

        const userId2 = (pag.user_id || '').replace('discord_', '');
        const keysData2 = h.carregarKeysDB();
        const minhasKeys2 = (keysData2.keys || []).filter(k => k && k.user_id === 'discord_' + userId2 && k.ativa);
        let roomsBalance2 = 0;
        minhasKeys2.forEach(k => {
            if (k.ilimitada) { roomsBalance2 = 999999; }
            else { roomsBalance2 += Math.max(0, parseInt(k.limite_usos || 0) - parseInt(k.usos_totais || k.total_usos || 0)); }
        });
        return mw.jsonResponse(res, {
            orderId: orderId,
            status: 'completed',
            quantity: pag.quantidade,
            amount: Math.round(pag.valor * 100),
            expiresAt: pag.expires_at || new Date(new Date(pag.criado_em).getTime() + 5 * 60 * 1000).toISOString(),
            message: `${pag.quantidade} salas creditadas diretamente na conta do usuário.`,
            apiKey: key,
            roomsBalance: roomsBalance2
        }, 200);
    } else if (statusPix === 'CANCELADA') {
        const pagDadosAtualizado = db.carregarPagamentos() || {};
        pag = pagDadosAtualizado[orderId] || pag;
        pag.status = 'CANCELADA';
        db.salvarPagamento(pag);

        return mw.jsonResponse(res, {
            orderId: orderId,
            status: 'canceled',
            quantity: pag.quantidade
        }, 200);
    }

    mw.jsonResponse(res, {
        orderId: orderId,
        status: 'pending',
        quantity: pag.quantidade,
        amount: Math.round(pag.valor * 100),
        expiresAt: pag.expires_at || new Date(new Date(pag.criado_em).getTime() + 5 * 60 * 1000).toISOString()
    }, 200);
}

// 3. Consultar Saldo do Cliente
async function Saldo(req, res) {
    if (!validarParceria(req, res)) return;

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const userId = url.searchParams.get('userId');

    if (!userId) {
        return mw.jsonResponse(res, { erro: 'BAD_REQUEST', error: 'BAD_REQUEST', msg: 'Parametro userId e obrigatorio' }, 400);
    }

    const partnerKey = url.searchParams.get('partnerKey');
    const partnerKeysMap = db.carregarPartnerKeys() || {};
    const partnerKeyInfo = partnerKeysMap[partnerKey] || {};
    const semDesconto = partnerKeyInfo.sem_desconto === true;

    if (semDesconto) {
        return mw.jsonResponse(res, {
            roomsBalance: 999999,
            roomsUsed: 0
        }, 200);
    }

    const keysData = h.carregarKeysDB();
    let minhasKeys = (keysData.keys || []).filter(k => k && k.user_id === 'discord_' + userId && k.ativa);

    if (minhasKeys.length === 0) {
        return mw.jsonResponse(res, { error: 'Usuário não encontrado', code: 'NOT_FOUND' }, 404);
    }

    const bloquearCompartilhamento = partnerKeyInfo.bloquear_compartilhamento === true;
    if (bloquearCompartilhamento) {
        minhasKeys = minhasKeys.filter(k => k.partner_key === partnerKey);
    } else {
        minhasKeys = minhasKeys.filter(k => {
            if (!k.partner_key) return true;
            const keyOwnerInfo = partnerKeysMap[k.partner_key];
            if (keyOwnerInfo && keyOwnerInfo.bloquear_compartilhamento === true) {
                return false;
            }
            return true;
        });
    }

    if (minhasKeys.length === 0) {
        return mw.jsonResponse(res, {
            roomsBalance: 0,
            roomsUsed: 0
        }, 200);
    }

    let roomsBalance = 0;
    let roomsUsed = 0;

    minhasKeys.forEach(k => {
        const limite = parseInt(k.limite_usos || 0);
        const usos = parseInt(k.usos_totais || k.total_usos || 0);
        roomsUsed += usos;
        if (k.ilimitada) {
            roomsBalance = 999999; // Representação de ilimitada
        } else {
            roomsBalance += Math.max(0, limite - usos);
        }
    });

    mw.jsonResponse(res, {
        roomsBalance: roomsBalance,
        roomsUsed: roomsUsed
    }, 200);
}

// 4. Criar Sala
async function CreateRoom(req, res) {
    if (!validarParceria(req, res)) return;

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const userId = url.searchParams.get('userId');
    const roomName = url.searchParams.get('roomName');
    const roomPassword = url.searchParams.get('roomPassword');
    const mode = url.searchParams.get('mode'); // '1' = Full Ouro / '2' = Gel infinito / '3' = Full capa / '4' = Com carregamento / '5' = Full Ump xm8 normal / '6' = Full Ump xm8 infinito / '7' = Cs classico 7 ronds

    if (!userId || !roomName || !roomPassword || !mode) {
        return mw.jsonResponse(res, { erro: 'BAD_REQUEST', error: 'BAD_REQUEST', msg: 'Faltam parametros obrigatorios' }, 400);
    }

    // Parceria: 1 = Full Ouro / 2 = Gel infinito / 3 = Full capa / 4 = Com carregamento / 5 = Full Ump xm8 normal / 6 = Full Ump xm8 infinito / 7 = Cs classico 7 ronds
    // Interno:  1 = Sem Carreg / 2 = Gel Infinito / 3 = Full Capa / 4 = Com Carreg / 5 = Full Ump xm8 normal / 6 = Full Ump xm8 infinito / 7 = Cs classico 7 ronds
    const MODO_MAP = {
        '1': { interno: 1, nome: 'Full Ouro' },
        '2': { interno: 2, nome: 'Gel Infinito' },
        '3': { interno: 3, nome: 'Full Capa' },
        '4': { interno: 4, nome: 'Com Carregamento' },
        '5': { interno: 5, nome: 'Full Ump xm8 normal' },
        '6': { interno: 6, nome: 'Full Ump xm8 infinito' },
        '7': { interno: 7, nome: 'Cs classico 7 ronds' }
    };
    const modoInfo = MODO_MAP[mode] || MODO_MAP['1'];
    const mappedMode = modoInfo.interno;
    const modeName = modoInfo.nome;

    const partnerKey = url.searchParams.get('partnerKey');
    const partnerKeysMap = db.carregarPartnerKeys() || {};
    const partnerKeyInfo = partnerKeysMap[partnerKey] || {};
    const semDesconto = partnerKeyInfo.sem_desconto === true;

    let activeKey = partnerKey || '';
    let bypassConsumo = false;

    if (semDesconto) {
        bypassConsumo = true;
        activeKey = partnerKey || 'PARCERIA_SEM_DESCONTO';
    } else {
        const keysData = h.carregarKeysDB();
        let minhasKeys = (keysData.keys || []).filter(k => k && k.user_id === 'discord_' + userId && k.ativa);

        if (minhasKeys.length === 0) {
            return mw.jsonResponse(res, { erro: 'NO_KEY', error: 'NO_KEY', msg: 'Cliente nao tem key ativa' }, 403);
        }

        const bloquearCompartilhamento = partnerKeyInfo.bloquear_compartilhamento === true;
        if (bloquearCompartilhamento) {
            minhasKeys = minhasKeys.filter(k => k.partner_key === partnerKey);
        } else {
            minhasKeys = minhasKeys.filter(k => {
                if (!k.partner_key) return true;
                const keyOwnerInfo = partnerKeysMap[k.partner_key];
                if (keyOwnerInfo && keyOwnerInfo.bloquear_compartilhamento === true) {
                    return false;
                }
                return true;
            });
        }

        if (minhasKeys.length === 0) {
            return mw.jsonResponse(res, { erro: 'NO_KEY', error: 'NO_KEY', msg: 'Cliente nao tem key ativa para esta loja' }, 403);
        }

        // Encontrar uma key com saldo
        let activeKeyInfo = minhasKeys.find(k => k.ilimitada || (parseInt(k.limite_usos || 0) - parseInt(k.usos_totais || k.total_usos || 0) > 0));
        if (!activeKeyInfo) {
            return mw.jsonResponse(res, { erro: 'NO_BALANCE', error: 'NO_BALANCE', msg: 'Saldo zerado, compre mais salas' }, 403);
        }

        activeKey = activeKeyInfo.key;
    }

    const startTime = Date.now();

    if (!bypassConsumo) {
        // Consumir o uso da key
        const [consumiu, erroConsumo] = h.validarEConsumirUsoCriarSala(activeKey);
        if (!consumiu) {
            return mw.jsonResponse(res, { erro: 'NO_BALANCE', error: 'NO_BALANCE', msg: 'Saldo zerado ou key invalida/inativa' }, 403);
        }
    }

    // Fazer a chamada para a bridge criar a sala com retries (máx 15 tentativas x 2s = 30s) para caso o bot esteja iniciando
    let resBridge = null;
    let retries = 15;
    while (retries > 0) {
        resBridge = await bridgeRequest('/bridge/criar-sala-sync', {
            oauth_key: activeKey,
            modo: mappedMode,
            senha: roomPassword,
            nome: roomName
        });

        // Se a bridge estiver offline (null) ou sem contas online (sem_contas), aguarda e tenta novamente
        const erroMsg = resBridge ? (resBridge.erro || resBridge.msg || '') : '';
        const deveTentarNovamente = !resBridge || (resBridge.sucesso === false && (erroMsg === 'sem_contas' || erroMsg.includes('sem_contas')));

        if (deveTentarNovamente) {
            retries--;
            if (retries > 0) {
                await new Promise(r => setTimeout(r, 2000)); // Aguarda 2 segundos antes de tentar novamente
                continue;
            }
        }
        break;
    }

    if (!resBridge || resBridge.sucesso === false) {
        if (!bypassConsumo) {
            h.devolverUsoKey(activeKey);
        }
        return mw.jsonResponse(res, { erro: 'FAILED', error: 'FAILED', msg: (resBridge ? (resBridge.erro || resBridge.msg) : 'Erro na comunicacao com a bridge') }, 500);
    }

    const creationMs = Date.now() - startTime;
    const creationTime = (creationMs / 1000).toFixed(2) + 's';
    const autoStartMinutes = parseFloat(resBridge.auto_start_min || 5);
    const autoStartAt = new Date(Date.now() + autoStartMinutes * 60 * 1000).toISOString();

    mw.jsonResponse(res, {
        success: true,
        sessionId: resBridge.sshash,
        roomId: parseInt(resBridge.room_id),
        roomName: roomName,
        password: roomPassword,
        maxPlayers: 8,
        mode: parseInt(mode),
        modeName: modeName,
        creationTime: creationTime,
        attempt: 1,
        autoStartMinutes: autoStartMinutes,
        autoStartAt: autoStartAt
    }, 200);
}

// 5. Iniciar Sala
async function StartRoom(req, res) {
    if (!validarParceria(req, res)) return;

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const sessionId = url.searchParams.get('sessionId');

    if (!sessionId) {
        return mw.jsonResponse(res, { erro: 'BAD_REQUEST', error: 'BAD_REQUEST', msg: 'Parametro sessionId e obrigatorio' }, 400);
    }

    // Fazer a chamada para a bridge iniciar a sala com retries (máx 15 tentativas x 2s = 30s) para caso o bot esteja iniciando/reconectando
    let resBridge = null;
    let retries = 15;
    while (retries > 0) {
        resBridge = await bridgeRequest('/bridge/iniciar-sala-sync', {
            sshash: sessionId
        });

        // Se a bridge estiver offline (null) ou se for um erro temporario (como bot reconectando), tenta novamente
        const erroMsg = resBridge ? (resBridge.erro || resBridge.msg || '') : '';
        const deveTentarNovamente = !resBridge || (resBridge.sucesso === false && erroMsg !== 'sala_nao_encontrada' && resBridge.erro !== 'sala_nao_encontrada');

        if (deveTentarNovamente) {
            retries--;
            if (retries > 0) {
                await new Promise(r => setTimeout(r, 2000)); // Aguarda 2 segundos antes de tentar novamente
                continue;
            }
        }
        break;
    }

    if (!resBridge || resBridge.sucesso === false) {
        const msg = resBridge ? (resBridge.msg || resBridge.erro || 'Erro na bridge') : 'Sem resposta da bridge';
        if (resBridge && (resBridge.erro === 'sala_nao_encontrada' || resBridge.msg === 'sala_nao_encontrada')) {
            return mw.jsonResponse(res, { erro: 'NOT_FOUND', error: 'NOT_FOUND', msg: 'Sala nao encontrada ou encerrada' }, 404);
        }
        return mw.jsonResponse(res, { erro: 'FAILED', error: 'FAILED', msg }, 500);
    }

    const cleanPlayer = (p) => {
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
    };

    let cleanTimes = null;
    if (resBridge.times && typeof resBridge.times === 'object') {
        cleanTimes = {
            time_1: Array.isArray(resBridge.times.time_1) ? resBridge.times.time_1.map(cleanPlayer) : [],
            time_2: Array.isArray(resBridge.times.time_2) ? resBridge.times.time_2.map(cleanPlayer) : []
        };
    }

    let cleanPlayers = null;
    if (Array.isArray(resBridge.players)) {
        cleanPlayers = resBridge.players.map(cleanPlayer);
    }

    mw.jsonResponse(res, {
        success: true,
        message: 'Sala iniciada! Cooldown 3 min.',
        room_id: resBridge.room_id ? parseInt(resBridge.room_id) : undefined,
        imagem_base64: resBridge.imagem_base64 || null,
        times: cleanTimes,
        players: cleanPlayers
    }, 200);
}

// 5.1 Card de Habilidades da Sala
async function RoomCard(req, res) {
    if (!validarParceria(req, res)) return;

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const sessionId = url.searchParams.get('sessionId');

    if (!sessionId) {
        return mw.jsonResponse(res, { erro: 'BAD_REQUEST', error: 'BAD_REQUEST', msg: 'Parametro sessionId e obrigatorio' }, 400);
    }

    const resBridge = await bridgeRequest('/bridge/room-card', { sshash: sessionId });
    if (!resBridge || resBridge.sucesso === false) {
        return mw.jsonResponse(res, { erro: 'FAILED', error: 'FAILED', msg: resBridge?.erro || 'Nao foi possivel obter o card da sala' }, 500);
    }

    const cleanPlayer = (p) => {
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
    };

    mw.jsonResponse(res, {
        success: true,
        room_id: resBridge.room_id,
        imagem_base64: resBridge.imagem_base64,
        players: Array.isArray(resBridge.players) ? resBridge.players.map(cleanPlayer) : []
    }, 200);
}

// 5.2 Preview do Card de Habilidades (para testes diretos)
async function PreviewCard(req, res) {
    const renderModule = require('../../lib/render_sala_iniciada');
    const { characterIcon } = require('../../lib/player_skills/character_icons');
    const { resolveSkillIcon } = require('../../lib/player_skills/skill_catalog');
    const { normalizePet } = require('../../lib/player_skills/pet_catalog');

    try {
        const samplePlayer = (nick, charName, level, actSkillId, passSkillIds, petId) => ({
            nick,
            character_name: charName,
            avatar_icon_path: characterIcon(charName),
            level,
            plataforma: 'mobile',
            skills: [
                { is_active: true, skill_id: actSkillId, icon_path: resolveSkillIcon(actSkillId) },
                ...passSkillIds.map(id => ({ is_active: false, skill_id: id, icon_path: resolveSkillIcon(id) }))
            ],
            pet: normalizePet({ id: petId })
        });

        const time1 = [
            samplePlayer('@kokushibo*7', 'Orion', 56, 6206, [206, 1506, 1406], 1300000021),
            samplePlayer('brazzers\'777', 'Kla', 68, 806, [1406, 1506, 206], 1300000011),
            samplePlayer('Imthebest', 'Primis', 68, 2206, [206, 1406, 1506], null)
        ];

        const time2 = [
            samplePlayer('SEM PIEDADE', 'Thiva', 74, 4606, [206, 1506, 6506], 1300000001),
            samplePlayer('Gordin', 'Alok', 69, 22016, [206, 1406, 1506], 1300000021),
            samplePlayer('JG_TREMMx', 'Alok', 70, 2206, [206, 1406, 1506], 1300000011)
        ];

        const base64Url = await renderModule.renderSalaIniciadaImage({
            roomId: '139873280',
            time1,
            time2,
            modeName: 'Padrão Apostado',
            systemName: 'ZYON SYSTEM'
        });

        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        if (url.searchParams.get('format') === 'image' || url.searchParams.get('raw') === 'true') {
            const imgBuf = Buffer.from(base64Url.split(',')[1], 'base64');
            res.writeHead(200, {
                'Content-Type': 'image/png',
                'Content-Length': imgBuf.length
            });
            return res.end(imgBuf);
        }

        mw.jsonResponse(res, {
            success: true,
            message: 'Preview gerado com sucesso',
            room_id: 139873280,
            imagem_base64: base64Url
        }, 200);
    } catch (e) {
        mw.jsonResponse(res, { erro: 'FAILED', error: e.message }, 500);
    }
}

// 6. Encerrar Sala
async function StopRoom(req, res) {
    if (!validarParceria(req, res)) return;

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const sessionId = url.searchParams.get('sessionId');

    if (!sessionId) {
        return mw.jsonResponse(res, { erro: 'BAD_REQUEST', error: 'BAD_REQUEST', msg: 'Parametro sessionId e obrigatorio' }, 400);
    }

    // A bridge ja tem a sala no estado interno
    const resBridge = await bridgeRequest('/bridge/cancel-room', {
        sshash: sessionId
    });

    if (!resBridge) {
        return mw.jsonResponse(res, { erro: 'FAILED', error: 'FAILED', msg: 'Sem resposta da bridge' }, 500);
    }
    if (resBridge.status === 'SALA_NAO_ENCONTRADA' || resBridge.status === 'NOT_FOUND') {
        return mw.jsonResponse(res, { erro: 'NOT_FOUND', error: 'NOT_FOUND', msg: 'Sala nao encontrada ou encerrada' }, 404);
    }
    if (resBridge.status !== 'CANCELADA' && resBridge.sucesso !== true) {
        return mw.jsonResponse(res, { erro: 'FAILED', error: 'FAILED', msg: resBridge.msg || 'Erro ao encerrar sala' }, 500);
    }

    mw.jsonResponse(res, { success: true, message: 'Sala parada! Cooldown 3 min.' }, 200);
}

// 7. Ver Jogadores na Sala
async function Players(req, res) {
    if (!validarParceria(req, res)) return;

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const sessionId = url.searchParams.get('sessionId');

    if (!sessionId) {
        return mw.jsonResponse(res, { erro: 'BAD_REQUEST', error: 'BAD_REQUEST', msg: 'Parametro sessionId e obrigatorio' }, 400);
    }

    const resBridge = await bridgeRequest('/bridge/info-room', {
        sshash: sessionId
    });

    if (!resBridge || resBridge.status === 'SSHASH_INVALIDO') {
        return mw.jsonResponse(res, { erro: 'NOT_FOUND', error: 'NOT_FOUND', msg: 'Sala nao encontrada ou encerrada' }, 404);
    }

    const roomId = resBridge.room ? parseInt(resBridge.room.id || 0) : 0;
    const rawPlayers = resBridge.players || [];

    // Mapear time numérico para label
    const TEAM_LABEL = { 1: 'A', 2: 'B', 3: 'spectators' };

    const players = rawPlayers.map(p => {
        const teamNum = parseInt(p.team || 0);
        const teamLabel = TEAM_LABEL[teamNum] || 'outros';
        return {
            uid: parseInt(p.id) || 0,
            nickname: p.nickname || 'N/A',
            team: teamLabel,
            team_num: teamNum
        };
    });

    const teams = {
        A: players.filter(p => p.team === 'A'),
        B: players.filter(p => p.team === 'B'),
        spectators: players.filter(p => p.team === 'spectators'),
        outros: players.filter(p => p.team === 'outros')
    };

    mw.jsonResponse(res, {
        success: true,
        roomId: roomId,
        total: players.length,
        players: players,
        teams: teams
    }, 200);
}

// 7.1 Resultado da Partida (Scoreboard com MVP, Vencedores e Kills/Deltas)
async function ResultRoom(req, res) {
    if (!validarParceria(req, res)) return;

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const sessionId = url.searchParams.get('sessionId') || url.searchParams.get('sshash');
    const roomId = url.searchParams.get('roomId') || url.searchParams.get('room_id');

    if (!sessionId && !roomId) {
        return mw.jsonResponse(res, { erro: 'BAD_REQUEST', error: 'BAD_REQUEST', msg: 'Parametro sessionId ou roomId e obrigatorio' }, 400);
    }

    const resBridge = await bridgeRequest('/bridge/match-scoreboard', {
        sshash: sessionId || '',
        room_id: roomId || ''
    });

    if (!resBridge) {
        return mw.jsonResponse(res, { erro: 'FAILED', error: 'FAILED', msg: 'Sem resposta da bridge' }, 500);
    }

    if (resBridge.status === 'BASELINE_NAO_ENCONTRADA' || resBridge.status === 'NOT_FOUND') {
        return mw.jsonResponse(res, { erro: 'NOT_FOUND', error: 'NOT_FOUND', msg: resBridge.msg || 'Resultado ou Baseline nao encontrada' }, 404);
    }

    if (resBridge.status === 'ERRO' || resBridge.status === 'BOT_INDISPONIVEL') {
        return mw.jsonResponse(res, { erro: 'FAILED', error: 'FAILED', msg: resBridge.msg || 'Erro ao processar resultado' }, 500);
    }

    const format = url.searchParams.get('format');
    if (format === 'image' && resBridge.imagem_base64) {
        const base64Data = resBridge.imagem_base64.replace(/^data:image\/\w+;base64,/, '');
        const imgBuffer = Buffer.from(base64Data, 'base64');
        res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': imgBuffer.length
        });
        return res.end(imgBuffer);
    }

    mw.jsonResponse(res, {
        success: true,
        vitoria: resBridge.vitoria !== undefined ? resBridge.vitoria : null,
        imagem_base64: resBridge.imagem_base64 || null,
        ...resBridge
    }, 200);
}

// 8. Kickar Jogador
async function KickPlayer(req, res) {
    if (!validarParceria(req, res)) return;

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const sessionId = url.searchParams.get('sessionId');
    const targetUid = url.searchParams.get('targetUid');

    if (!sessionId || !targetUid) {
        return mw.jsonResponse(res, { erro: 'BAD_REQUEST', error: 'BAD_REQUEST', msg: 'Parametros sessionId e targetUid sao obrigatorios' }, 400);
    }

    const resBridge = await bridgeRequest('/bridge/expulsar', {
        sshash: sessionId,
        accountid: targetUid
    });

    if (!resBridge || resBridge.status !== 'EXPULSO') {
        return mw.jsonResponse(res, { erro: 'FAILED', error: 'FAILED', msg: (resBridge ? resBridge.msg : 'Erro na comunicacao com a bridge') }, 500);
    }

    mw.jsonResponse(res, { success: true }, 200);
}

// 9. Transferir Salas
async function Transfer(req, res) {
    if (!validarParceria(req, res)) return;

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const fromUserId = url.searchParams.get('fromUserId');
    const toUserId = url.searchParams.get('toUserId');
    const qtyStr = url.searchParams.get('quantity');

    if (!fromUserId || !toUserId || !qtyStr) {
        return mw.jsonResponse(res, { erro: 'BAD_REQUEST', error: 'BAD_REQUEST', msg: 'Parametros fromUserId, toUserId e quantity sao obrigatorios' }, 400);
    }

    const quantity = parseInt(qtyStr);
    if (isNaN(quantity) || quantity <= 0) {
        return mw.jsonResponse(res, { erro: 'BAD_REQUEST', error: 'BAD_REQUEST', msg: 'Quantidade invalida' }, 400);
    }

    const partnerKey = url.searchParams.get('partnerKey');
    const partnerKeysMap = db.carregarPartnerKeys() || {};
    const partnerKeyInfo = partnerKeysMap[partnerKey] || {};
    const bloquearCompartilhamento = partnerKeyInfo.bloquear_compartilhamento === true;

    const keysData = h.carregarKeysDB();

    // Filtrar chaves do remetente
    let fromKeys = (keysData.keys || []).filter(k => k && k.user_id === 'discord_' + fromUserId && k.ativa && !k.ilimitada);
    if (bloquearCompartilhamento) {
        fromKeys = fromKeys.filter(k => k.partner_key === partnerKey);
    } else {
        fromKeys = fromKeys.filter(k => {
            if (!k.partner_key) return true;
            const keyOwnerInfo = partnerKeysMap[k.partner_key];
            if (keyOwnerInfo && keyOwnerInfo.bloquear_compartilhamento === true) {
                return false;
            }
            return true;
        });
    }

    // 1. Calcular saldo total do remetente
    let totalBalanceFrom = 0;
    fromKeys.forEach(k => {
        totalBalanceFrom += Math.max(0, parseInt(k.limite_usos || 0) - parseInt(k.usos_totais || k.total_usos || 0));
    });

    if (totalBalanceFrom < quantity) {
        return mw.jsonResponse(res, { erro: 'BAD_REQUEST', error: 'BAD_REQUEST', msg: 'Saldo insuficiente para transferir' }, 400);
    }

    // 2. Deduzir saldo do remetente
    let remainingToDeduct = quantity;
    for (const k of fromKeys) {
        if (remainingToDeduct <= 0) break;
        const currentBalance = Math.max(0, parseInt(k.limite_usos || 0) - parseInt(k.usos_totais || k.total_usos || 0));
        if (currentBalance >= remainingToDeduct) {
            k.usos_totais = (parseInt(k.usos_totais || 0)) + remainingToDeduct;
            remainingToDeduct = 0;
        } else {
            k.usos_totais = (parseInt(k.usos_totais || 0)) + currentBalance;
            remainingToDeduct -= currentBalance;
        }
    }

    // 3. Adicionar saldo ao destinatário
    let toKeys = (keysData.keys || []).filter(k => k && k.user_id === 'discord_' + toUserId && k.ativa && !k.ilimitada);
    if (bloquearCompartilhamento) {
        toKeys = toKeys.filter(k => k.partner_key === partnerKey);
    } else {
        toKeys = toKeys.filter(k => {
            if (!k.partner_key) return true;
            const keyOwnerInfo = partnerKeysMap[k.partner_key];
            if (keyOwnerInfo && keyOwnerInfo.bloquear_compartilhamento === true) {
                return false;
            }
            return true;
        });
    }

    let targetKeyInfo = toKeys[0];
    if (targetKeyInfo) {
        targetKeyInfo.limite_usos = (parseInt(targetKeyInfo.limite_usos || 0)) + quantity;
    } else {
        const newKeyName = 'FFSL-' + crypto.randomBytes(8).toString('hex').toUpperCase();
        targetKeyInfo = {
            key: newKeyName,
            nome: 'Chave Transferida',
            ativa: true,
            ilimitada: false,
            limite_usos: quantity,
            usos_totais: 0,
            criada_em: h.obterHoraBrasilia(),
            ultima_request: null,
            user_id: 'discord_' + toUserId,
            comprado_por: 'parceria',
            partner_key: partnerKey || null
        };
        keysData.keys.push(targetKeyInfo);
    }

    // 4. Salvar base de chaves
    h.salvarKeysDB(keysData);

    // 5. Calcular novo saldo total do destinatário
    let newBalanceReceiver = 0;
    let updatedToKeys = (keysData.keys || []).filter(k => k && k.user_id === 'discord_' + toUserId && k.ativa);
    if (bloquearCompartilhamento) {
        updatedToKeys = updatedToKeys.filter(k => k.partner_key === partnerKey);
    } else {
        updatedToKeys = updatedToKeys.filter(k => {
            if (!k.partner_key) return true;
            const keyOwnerInfo = partnerKeysMap[k.partner_key];
            if (keyOwnerInfo && keyOwnerInfo.bloquear_compartilhamento === true) {
                return false;
            }
            return true;
        });
    }
    updatedToKeys.forEach(k => {
        if (k.ilimitada) {
            newBalanceReceiver = 999999;
        } else {
            newBalanceReceiver += Math.max(0, parseInt(k.limite_usos || 0) - parseInt(k.usos_totais || k.total_usos || 0));
        }
    });

    mw.jsonResponse(res, {
        success: true,
        fromUserId: fromUserId,
        toUserId: toUserId,
        quantity: quantity,
        newBalanceReceiver: newBalanceReceiver,
        message: `${quantity} sala(s) transferida(s) com sucesso.`
    }, 200);
}

function calcularLucrosParceiro(partnerKey) {
    const listaPag = Object.values(db.carregarPagamentos() || {});
    const partnerKeysMap = db.carregarPartnerKeys() || {};
    const keyInfo = partnerKeysMap[partnerKey] || {};
    const afiliadoAtivo = keyInfo.afiliado_ativo === true;
    const taxa = keyInfo.afiliado_taxa || 0;

    let totalAfiliado = 0;
    let totalSistema = 0;
    let totalCompras = 0;
    let totalFaturamento = 0;

    for (const pag of listaPag) {
        if (!pag) continue;

        let keyMatch = pag.partner_key === partnerKey;
        if (!pag.partner_key && partnerKey === 'neonstore7700099aaAHHhhzhha') {
            if (pag.cpf === '56508142879' || pag.nome === 'Rafael') {
                keyMatch = true;
            }
        }

        if (!keyMatch) continue;

        const status = h.getString(pag, 'status') || 'PENDENTE';
        const valor = h.getFloat(pag, 'valor');

        if (status === 'PAGO') {
            const criadoEm = h.getString(pag, 'criado_em');
            const pagoEm = h.getString(pag, 'pago_em');
            const dataRef = pagoEm || criadoEm;

            if (keyInfo.reset_lucro_at && dataRef < keyInfo.reset_lucro_at) {
                continue;
            }

            let valAfiliado = pag.valor_afiliado;
            let valSistema = pag.valor_sistema;
            if (valAfiliado === undefined) {
                valAfiliado = afiliadoAtivo ? (valor * (taxa / 100)) : 0;
            }
            if (valSistema === undefined) {
                valSistema = afiliadoAtivo ? (valor - valAfiliado) : valor;
            }
            totalAfiliado += valAfiliado;
            totalSistema += valSistema;
            totalCompras += (h.getFloat(pag, 'quantidade') || 0);
            totalFaturamento += valor;
        }
    }
    return { totalAfiliado, totalSistema, totalCompras, totalFaturamento };
}

async function LucroAfiliado(req, res) {
    if (!validarParceria(req, res)) return;
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const partnerKey = url.searchParams.get('partnerKey');
    const lucros = calcularLucrosParceiro(partnerKey);
    mw.jsonResponse(res, {
        sucesso: true,
        partnerKey: partnerKey,
        lucroAfiliado: parseFloat(lucros.totalAfiliado.toFixed(2))
    }, 200);
}

async function LucroSistema(req, res) {
    if (!validarParceria(req, res)) return;
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const partnerKey = url.searchParams.get('partnerKey');
    const lucros = calcularLucrosParceiro(partnerKey);
    mw.jsonResponse(res, {
        sucesso: true,
        partnerKey: partnerKey,
        lucroSistema: parseFloat(lucros.totalSistema.toFixed(2))
    }, 200);
}

async function Compras(req, res) {
    if (!validarParceria(req, res)) return;
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const partnerKey = url.searchParams.get('partnerKey');
    const lucros = calcularLucrosParceiro(partnerKey);
    mw.jsonResponse(res, {
        sucesso: true,
        partnerKey: partnerKey,
        compras: Math.floor(lucros.totalCompras)
    }, 200);
}

async function Faturamento(req, res) {
    if (!validarParceria(req, res)) return;
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const partnerKey = url.searchParams.get('partnerKey');
    const lucros = calcularLucrosParceiro(partnerKey);
    mw.jsonResponse(res, {
        sucesso: true,
        partnerKey: partnerKey,
        faturamento: parseFloat(lucros.totalFaturamento.toFixed(2))
    }, 200);
}

async function Comissao(req, res) {
    if (!validarParceria(req, res)) return;
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const partnerKey = url.searchParams.get('partnerKey');

    const partnerKeysMap = db.carregarPartnerKeys() || {};
    const keyInfo = partnerKeysMap[partnerKey] || {};

    mw.jsonResponse(res, {
        sucesso: true,
        partnerKey: partnerKey,
        afiliadoAtivo: keyInfo.afiliado_ativo === true,
        comissao: keyInfo.afiliado_taxa || 0
    }, 200);
}

async function ResetLucro(req, res) {
    if (!validarParceria(req, res)) return;
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const partnerKey = url.searchParams.get('partnerKey');

    const partnerKeysMap = db.carregarPartnerKeys() || {};
    const keyInfo = partnerKeysMap[partnerKey];
    if (keyInfo) {
        keyInfo.saldo_afiliado = 0;
        keyInfo.reset_lucro_at = h.obterHoraBrasilia();
        db.salvarPartnerKey(keyInfo);
    }

    mw.jsonResponse(res, {
        sucesso: true,
        partnerKey: partnerKey,
        msg: 'Valores de lucro do afiliado e do sistema zerados com sucesso.'
    }, 200);
}

async function Saque(req, res) {
    let body = {};
    if (req.method === 'POST') {
        body = await mw.parseJSON(req).catch(() => ({}));
    }
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    
    const partnerKey = (body.partnerKey || body.keymaster || body.key || url.searchParams.get('partnerKey') || url.searchParams.get('keymaster') || url.searchParams.get('key') || '').trim();
    if (!partnerKey) {
        return mw.jsonResponse(res, { sucesso: false, erro: 'UNAUTHORIZED', error: 'UNAUTHORIZED', msg: 'Chave de parceria nao fornecida' }, 401);
    }

    const partnerKeys = db.carregarPartnerKeys() || {};
    const keyInfo = partnerKeys[partnerKey];
    if (!keyInfo || !keyInfo.ativa) {
        return mw.jsonResponse(res, { sucesso: false, erro: 'UNAUTHORIZED', error: 'UNAUTHORIZED', msg: 'Chave de parceria invalida ou inativa' }, 401);
    }

    // Chave PIX cadastrada na Key Master
    const chavePix = (keyInfo.afiliado_pix || '').trim();
    if (!chavePix) {
        return mw.jsonResponse(res, {
            sucesso: false,
            erro: 'CHAVE_PIX_NAO_CADASTRADA',
            msg: 'Nao e possivel realizar o saque pois nao ha nenhuma chave PIX cadastrada nesta Key Master. Por favor, entre em contato com o suporte.'
        }, 400);
    }

    // Obter o lucro atual disponível do afiliado
    const lucros = calcularLucrosParceiro(partnerKey);
    const saldoAfiliadoDisponivel = parseFloat((lucros.totalAfiliado || 0).toFixed(2));

    if (saldoAfiliadoDisponivel <= 0) {
        return mw.jsonResponse(res, {
            sucesso: false,
            erro: 'SALDO_INSUFICIENTE',
            msg: 'Nao ha lucro de afiliado disponivel para saque (Saldo atual: R$ 0.00).',
            lucroAfiliado: 0
        }, 400);
    }

    // Saque do valor total do Lucro do Afiliado
    let valor = saldoAfiliadoDisponivel;
    const valorParam = body.valor !== undefined ? body.valor : (body.amount !== undefined ? body.amount : (url.searchParams.get('valor') || url.searchParams.get('amount')));
    if (valorParam !== undefined && valorParam !== null && valorParam !== '') {
        const vParsed = parseFloat(valorParam);
        if (!isNaN(vParsed) && vParsed > 0) {
            if (vParsed > saldoAfiliadoDisponivel) {
                return mw.jsonResponse(res, {
                    sucesso: false,
                    erro: 'VALOR_EXCEDE_LUCRO',
                    msg: `Valor solicitado (R$ ${vParsed.toFixed(2)}) e maior que o lucro maximo disponivel do afiliado (R$ ${saldoAfiliadoDisponivel.toFixed(2)}).`,
                    lucroAfiliado: saldoAfiliadoDisponivel,
                    maximoDisponivel: saldoAfiliadoDisponivel
                }, 400);
            }
            valor = vParsed;
        }
    }

    const amountCents = Math.round(valor * 100);
    const recipientName = (body.nome || body.recipientName || url.searchParams.get('nome') || keyInfo.nome || 'Afiliado').trim();
    const recipientDocument = (body.cpf || body.document || body.recipientDocument || url.searchParams.get('cpf') || '').trim();
    const pixKeyType = (body.pixKeyType || url.searchParams.get('pixKeyType') || '').trim() || undefined;

    try {
        const resultadoPayout = await turbofyApi.criarLotePayout({
            pixKey: chavePix,
            amountCents: amountCents,
            recipientName: recipientName,
            recipientDocument: recipientDocument,
            description: `Saque Afiliado Key ${partnerKey} - R$ ${valor.toFixed(2)}`,
            pixKeyType: pixKeyType
        });

        // Apos o envio com sucesso do payout, reseta o saldo do afiliado da keymaster
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
            msg: `Saque de R$ ${valor.toFixed(2)} enviado com sucesso via Turbofy PIX! Saldo do afiliado zerado e saldo do sistema atualizado.`,
            partnerKey: partnerKey,
            chavePix: chavePix,
            valor: valor,
            batchId: resultadoPayout.batchId,
            status: resultadoPayout.status,
            saldoAfiliadoAtual: 0,
            saldoSistemaRestante: configPag.turbofy_saldo
        }, 200);

    } catch (err) {
        console.error(`[SAQUE PARCERIA] Erro ao processar saque para key ${partnerKey}:`, err.message);
        return mw.jsonResponse(res, {
            sucesso: false,
            erro: 'ERRO_GATEWAY_TURBOFY',
            msg: `Erro no envio do PIX Turbofy: ${err.message}`
        }, 500);
    }
}

module.exports = {
    GeneratePayment,
    OrderStatus,
    Saldo,
    CreateRoom,
    StartRoom,
    StopRoom,
    Players,
    KickPlayer,
    Transfer,
    LucroAfiliado,
    LucroSistema,
    Compras,
    Faturamento,
    Comissao,
    ResetLucro,
    Saque,
    ResultRoom,
    RoomCard,
    PreviewCard,
    calcularLucrosParceiro,
    processarPagamentoConfirmadoParceria
};
