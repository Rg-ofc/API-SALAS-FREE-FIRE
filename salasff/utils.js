/**
 * utils.js - Utilitarios gerais (conversao de utils.py)
 */

const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const dbSqlite = require('./db_postgres');

const KEY = Buffer.from([89, 103, 38, 116, 99, 37, 68, 69, 117, 104, 54, 37, 90, 99, 94, 56]);
const IV = Buffer.from([54, 111, 121, 90, 68, 114, 50, 50, 69, 51, 121, 99, 104, 106, 77, 37]);

const AVATAR_FIXO = 902000105;

const HTTP_HEADERS = {
    'User-Agent': "UnityPlayer/2018.4.12f1 (UnityWebRequest/1.0, libcurl/8.5.0-DEV)",
    'Connection': "Keep-Alive",
    'Accept': "*/*",
    'Accept-Encoding': "deflate, gzip",
    'Content-Type': "application/x-www-form-urlencoded",
    'Expect': "100-continue",
    'X-Unity-Version': "2018.4.12f1",
    'X-GA': "v1 1",
    get 'X-GA-SV'() { return String(Math.floor(Date.now() / 1000)); },
    'ReleaseVersion': "OB55"
};

function obterHoraBrasilia() {
    const now = new Date();
    // UTC-3
    const offset = -3 * 60;
    const local = new Date(now.getTime() + offset * 60 * 1000);
    const y = local.getUTCFullYear();
    const m = String(local.getUTCMonth() + 1).padStart(2, '0');
    const d = String(local.getUTCDate()).padStart(2, '0');
    const h = String(local.getUTCHours()).padStart(2, '0');
    const min = String(local.getUTCMinutes()).padStart(2, '0');
    const s = String(local.getUTCSeconds()).padStart(2, '0');
    return `${y}-${m}-${d} ${h}:${min}:${s}`;
}


// ReconnBatcher - Agrupa logs de reconexao

class ReconnBatcher {
    constructor(intervalo = 3.0) {
        this._pendentes = [];
        this._pendentesOk = [];
        this._timer = null;
        this._timerOk = null;
        this._intervalo = intervalo * 1000; // ms
    }

    adicionar(accountId, nickname, tentativa = null) {
        this._pendentes.push({ accountId, nickname, tentativa });
        if (!this._timer) {
            this._timer = setTimeout(() => this._flush(), this._intervalo);
        }
    }

    _flush() {
        const pendentes = [...this._pendentes];
        this._pendentes = [];
        this._timer = null;
        if (!pendentes.length) return;
        if (pendentes.length <= 3) {
            for (const { accountId, nickname, tentativa } of pendentes) {
                const tag = Logger._tag(Logger.BG_AMARELO, Logger.AMARELO, "RECONN");
                const extra = tentativa ? ` ${Logger.CINZA}(tentativa ${tentativa})${Logger.R}` : "";
                Logger._line(tag, `${Logger.AMARELO}${nickname}${Logger.R} ${Logger.CINZA}|${Logger.R} ID ${Logger.B}${accountId}${Logger.R}${extra}`);
            }
        } else {
            const tag = Logger._tag(Logger.BG_AMARELO, Logger.AMARELO, "RECONN");
            Logger._line(tag, `${Logger.AMARELO}${pendentes.length} contas reconectando...${Logger.R}`);
        }
    }

    adicionarOk(accountId, nickname) {
        this._pendentesOk.push({ accountId, nickname });
        if (!this._timerOk) {
            this._timerOk = setTimeout(() => this._flushOk(), this._intervalo);
        }
    }

    _flushOk() {
        const pendentes = [...this._pendentesOk];
        this._pendentesOk = [];
        this._timerOk = null;
        if (!pendentes.length) return;
        if (pendentes.length <= 3) {
            for (const { accountId, nickname } of pendentes) {
                const tag = Logger._tag(Logger.BG_VERDE, Logger.VERDE, "RECONN");
                Logger._line(tag, `${Logger.VERDE}${nickname}${Logger.R} ${Logger.CINZA}|${Logger.R} ID ${Logger.B}${accountId}${Logger.R} ${Logger.VERDE}reconectado${Logger.R}`);
            }
        } else {
            const tag = Logger._tag(Logger.BG_VERDE, Logger.VERDE, "RECONN");
            Logger._line(tag, `${Logger.VERDE}${pendentes.length} contas reconectadas com sucesso${Logger.R}`);
        }
    }
}

const _reconnBatcher = new ReconnBatcher(3.0);

// Logger

class Logger {
    static R = '\x1b[0m';
    static B = '\x1b[1m';
    static DIM = '\x1b[2m';

    static VERDE = '\x1b[38;5;84m';
    static VERMELHO = '\x1b[38;5;196m';
    static AMARELO = '\x1b[38;5;220m';
    static AZUL = '\x1b[38;5;75m';
    static CIANO = '\x1b[38;5;87m';
    static MAGENTA = '\x1b[38;5;177m';
    static BRANCO = '\x1b[38;5;252m';
    static CINZA = '\x1b[38;5;242m';
    static LARANJA = '\x1b[38;5;208m';

    static BG_VERDE = '\x1b[48;5;22m';
    static BG_VERMELHO = '\x1b[48;5;52m';
    static BG_AMARELO = '\x1b[48;5;58m';
    static BG_AZUL = '\x1b[48;5;17m';
    static BG_MAGENTA = '\x1b[48;5;53m';
    static BG_CIANO = '\x1b[48;5;23m';

    static _ts() {
        return obterHoraBrasilia();
    }

    static _tag(bg, fg, text) {
        return `${bg}${fg}${Logger.B} ${text} ${Logger.R}`;
    }

    static _line(tag, msg) {
        const ts = Logger._ts();
        process.stdout.write(`  ${Logger.CINZA}${ts}${Logger.R}  ${tag}  ${msg}\n`);
    }

    static sistema(message) {
        const tag = Logger._tag(Logger.BG_AZUL, Logger.AZUL, "SYSTEM");
        Logger._line(tag, `${Logger.BRANCO}${message}${Logger.R}`);
    }

    static logada(accountId, nickname, guestuid) {
        const tag = Logger._tag(Logger.BG_VERDE, Logger.VERDE, "ONLINE");
        Logger._line(tag, `${Logger.VERDE}${nickname}${Logger.R} ${Logger.CINZA}|${Logger.R} ID ${Logger.B}${accountId}${Logger.R} ${Logger.CINZA}|${Logger.R} GuestUID ${Logger.DIM}${guestuid}${Logger.R}`);
    }

    static login(uid, message) {
        const tag = Logger._tag(Logger.BG_CIANO, Logger.CIANO, "LOGIN ");
        Logger._line(tag, `${Logger.CIANO}GuestUID ${uid}${Logger.R} ${Logger.CINZA}->${Logger.R} ${message}`);
    }

    static erro(uid, message) {
        const tag = Logger._tag(Logger.BG_VERMELHO, Logger.VERMELHO, " ERRO ");
        Logger._line(tag, `${Logger.VERMELHO}GuestUID ${uid}${Logger.R} ${Logger.CINZA}->${Logger.R} ${message}`);
    }

    static api(message) {
        const tag = Logger._tag(Logger.BG_AMARELO, Logger.AMARELO, " API  ");
        Logger._line(tag, `${Logger.BRANCO}${message}${Logger.R}`);
    }

    static executado(message) {
        const tag = Logger._tag(Logger.BG_MAGENTA, Logger.MAGENTA, " EXEC ");
        Logger._line(tag, `${Logger.MAGENTA}${message}${Logger.R}`);
    }

    static sala(message) {
        const tag = Logger._tag(Logger.BG_CIANO, Logger.CIANO, " SALA ");
        Logger._line(tag, `${Logger.CIANO}${message}${Logger.R}`);
    }

    static reconectando(accountId, nickname, tentativa = null) {
        _reconnBatcher.adicionar(accountId, nickname, tentativa);
    }

    static reconectado(accountId, nickname) {
        _reconnBatcher.adicionarOk(accountId, nickname);
    }

    static desconectado(accountId, nickname, motivo = null) {
        const tag = Logger._tag(Logger.BG_VERMELHO, Logger.VERMELHO, " DISC ");
        const extra = motivo ? ` ${Logger.CINZA}-> ${motivo}${Logger.R}` : "";
        Logger._line(tag, `${Logger.VERMELHO}${nickname}${Logger.R} ${Logger.CINZA}|${Logger.R} ID ${Logger.B}${accountId}${Logger.R}${extra}`);
    }

    static info(message) {
        const tag = Logger._tag(Logger.BG_AZUL, Logger.BRANCO, " INFO ");
        Logger._line(tag, `${Logger.BRANCO}${message}${Logger.R}`);
    }
}

// Funcoes de criptografia

function protoCriptografado(hexCodificado) {
    const chave = Buffer.from('Yg&tc%DEuh6%Zc^8');
    const iv = Buffer.from('6oyZDr22E3ychjM%');
    const blockSize = 16;
    const padded = pkcs7Pad(hexCodificado, blockSize);
    const cipher = crypto.createCipheriv('aes-128-cbc', chave, iv);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(padded), cipher.final()]);
}

function pkcs7Pad(data, blockSize) {
    if (typeof data === 'string') {
        data = Buffer.from(data, 'hex');
    }
    if (!Buffer.isBuffer(data)) {
        data = Buffer.from(data);
    }
    const padLen = blockSize - (data.length % blockSize);
    const padBuf = Buffer.alloc(padLen, padLen);
    return Buffer.concat([data, padBuf]);
}

function criptografarPacote(textoPlano, chave, iv) {
    let data;
    if (typeof textoPlano === 'string') {
        data = Buffer.from(textoPlano, 'hex');
    } else {
        data = textoPlano;
    }
    const keyBuf = garantirBytes(chave);
    const ivBuf = garantirBytes(iv);
    const blockSize = 16;
    const padded = pkcs7Pad(data, blockSize);
    const cipher = crypto.createCipheriv('aes-128-cbc', keyBuf, ivBuf);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
    return encrypted.toString('hex');
}

function garantirBytes(valor) {
    if (typeof valor === 'string') {
        return Buffer.from(valor, 'hex');
    }
    if (Buffer.isBuffer(valor)) {
        return valor;
    }
    return Buffer.from(valor);
}

function decParaHex(valor) {
    let resultado = valor.toString(16);
    if (resultado.length === 1) {
        resultado = '0' + resultado;
    }
    return resultado;
}

function codificarVarint(numero) {
    numero = Number(numero);
    const bytesArr = [];
    while (true) {
        let byte = numero & 0x7F;
        numero = Math.floor(numero / 128);
        if (numero) {
            byte |= 0x80;
        }
        bytesArr.push(byte);
        if (!numero) break;
    }
    return Buffer.from(bytesArr).toString('hex');
}

function encodeVarint(numero) {
    numero = Number(numero);
    const bytesArr = [];
    while (true) {
        let byte = numero & 0x7F;
        numero = Math.floor(numero / 128);
        if (numero) {
            byte |= 0x80;
        }
        bytesArr.push(byte);
        if (!numero) break;
    }
    return Buffer.from(bytesArr);
}

function buildGetBackpackPayload() {
    let payload = Buffer.alloc(0);
    payload = Buffer.concat([payload, Buffer.from([(2 << 3) | 0])]);
    payload = Buffer.concat([payload, encodeVarint(1)]);
    payload = Buffer.concat([payload, Buffer.from([(3 << 3) | 2])]);
    const langBytes = Buffer.from("pt-br", 'utf-8');
    payload = Buffer.concat([payload, encodeVarint(langBytes.length)]);
    payload = Buffer.concat([payload, langBytes]);
    payload = Buffer.concat([payload, Buffer.from([(4 << 3) | 0])]);
    payload = Buffer.concat([payload, encodeVarint(1)]);
    const padded = pkcs7Pad(payload, 16);
    const cipher = crypto.createCipheriv('aes-128-cbc', KEY, IV);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(padded), cipher.final()]);
}

function buildUpdateBioPayload(signatureText) {
    let payload = Buffer.alloc(0);
    const sigBytes = Buffer.from(signatureText, 'utf-8');
    payload = Buffer.concat([payload, Buffer.from([(8 << 3) | 2])]);
    payload = Buffer.concat([payload, encodeVarint(sigBytes.length)]);
    payload = Buffer.concat([payload, sigBytes]);
    const padded = pkcs7Pad(payload, 16);
    const cipher = crypto.createCipheriv('aes-128-cbc', KEY, IV);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(padded), cipher.final()]);
}

// User Agent aleatorio

const _UA_VERSOES = ['4.0.18P6', '4.0.19P7', '4.0.20P1', '4.1.0P3'];
const _UA_MODELOS = ['G011A', 'G012B', 'SM-G973F', 'Pixel 3', 'Redmi Note 8'];
const _UA_ANDROID = ['8.1', '9', '10', '11', '12'];
const _UA_IDIOMAS = ['en', 'en-US', 'id', 'es', 'pt-BR'];
const _UA_PAISES = ['USA', 'IND', 'IDN', 'BRA', 'MEX'];

function randomChoice(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function obterUserAgentAleatorio() {
    const versao = randomChoice(_UA_VERSOES);
    const modelo = randomChoice(_UA_MODELOS);
    const android = randomChoice(_UA_ANDROID);
    const idioma = randomChoice(_UA_IDIOMAS);
    const pais = randomChoice(_UA_PAISES);
    return `GarenaMSDK/${versao}(${modelo} ;Android ${android};${idioma};${pais};)`;
}

// Room accounts data (shared state)

const CONTAS_DIR = "Contas";

const roomAccountsData = {};
let roomAccountsDirty = false;

function _garantirPastaContas() {
    try {
        fs.mkdirSync(CONTAS_DIR, { recursive: true });
    } catch (e) { /* ignore */ }
}

function carregarRoomAccountsTxt() {
    _garantirPastaContas();
    const filepath = path.join(CONTAS_DIR, 'room-accounts.txt');
    if (!fs.existsSync(filepath)) return [];
    try {
        const lines = fs.readFileSync(filepath, 'utf-8').split('\n');
        const accounts = [];
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.includes(':')) {
                const [uid, password] = trimmed.split(':', 2);
                accounts.push([uid, password]);
            }
        }
        return accounts;
    } catch (e) {
        return [];
    }
}

function saveRoomAccountsData() {
    if (!roomAccountsDirty) return;
    const dataSnapshot = {};
    for (const [uid, data] of Object.entries(roomAccountsData)) {
        dataSnapshot[uid] = { ...data };
    }
    roomAccountsDirty = false;
    try {
        dbSqlite.salvarTodosRoomAccounts(dataSnapshot);
    } catch (e) {
        roomAccountsDirty = true;
        Logger.erro("system", `Erro ao salvar room_accounts: ${e.message}`);
    }
}

function marcarRoomDirty() {
    roomAccountsDirty = true;
}

function loadRoomAccountsData() {
    _garantirPastaContas();
    let dados = dbSqlite.carregarRoomAccounts();
    if (dados && Object.keys(dados).length > 0) {
        const contasTxt = carregarRoomAccountsTxt();
        const uidsValidos = new Set(contasTxt.map(([uid]) => uid));
        if (uidsValidos.size > 0) {
            const dadosFiltrados = {};
            for (const [uid, data] of Object.entries(dados)) {
                if (uidsValidos.has(uid)) {
                    dadosFiltrados[uid] = data;
                }
            }
            const removidas = Object.keys(dados).length - Object.keys(dadosFiltrados).length;
            if (removidas > 0) {
                Logger.sistema(`[ROOM] Removidas ${removidas} contas fantasma do SQLite (nao estao no room-accounts.txt)`);
                try {
                    const uidsRemover = new Set(Object.keys(dados).filter(uid => !uidsValidos.has(uid)));
                    if (uidsRemover.size > 0) {
                        dbSqlite.removerRoomAccounts(uidsRemover);
                    }
                } catch (e) { /* ignore */ }
            }
            Object.assign(roomAccountsData, dadosFiltrados);
        } else {
            Object.assign(roomAccountsData, dados);
        }
    }
}

module.exports = {
    KEY,
    IV,
    AVATAR_FIXO,
    HTTP_HEADERS,
    obterHoraBrasilia,
    Logger,
    protoCriptografado,
    criptografarPacote,
    garantirBytes,
    decParaHex,
    codificarVarint,
    encodeVarint,
    buildGetBackpackPayload,
    buildUpdateBioPayload,
    obterUserAgentAleatorio,
    CONTAS_DIR,
    roomAccountsData,
    get roomAccountsDirty() { return roomAccountsDirty; },
    carregarRoomAccountsTxt,
    saveRoomAccountsData,
    marcarRoomDirty,
    loadRoomAccountsData,
    pkcs7Pad,
    randomChoice
};
