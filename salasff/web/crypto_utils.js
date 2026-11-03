'use strict';

const crypto = require('crypto');
const config = require('./config');

function gerarChaveAES() {
    const combinada = config.AESKey + config.AESSalt;
    return crypto.createHash('sha256').update(combinada).digest();
}

function criptografarDados(dados) {
    let dadosStr;
    if (typeof dados === 'string') {
        dadosStr = dados;
    } else {
        dadosStr = JSON.stringify(dados);
    }
    const chave = gerarChaveAES();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cfb', chave, iv);
    const criptografado = Buffer.concat([cipher.update(dadosStr, 'utf-8'), cipher.final()]);
    return Buffer.concat([iv, criptografado]).toString('base64');
}

function descriptografarDados(dadosCriptografados) {
    const dadosBytes = Buffer.from(dadosCriptografados, 'base64');
    if (dadosBytes.length < 16) throw new Error('dados criptografados muito curtos');
    const iv = dadosBytes.subarray(0, 16);
    const dadosCifrados = dadosBytes.subarray(16);
    const chave = gerarChaveAES();
    const decipher = crypto.createDecipheriv('aes-256-cfb', chave, iv);
    const descriptografado = Buffer.concat([decipher.update(dadosCifrados), decipher.final()]).toString('utf-8');
    try {
        return JSON.parse(descriptografado);
    } catch {
        return descriptografado;
    }
}

function validarCSRF(csrfSessao, csrfRequest) {
    if (!csrfSessao || !csrfRequest) return false;
    return crypto.timingSafeEqual(Buffer.from(csrfSessao), Buffer.from(csrfRequest));
}

function gerarCSRFToken() {
    return crypto.randomBytes(32).toString('hex');
}

function gerarTokenSessao() {
    return crypto.randomBytes(64).toString('base64url');
}

function gerarHashKey() {
    return 'FFSL-' + crypto.randomBytes(8).toString('hex').toUpperCase();
}

module.exports = {
    criptografarDados,
    descriptografarDados,
    validarCSRF,
    gerarCSRFToken,
    gerarTokenSessao,
    gerarHashKey,
};
