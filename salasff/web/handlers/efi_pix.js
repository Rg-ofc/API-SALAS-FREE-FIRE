/**
 * efi_pix.js — EfiBank PIX integration (mTLS)
 * Convertido de internal/http/handlers/efi_pix.go
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const querystring = require('querystring');
const config = require('../config');
const h = require('./helpers');
const db = require('../../db_postgres');

let efiTokenCache = '';
let efiTokenExpiresAt = 0;

function getEfiTLSAgent() {
    const certFile = path.join(config.CertsDir(), 'certificado.pem');
    const keyFile = path.join(config.CertsDir(), 'chave.pem');
    const cert = fs.readFileSync(certFile);
    const key = fs.readFileSync(keyFile);
    return new https.Agent({ cert, key, rejectUnauthorized: true });
}

function efiRequest(method, urlPath, token, body) {
    return new Promise((resolve, reject) => {
        const agent = getEfiTLSAgent();
        const url = new URL(config.EfiAPIURL + urlPath);
        const headers = {};
        if (token) headers['Authorization'] = 'Bearer ' + token;
        let data = null;
        if (body && typeof body === 'string') {
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
            data = body;
        } else if (body) {
            headers['Content-Type'] = 'application/json';
            data = JSON.stringify(body);
        }
        if (data) headers['Content-Length'] = Buffer.byteLength(data);
        const req = https.request({ hostname: url.hostname, path: url.pathname + url.search, method, headers, agent, timeout: 30000 }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const respBody = Buffer.concat(chunks).toString();
                try { resolve({ status: res.statusCode, body: JSON.parse(respBody) }); }
                catch { resolve({ status: res.statusCode, body: respBody }); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        if (data) req.write(data);
        req.end();
    });
}

function efiBasicRequest(method, urlPath, basicAuth, body) {
    return new Promise((resolve, reject) => {
        const agent = getEfiTLSAgent();
        const url = new URL(config.EfiAPIURL + urlPath);
        const headers = { 'Authorization': 'Basic ' + basicAuth, 'Content-Type': 'application/x-www-form-urlencoded' };
        const data = body || '';
        if (data) headers['Content-Length'] = Buffer.byteLength(data);
        const req = https.request({ hostname: url.hostname, path: url.pathname, method, headers, agent, timeout: 30000 }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const respBody = Buffer.concat(chunks).toString();
                try { resolve({ status: res.statusCode, body: JSON.parse(respBody) }); }
                catch { resolve({ status: res.statusCode, body: respBody }); }
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

async function obterTokenEfi() {
    if (efiTokenCache && Date.now() < efiTokenExpiresAt) return efiTokenCache;
    const auth = Buffer.from(config.EfiClientID + ':' + config.EfiClientSecret).toString('base64');
    const data = 'grant_type=client_credentials';
    const result = await efiBasicRequest('POST', '/oauth/token', auth, data);
    if (result.status !== 200 || !result.body.access_token) throw new Error('Falha ao obter token EfiBank: ' + JSON.stringify(result.body));
    const expiresIn = result.body.expires_in || 3600;
    efiTokenCache = result.body.access_token;
    efiTokenExpiresAt = Date.now() + (expiresIn - 60) * 1000;
    console.log(`  \x1b[92m[EFI]\x1b[0m Token OAuth2 obtido com sucesso (expira em ${expiresIn}s)`);
    return efiTokenCache;
}

async function criarCobrancaPixEfi(valor, cpf, nome, descricao) {
    try {
        const token = await obterTokenEfi();
        const valorStr = valor.toFixed(2);
        const payload = { calendario: { expiracao: 3600 }, valor: { original: valorStr }, solicitacaoPagador: descricao };
        if (cpf) {
            const cpfLimpo = cpf.replace(/[.\-\s]/g, '');
            const devedor = { nome };
            if (cpfLimpo.length === 11) devedor.cpf = cpfLimpo;
            else if (cpfLimpo.length === 14) devedor.cnpj = cpfLimpo;
            payload.devedor = devedor;
        }
        if (config.EfiPixKey) payload.chave = config.EfiPixKey;
        else {
            const chaveAuto = await obterChavePixEfi(token);
            payload.chave = chaveAuto;
        }
        console.log(`  \x1b[94m[EFI]\x1b[0m Criando cobranca PIX: R$ ${valorStr} | ${nome}`);
        const resp = await efiRequest('POST', '/v2/cob', token, payload);
        if (resp.status !== 200 && resp.status !== 201) {
            const erroMsg = resp.body?.mensagem || resp.body?.violacoes?.[0]?.razao || 'Falha na API do EfiBank.';
            console.error(`  \x1b[91m[EFI ERRO]\x1b[0m Status ${resp.status}`);
            return { erro: erroMsg };
        }
        const txid = h.getString(resp.body, 'txid');
        const pixCopiaECola = h.getString(resp.body, 'pixCopiaECola');
        const locID = resp.body?.loc?.id ? String(Math.floor(resp.body.loc.id)) : '';
        let qrcodeImg = '';
        if (locID) {
            const qrResult = await obterQRCodeEfi(token, locID);
            qrcodeImg = h.getString(qrResult, 'imagemQrcode');
        }
        if (!qrcodeImg && pixCopiaECola) {
            qrcodeImg = 'https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=' + encodeURIComponent(pixCopiaECola);
        }
        console.log(`  \x1b[92m[EFI]\x1b[0m PIX criado com sucesso: ${txid} | R$ ${valorStr}`);
        return { txid, status: 'ATIVA', valor, qrcode_imagem: qrcodeImg, qrcode_texto: pixCopiaECola, link_pagamento: '', expiracao: 3600 };
    } catch (err) {
        console.error(`  \x1b[91m[EFI ERRO]\x1b[0m ${err.message}`);
        return { erro: 'Falha ao conectar com EfiBank. Tente novamente.' };
    }
}

async function obterQRCodeEfi(token, locID) {
    try {
        const resp = await efiRequest('GET', `/v2/loc/${locID}/qrcode`, token);
        return resp.status === 200 ? resp.body : {};
    } catch { return {}; }
}

async function obterChavePixEfi(token) {
    const resp = await efiRequest('GET', '/v2/gn/evp', token);
    if (resp.status !== 200) throw new Error('Erro ao listar chaves EVP: status ' + resp.status);
    const chaves = resp.body?.chaves;
    if (Array.isArray(chaves) && chaves.length > 0 && typeof chaves[0] === 'string') {
        console.log(`  \x1b[92m[EFI]\x1b[0m Chave PIX EVP obtida automaticamente: ${chaves[0]}`);
        config.EfiPixKey = chaves[0];
        return chaves[0];
    }
    throw new Error('Nenhuma chave EVP encontrada na conta EfiBank');
}

async function verificarPagamentoEfi(txid) {
    if (!txid) return { erro: 'TXID invalido' };
    try {
        const token = await obterTokenEfi();
        const resp = await efiRequest('GET', `/v2/cob/${txid}`, token);
        if (resp.status !== 200) return { erro: 'Falha na API do EfiBank.' };
        const statusEfi = h.getString(resp.body, 'status');
        let statusNormalizado = 'PENDENTE';
        if (statusEfi === 'CONCLUIDA') statusNormalizado = 'CONCLUIDA';
        else if (statusEfi === 'REMOVIDA_PELO_USUARIO_RECEBEDOR' || statusEfi === 'REMOVIDA_PELO_PSP') statusNormalizado = 'CANCELADA';
        const valorOriginal = resp.body?.valor?.original || '';
        return { status: statusNormalizado, status_original: statusEfi, txid, valor: valorOriginal };
    } catch (err) {
        return { erro: 'Falha na API do EfiBank.' };
    }
}

function VerificarCertificadosEfi() {
    const certFile = path.join(config.CertsDir(), 'certificado.pem');
    const keyFile = path.join(config.CertsDir(), 'chave.pem');
    if (!fs.existsSync(certFile)) {
        console.log(`  \x1b[93m[EFI AVISO]\x1b[0m Certificado nao encontrado: ${certFile}`);
        console.log(`  \x1b[93m[EFI AVISO]\x1b[0m Extraia do .p12: openssl pkcs12 -in producao.p12 -out certificado.pem -clcerts -nokeys -passin pass:`);
        return;
    }
    if (!fs.existsSync(keyFile)) {
        console.log(`  \x1b[93m[EFI AVISO]\x1b[0m Chave privada nao encontrada: ${keyFile}`);
        return;
    }
    console.log(`  \x1b[92m[EFI]\x1b[0m Certificados encontrados em ${config.CertsDir()}`);
}

module.exports = { criarCobrancaPixEfi, verificarPagamentoEfi, VerificarCertificadosEfi, obterTokenEfi };
