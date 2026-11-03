'use strict';

const express = require('express');
const net = require('net');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');

const PROXY_ENABLED = process.env.PROXY_ENABLED === 'true' || false;
const PROXY_HOST = process.env.PROXY_HOST || '';
const PROXY_PORT = process.env.PROXY_PORT || '';
const PROXY_USER = process.env.PROXY_USER || '';
const PROXY_PASS = process.env.PROXY_PASS || '';

const LISTA_PROXIES = [];

function obterProxyParaRegiao(region) {
    if (!PROXY_ENABLED) return null;

    let proxiesDisponiveis = LISTA_PROXIES;
    if (region && region !== 'ANY') {
        const filtradas = LISTA_PROXIES.filter(p => p.region.toUpperCase() === region.toUpperCase());
        if (filtradas.length > 0) {
            proxiesDisponiveis = filtradas;
        }
    }

    if (proxiesDisponiveis.length === 0) {
        // Fallback para as variáveis de ambiente padrões se a lista estiver vazia
        return {
            host: PROXY_HOST,
            port: PROXY_PORT,
            user: PROXY_USER,
            pass: PROXY_PASS,
            region: PROXY_USER.includes('__cr.sg') ? 'SG' : 'BR'
        };
    }

    // Escolhe aleatoriamente da lista filtrada
    const escolhido = proxiesDisponiveis[Math.floor(Math.random() * proxiesDisponiveis.length)];
    return escolhido;
}

let proxyUrl = null;
if (PROXY_ENABLED && PROXY_HOST) {
    proxyUrl = `http://${PROXY_USER}:${PROXY_PASS}@${PROXY_HOST}:${PROXY_PORT}`;
    console.log(`[PROXY] Proxy ativada no gerador: ${PROXY_HOST}:${PROXY_PORT} (Alternância dinâmica de 3 proxies ativada)`);
}

let currentProxyConfig = null;
let currentSessionId = Math.random().toString(36).substring(2, 10);
let currentSessionUses = 0;
const MAX_USES_PER_SESSION = 7;

function rotacionarSessionId(motivo, region) {
    const oldSession = currentSessionId;
    currentProxyConfig = obterProxyParaRegiao(region);
    currentSessionId = Math.random().toString(36).substring(2, 10);
    currentSessionUses = 0;
    console.log(`[PROXY] Rotacionando IP do proxy: ${oldSession} -> ${currentSessionId} (Motivo: ${motivo})`);
}

function obterProxyConfigESessionId(region) {
    if (!currentProxyConfig || currentSessionUses >= MAX_USES_PER_SESSION) {
        rotacionarSessionId(`Limite de ${MAX_USES_PER_SESSION} contas atingido`, region);
    }
    return { proxyConfig: currentProxyConfig, sessionId: currentSessionId };
}

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ============================================================
// CONFIGURAÇÕES GARENA & CRIPTOGRAFIA (Baseado no RAFIN)
// ============================================================
const CLIENT_SECRET = '2ee44819e9b4598845141067b281621874d0d5d7af9d8f7e00c1e54715b7d1e3';
const CLIENT_ID = '100067';

const AES_KEY = Buffer.from([89, 103, 38, 116, 99, 37, 68, 69, 117, 104, 54, 37, 90, 99, 94, 56]);
const AES_IV = Buffer.from([54, 111, 121, 90, 68, 114, 50, 50, 69, 51, 121, 99, 104, 106, 77, 37]);

const REGION_LANG = {
    "ME": "ar", "IND": "hi", "ID": "id", "VN": "vi", "TH": "th",
    "BD": "bn", "PK": "ur", "TW": "zh", "CIS": "ru", "SAC": "es", "BR": "pt"
};

const WRAPPING_PAIRS = [
    ['꧁', '꧂'], ['『', '』'], ['【', '】'], ['《', '》'], ['〈', '〉'],
    ['〔', '〕'], ['〖', '〗'], ['〘', '〙'], ['〚', '〛'], ['❬', '❭'],
    ['❮', '❯'], ['⦅', '⦆'], ['⟦', '⟧'], ['⟨', '⟩'], ['⫷', '⫸']
];

const SINGLE_SYMBOLS = [
    '☆', '★', '✧', '✦', '✩', '✪', '✫', '✬', '✭', '✮', '✯', '✰',
    '♡', '♥', '❤', '❥', '❦', '❧', 'ゝ', '々', '〆', '⁂', '※', '⁑',
    '†', '‡', '•', '‣', '❀', '❁', '❃', '❄', '❅', '❆', '❇', '❈', '❉', '❊', '❋',
    '→', '←', '↑', '↓', '↔', '↕', '➔', '➙', '➛', '➜', '➝', '➞', '➟', '➠', '➡',
    '〽', '〰', '〜', '～', '≈', '∞', '♪', '♫', '♬', '♩'
];

const part1Hex = '1a13323032352d30382d33302030353a31393a3231220966726565206669726528013a08312e3131342e31334232416e64726f6964204f532039202f204150492d3238202850492f72656c2e636a772e32303232303531382e313134313333294a0848616e6468656c64520a41544d204d6f62696c735a045749464960b60a68ee05720330307a1f41524d7637205646507633204e454f4e20564d48207c2032343030207c20328001c90f8a010f416472656e6f2028544d292036343092010d4f70656e474c20455320332e329a012b476f6f676c657c64666134616234622d396463342d343534652d383036352d653730633733336661353366a2010e3130352e3233352e3133392e3931aa0102';

const part2Hex = 'b20120316438656330323430656465313039393733663333323162393335346234346462610101346202010848616e6468656c64636101104173757320415355535f4930303544416561014061666366626631333333346265343230333665346637343263383062393536333434626564373630616339316233616666396236303761363130616234333930663001016361020a41544d204d6f62696c7364320204574946496361032037343238623235336465666331363430313863363034616562626665626466653003a88102653803f6e501663003af1366380384078004e7f0018804a881029004e7f0019804a88102c80401d2043d2f646174612f6170702f636f6d2e6474732e667265656669726574682d506465446e4f696c4353466e3337703141485f464c673d3d2f6c69622f61726d653004016561045f32303837663631633139663537663261663465376665666630623234643964397c2f646174612f6170702f636f6d2e6474732e667265656669726574682d506465446e4f696c4353466e3337703141485f464c673d3d2f626173652e61706b66300403663804018a050233323961050a32303139313138363932623205094f70656e474c20455332623805ff7fc00504653005f346665610507616e64726f6964663205704b71734854355a4c5772596c6a4e62355671682f2f7946526c615048534f394e5753517356764f6d646845456e37572b56484e554b2b512b666475413370744e724742304c6c304c527a335757306a4f7765734c6a3661695537735a343070426655452f46492f6a7a535477526532663805fbe4068806019006019a06013461020601346206224751404f000e5e00440655410e504d0d13685a0754060c6d5c5c560e6a59563b0b5535';

// Armazena processos em andamento
const processos = {};

// Helpers Criptográficos & Auxiliares
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function getAxiosConfig(proxyConfig, sessionId) {
    const config = {
        timeout: 15000,
        validateStatus: false
    };
    if (PROXY_ENABLED && proxyConfig) {
        console.log("[DEBUG] proxyConfig:", JSON.stringify(proxyConfig), "sessionId:", sessionId);
        let user = proxyConfig.user;
        if (user && user.includes('__cr.')) {
            user = `${user}__session.${sessionId}`;
        }
        const dynamicProxyUrl = `http://${user}:${proxyConfig.pass}@${proxyConfig.host}:${proxyConfig.port}`;
        config.httpAgent = new HttpProxyAgent(dynamicProxyUrl, { keepAlive: true, keepAliveMsecs: 30000 });
        config.httpsAgent = new HttpsProxyAgent(dynamicProxyUrl, { keepAlive: true, keepAliveMsecs: 30000 });
    } else {
        config.httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
    }
    return config;
}

function lerVarint(buf, pos) {
    let valor = 0, shift = 0;
    while (pos < buf.length) {
        const b = buf[pos]; pos++;
        valor += (b & 0x7F) * Math.pow(2, shift);
        if (!(b & 0x80)) break;
        shift += 7;
    }
    return [valor, pos];
}

function parseProtobufRaw(buf) {
    const fields = {};
    let pos = 0;
    while (pos < buf.length) {
        let tag;
        [tag, pos] = lerVarint(buf, pos);
        const fieldNum = tag >>> 3;
        const wireType = tag & 0x07;
        if (fieldNum === 0) break;
        if (wireType === 0) {
            let val;
            [val, pos] = lerVarint(buf, pos);
            if (!fields[fieldNum]) fields[fieldNum] = [];
            fields[fieldNum].push({ wireType, value: val });
        } else if (wireType === 2) {
            let len;
            [len, pos] = lerVarint(buf, pos);
            const data = buf.slice(pos, pos + len);
            pos += len;
            if (!fields[fieldNum]) fields[fieldNum] = [];
            fields[fieldNum].push({ wireType, data });
        } else if (wireType === 1) {
            const data = buf.slice(pos, pos + 8);
            pos += 8;
            if (!fields[fieldNum]) fields[fieldNum] = [];
            fields[fieldNum].push({ wireType, data });
        } else if (wireType === 5) {
            const data = buf.slice(pos, pos + 4);
            pos += 4;
            if (!fields[fieldNum]) fields[fieldNum] = [];
            fields[fieldNum].push({ wireType, data });
        } else if (wireType === 3 || wireType === 4) {
            // Grupos (deprecated do protobuf): apenas ignoramos o corpo e continuamos
            if (!fields[fieldNum]) fields[fieldNum] = [];
            fields[fieldNum].push({ wireType, value: wireType === 3 ? 'start_group' : 'end_group' });
        } else {
            console.warn(`[PROTO_RAW] WireType desconhecido: ${wireType} no campo ${fieldNum} na posicao ${pos}`);
            break;
        }
    }
    return fields;
}


function aesEncrypt(buffer) {
    const cipher = crypto.createCipheriv('aes-128-cbc', AES_KEY, AES_IV);
    return Buffer.concat([cipher.update(buffer), cipher.final()]);
}

function encryptApi(buffer) {
    return aesEncrypt(buffer).toString('hex');
}

function encPacket(hexString, key, iv) {
    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
    const buffer = Buffer.from(hexString, 'hex');
    return Buffer.concat([cipher.update(buffer), cipher.final()]).toString('hex');
}

function calcularAuthStartup(targetUid, token, timestamp, key, iv) {
    const uidHex = BigInt(targetUid).toString(16);
    const uidLength = uidHex.length;
    const encryptedTimestamp = BigInt(timestamp).toString(16);

    const tokenHex = Buffer.from(token, 'utf-8').toString('hex');
    const encryptedPacket = encPacket(tokenHex, key, iv);
    const encryptedPacketLength = (encryptedPacket.length / 2).toString(16);

    let headers = '0000000';
    if (uidLength === 9) headers = '0000000';
    else if (uidLength === 8) headers = '00000000';
    else if (uidLength === 10) headers = '000000';
    else if (uidLength === 7) headers = '000000000';

    return `0115${headers}${uidHex}${encryptedTimestamp}00000${encryptedPacketLength}${encryptedPacket}`;
}

async function conectarCanalTCP(label, ipPort, authHex) {
    if (!ipPort || !ipPort.includes(':')) {
        console.log(`❌ [TCP] Porta do ${label} inválida: ${ipPort}`);
        return false;
    }
    const [ip, port] = ipPort.split(':');

    if (label.includes('CHAT')) {
        console.log(`[TCP] 🔌 Conectando CHAT em ${ip}:${port}...`);
    }

    return new Promise((resolve) => {
        const client = new net.Socket();
        let connected = false;

        client.setTimeout(5000);

        client.connect(parseInt(port), ip, () => {
            connected = true;
            client.setTimeout(0); // Desativa o timeout de inatividade após conectar
            if (label.includes('CHAT')) {
                console.log(`[TCP] ✅ Chat conectado com sucesso!`);
            }
            client.write(Buffer.from(authHex, 'hex'));

            // Resolve após 1.5s para que o fluxo de geração prossiga, mas mantém o socket conectado
            setTimeout(() => {
                resolve(true);
            }, 1500);

            // Loop de heartbeat a cada 20 segundos para manter o bot online na Garena
            const heartbeatInterval = setInterval(() => {
                if (client.destroyed) {
                    clearInterval(heartbeatInterval);
                    return;
                }
                // Envia bytes 0205 de heartbeat
                client.write(Buffer.from("0205", "hex"), (err) => {
                    if (err) {
                        clearInterval(heartbeatInterval);
                        client.destroy();
                    }
                });
            }, 20000);

            client.on('close', () => {
                clearInterval(heartbeatInterval);
            });
        });

        client.on('error', (err) => {
            if (label.includes('CHAT')) {
                console.log(`❌ [TCP] Erro no ${label}: ${err.message}`);
            }
            client.destroy();
            resolve(false);
        });

        client.on('timeout', () => {
            if (label.includes('CHAT')) {
                console.log(`❌ [TCP] Timeout no ${label}`);
            }
            client.destroy();
            resolve(false);
        });

        client.on('close', () => {
            resolve(connected);
        });
    });
}

function encodeVarint(n) {
    if (n < 0) return Buffer.alloc(0);
    const result = [];
    while (true) {
        let byte = n & 0x7F;
        n >>>= 7;
        if (n) byte |= 0x80;
        result.push(byte);
        if (!n) break;
    }
    return Buffer.from(result);
}

function createProtoField(fieldNum, value) {
    if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
        const nested = buildProto(value);
        const header = (fieldNum << 3) | 2;
        return Buffer.concat([encodeVarint(header), encodeVarint(nested.length), nested]);
    } else if (typeof value === 'number') {
        const header = (fieldNum << 3) | 0;
        return Buffer.concat([encodeVarint(header), encodeVarint(value)]);
    } else if (typeof value === 'string') {
        const encodedVal = Buffer.from(value, 'utf-8');
        const header = (fieldNum << 3) | 2;
        return Buffer.concat([encodeVarint(header), encodeVarint(encodedVal.length), encodedVal]);
    } else if (Buffer.isBuffer(value)) {
        const header = (fieldNum << 3) | 2;
        return Buffer.concat([encodeVarint(header), encodeVarint(value.length), value]);
    }
    return Buffer.alloc(0);
}

function buildProto(fields) {
    const parts = [];
    for (const [k, v] of Object.entries(fields)) {
        parts.push(createProtoField(parseInt(k), v));
    }
    return Buffer.concat(parts);
}

function gerarExpoente() {
    const expDigits = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
    const num = Math.floor(Math.random() * 9999) + 1;
    const numStr = String(num).padStart(4, '0');
    return numStr.split('').map(d => expDigits[d]).join('');
}

function gerarNomeAleatorio(base) {
    if (!base) base = "Neon3";
    const shortBase = base.substring(0, 6);
    const randNum = Math.floor(1000 + Math.random() * 9000);
    const exponent = gerarExpoente();
    const rand = Math.random();

    if (rand < 0.5) {
        return `${shortBase}_${exponent}`;
    } else {
        return `${shortBase}_${randNum}`;
    }
}

function gerarSenhaCustomizada(prefixo) {
    return crypto.randomBytes(32).toString('hex').toUpperCase();
}

function gerarUserAgentAleatorio() {
    const modelos = ['A208SH', 'SM-A325M', 'ASUS_Z01QD', 'M2101K7AG', 'SM-G973F', 'POCO_X3', 'Redmi Note 8', 'Pixel 4'];
    const androids = ['9', '10', '11', '12', '13'];
    const m = modelos[Math.floor(Math.random() * modelos.length)];
    const a = androids[Math.floor(Math.random() * androids.length)];
    return `GarenaMSDK/4.0.42(${m} ;Android ${a};pt;PT;app 1.132.15 2019121229;)`;
}

// ========== NETWORK GARENA FLOW ==========
async function registerGarenaGuest(password, axiosConfig) {
    const url = "https://100067.connect.garena.com/api/v2/oauth/guest:register";
    const payload = { app_id: 100067, client_type: 2, password: password, source: 2 };
    const rawBody = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', CLIENT_SECRET).update(rawBody).digest('hex');

    const headers = {
        "User-Agent": gerarUserAgentAleatorio(),
        "Accept": "application/json",
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": `Signature ${signature}`,
        "Accept-Encoding": "gzip",
        "Connection": "Keep-Alive"
    };
    const config = { ...axiosConfig, headers: { ...axiosConfig.headers, ...headers } };

    const resp = await axios.post(url, rawBody, config);
    if (resp.status === 200 && resp.data?.data?.uid) {
        return resp.data.data.uid;
    }
    throw new Error(`Register failed: status=${resp.status}`);
}

async function getGarenaToken(uid, password, axiosConfig) {
    const url = "https://100067.connect.garena.com/api/v2/oauth/guest/token:grant";
    const payload = {
        client_id: 100067,
        client_secret: CLIENT_SECRET,
        client_type: 2,
        password: String(password),
        response_type: "token",
        uid: Number(uid)
    };
    const headers = {
        "User-Agent": gerarUserAgentAleatorio(),
        "Accept": "application/json",
        "Content-Type": "application/json; charset=utf-8",
        "Accept-Encoding": "gzip",
        "Connection": "Keep-Alive"
    };

    // Tentativa 1: Via Proxy configurada
    try {
        const config = { ...axiosConfig, headers: { ...axiosConfig.headers, ...headers }, timeout: 15000, validateStatus: false };
        const resp = await axios.post(url, payload, config);
        const data = resp.data?.data || resp.data;
        if (resp.status === 200 && data?.open_id && data?.access_token) {
            return { open_id: data.open_id, access_token: data.access_token };
        }
        if (resp.status === 429) {
            console.log(`[PROXY] Status 429 (Rate Limit) no proxy no token grant. Tentando conexão direta (sem proxy)...`);
        }
    } catch (e) {
        console.log(`[PROXY] Token grant falhou via proxy (${e.message}). Tentando conexão direta...`);
    }

    // Aguarda um pequeno delay de 1.5s se a proxy deu 429 antes da tentativa direta
    await sleep(1500);

    // Fallback: Conexão direta sem proxy
    try {
        const directConfig = {
            headers,
            timeout: 15000,
            validateStatus: false,
            httpsAgent: new https.Agent({ rejectUnauthorized: false, keepAlive: true })
        };
        const respDirect = await axios.post(url, payload, directConfig);
        const dataDirect = respDirect.data?.data || respDirect.data;
        if (respDirect.status === 200 && dataDirect?.open_id && dataDirect?.access_token) {
            return { open_id: dataDirect.open_id, access_token: dataDirect.access_token };
        }
        throw new Error(`Token grant failed: status=${respDirect.status}`);
    } catch (e) {
        throw new Error(`Token grant failed: ${e.message}`);
    }
}

const GGRE_PAYLOAD_REGISTER = Buffer.from("47475245010101007402000058339ad7714385794121d775c38f07250ad47c15cba278f7d67e85e838d686a6d35279098c777942d4a7bb751edd2eedf1cb5a687949ad65c72b5625a4f0480a72a212a144d3c9f2c774cd0a91c423d095efb9d0e0d99b9c3c9303effac533f12df3434b1126d5f83bd4b827189054c7ccd7c9eb621cdfaaa47e935ae774c402f2c331b4ee120d547d3cfe735a60c9f31c7299945a543f0bc7646ae8e3b5c8d1f11c6f28737a790d16b70d774b31afa72e178475aa23d9358671e6fdf26d3a1266d816c9daf67dbbe88b1a105284393aa3d6d09bb6cc58083a4f23a64056a16dc37edff19ac3091dda4c3a8919e7cf711b0adc5cfaad698e1473a49837cffccbe725b848a4ad3a5fc48d1efde751e4aebb74b0f6fdd1d80b3fcd2909110dcece07d882b0a98e420f54b3937367fe222f960c515d48ecc43fd51de43b93189f7c797351a7f2091bcef7253f04f71846ffe0d29951ed32f4f7e9bfe49fb661a636aa5ee70dd7ed292b9a94462d20053fccf20ddc5e6fb6488144a99638ad871bedd14d2af91433b759a5c0502005e3a4e50e18ef21c8135e98a879b89c0ae7be516504c1db4a50b553fccad3fccae94c2b97d4110de7e38e5230f3e9a3a6ff57d7bad5c129bba2bc7636977a1767bbe152e1a01fb12a2bc5dd7cc8a8d1cccf8bc985221ca6519b76f67ef154d20a590b66306c48b3c4996b2986629ddefdb6ed311c51612c5a609dd7c7b27e1db4ef535164e264665f70e9687d57fca12473b74cc479a73bcc47029b53170aedf40154c5cd0165a035fd5205301829ff604e936adb07e0320aa95ce99b749f74d1df20f1a88fddbc72ce29ddfd00eee61e74fcfe42c3a6a9a00b45f60fd566eac61495d4cb78bf63b73de238f406f20ee9091bd9da8eca765597e54dc18c16758073b1aa1b98a7ddad2079e5f9e48ad9", "hex");

async function majorRegister(accessToken, openId, field, region, name, isGhost, axiosConfig) {
    const isCommonRegion = ['ME', 'TH'].includes(region.toUpperCase());
    const domain = (isGhost || !isCommonRegion) ? "loginbp.ppmainecoonghj.com" : "loginbp.common.ggbluefox.com";
    const url = `https://${domain}/MajorRegister`;

    const langCode = (region.toUpperCase() === "BR" || isGhost) ? "pt-br" : (REGION_LANG[region.toUpperCase()] || "en");

    const payload = {
        1: name,
        2: accessToken,
        3: openId,
        5: 102000007,
        6: 4,
        7: 1,
        13: 1,
        14: field,
        15: langCode,
        16: 1,
        20: "1.132.15",
        21: 1,
        22: GGRE_PAYLOAD_REGISTER
    };

    const payloadBytes = buildProto(payload);
    const encryptedPayload = aesEncrypt(payloadBytes);

    const nowSec = Math.floor(Date.now() / 1000);
    const headers = {
        "Accept": "*/*",
        "Accept-Encoding": "deflate, gzip",
        "Authorization": "Bearer",
        "Connection": "Keep-Alive",
        "Content-Type": "application/x-www-form-urlencoded",
        "Expect": "100-continue",
        "Host": domain,
        "ReleaseVersion": "OB55",
        "User-Agent": "UnityPlayer/2018.4.12f1 (UnityWebRequest/1.0, libcurl/8.5.0-DEV)",
        "X-GA": "v1 1",
        "X-GA-SV": String(nowSec),
        "X-Unity-Version": "2018.4.12f1"
    };

    const config = { ...axiosConfig, headers: { ...axiosConfig.headers, ...headers }, responseType: 'arraybuffer', timeout: 15000 };

    try {
        const resp = await axios.post(url, encryptedPayload, config);
        const status = resp.status;
        const dataLen = resp.data ? resp.data.length : 0;

        if (status === 200 && resp.data && dataLen > 10) {
            const buf = Buffer.from(resp.data);
            const fields = parseProtobufRaw(buf);

            const jwtField = fields[8];
            const urlField = fields[10];
            const uidField = fields[3] || fields[1];
            const ktsField = fields[21];
            const akField = fields[22];
            const aivField = fields[23];

            const jwtToken = jwtField && jwtField[0]?.data ? jwtField[0].data.toString('utf-8') : null;

            const regionField = fields[4];
            const serverRegionCode = regionField && regionField[0]?.data ? regionField[0].data.toString('utf-8') : null;

            const REGION_CLIENT_URL_MAP = {
                'BR': 'https://client.br.ggbluefox.com',
                'US': 'https://client.us.freefiremobile.com',
                'SG': 'https://client.sg.freefiremobile.com',
                'TW': 'https://client.tw.freefiremobile.com',
                'TH': 'https://client.th.freefiremobile.com',
                'ID': 'https://client.ind.freefiremobile.com',
                'ME': 'https://client.mena.freefiremobile.com',
                'VN': 'https://client.vn.freefiremobile.com',
                'IN': 'https://client.ind.freefiremobile.com',
                'CIS': 'https://client.ru.freefiremobile.com',
                'EU': 'https://client.eu.freefiremobile.com',
            };

            let clientUrl = null;

            try {
                if (jwtToken) {
                    const parts = jwtToken.split('.');
                    if (parts.length >= 2) {
                        let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
                        while (base64.length % 4) base64 += '=';
                        const data = JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'));
                        if (data.server_url) {
                            clientUrl = data.server_url;
                            console.log(`[DEBUG] server_url from game JWT (register): ${clientUrl}`);
                        }
                    }
                }
            } catch (e) { /* ignore */ }

            if (!clientUrl && urlField && urlField[0]?.data) {
                clientUrl = urlField[0].data.toString('utf-8');
                console.log(`[DEBUG] server_url from proto field 10 (register): ${clientUrl}`);
            }

            const ACCESSIBLE_URL = 'https://client.us.freefiremobile.com';
            if (!clientUrl && serverRegionCode && REGION_CLIENT_URL_MAP[serverRegionCode]) {
                const regionUrl = REGION_CLIENT_URL_MAP[serverRegionCode];
                clientUrl = (serverRegionCode === 'US') ? regionUrl : ACCESSIBLE_URL;
                console.log(`[DEBUG] server_url resolved (${serverRegionCode}) (register): ${clientUrl}`);
            }

            if (!clientUrl) {
                clientUrl = ACCESSIBLE_URL;
                console.log(`[DEBUG] server_url fallback US (register): ${clientUrl}`);
            }

            const accountUid = uidField && uidField[0]?.value ? String(uidField[0].value) : "N/A";
            if (accountUid !== "N/A" && accountUid !== "0") {
                console.log(`[DEBUG] majorRegister personagem criado com sucesso! UID Jogo: ${accountUid}`);
                return true;
            }
            console.log(`[DEBUG] majorRegister resposta recebida sem UID de personagem (Nome rejeitado ou duplicado).`);
        } else {
            console.log(`[DEBUG] majorRegister status: ${status}, body length: ${dataLen}`);
            if (resp.data) {
                console.log(`[DEBUG] majorRegister body: ${Buffer.from(resp.data).toString('utf-8')}`);
            }
        }
    } catch (e) {
        console.error(`[DEBUG] majorRegister error: ${e.message}`);
    }
    return false;
}

function buildPythonLikeMajorLogin(openId, accessToken, lang = "en", region = "BR") {
    const agora = new Date();
    const local = new Date(agora.getTime() - 3 * 60 * 60 * 1000); // UTC-3
    const y = local.getUTCFullYear();
    const m = String(local.getUTCMonth() + 1).padStart(2, '0');
    const d = String(local.getUTCDate()).padStart(2, '0');
    const h = String(local.getUTCHours()).padStart(2, '0');
    const min = String(local.getUTCMinutes()).padStart(2, '0');
    const s = String(local.getUTCSeconds()).padStart(2, '0');
    const eventTime = `${y}-${m}-${d} ${h}:${min}:${s}`;

    const hash = crypto.createHash('md5').update(openId || 'default').digest('hex');
    const hash2 = crypto.createHash('sha256').update(openId || 'default').digest('hex');
    const googleUuid = `${hash.substring(0, 8)}-${hash.substring(8, 12)}-${hash.substring(12, 16)}-${hash.substring(16, 20)}-${hash.substring(20, 32)}`;
    const googleId = `Google|${googleUuid}`;
    const deviceHash = hash2.substring(0, 32);
    const modelos = ["AQUOS A208SH", "SM-A325M", "ASUS_Z01QD", "M2101K7AG", "SM-G973F", "POCO_X3"];
    const modeloIndex = parseInt(hash.substring(0, 2), 16) % modelos.length;
    const modelo = modelos[modeloIndex];

    let proto = Buffer.alloc(0);
    proto = Buffer.concat([proto, encodeString(3, eventTime)]);
    proto = Buffer.concat([proto, encodeString(4, "free fire")]);
    proto = Buffer.concat([proto, encodeInt(5, 1)]);
    proto = Buffer.concat([proto, encodeString(7, "1.132.15")]);
    proto = Buffer.concat([proto, encodeString(8, "Android OS 9 / API-28 (PI/rel.cjw.20220518.114133)")]);
    proto = Buffer.concat([proto, encodeString(9, "Handheld")]);
    proto = Buffer.concat([proto, encodeString(10, "Vivo ")]);
    proto = Buffer.concat([proto, encodeString(11, "WIFI")]);
    proto = Buffer.concat([proto, encodeInt(12, 1334)]);
    proto = Buffer.concat([proto, encodeInt(13, 833)]);
    proto = Buffer.concat([proto, encodeString(14, "300")]);
    proto = Buffer.concat([proto, encodeString(15, "x86-64 SSE3 SSE4.1 SSE4.2 AVX AVX2 | 2400 | 4")]);
    proto = Buffer.concat([proto, encodeInt(16, 5951)]);
    proto = Buffer.concat([proto, encodeString(17, "Adreno (TM) 640")]);
    proto = Buffer.concat([proto, encodeString(18, "OpenGL ES 3.2")]);
    proto = Buffer.concat([proto, encodeString(19, googleId)]);
    proto = Buffer.concat([proto, encodeString(20, "45.188.255.23")]);
    proto = Buffer.concat([proto, encodeString(21, lang)]);
    proto = Buffer.concat([proto, encodeString(22, openId)]);
    // Campos 23/99/100 = plataforma de login (4 = guest). "8" (Google) causa BR_PLATFORM_INVALID_PLATFORM em conta guest.
    proto = Buffer.concat([proto, encodeString(23, "4")]);
    proto = Buffer.concat([proto, encodeString(24, "Handheld")]);
    proto = Buffer.concat([proto, encodeString(25, modelo)]);
    proto = Buffer.concat([proto, encodeString(26, region)]);
    proto = Buffer.concat([proto, encodeString(29, accessToken)]);
    proto = Buffer.concat([proto, encodeInt(30, 1)]);
    proto = Buffer.concat([proto, encodeString(41, "Vivo ")]);
    proto = Buffer.concat([proto, encodeString(42, "WIFI")]);
    proto = Buffer.concat([proto, encodeString(57, deviceHash)]);
    proto = Buffer.concat([proto, encodeInt(60, 34335)]);
    proto = Buffer.concat([proto, encodeInt(61, 30667)]);
    proto = Buffer.concat([proto, encodeInt(62, 2479)]);
    proto = Buffer.concat([proto, encodeInt(63, 697)]);
    proto = Buffer.concat([proto, encodeInt(64, 32118)]);
    proto = Buffer.concat([proto, encodeInt(65, 34335)]);
    proto = Buffer.concat([proto, encodeInt(66, 32118)]);
    proto = Buffer.concat([proto, encodeInt(67, 34335)]);
    proto = Buffer.concat([proto, encodeInt(73, 1)]);
    proto = Buffer.concat([proto, encodeString(74, "/data/app/com.dts.freefireth-bn_eNop_JP3CpNToKwZgHg==/lib/arm")]);
    proto = Buffer.concat([proto, encodeInt(76, 1)]);
    proto = Buffer.concat([proto, encodeString(77, "b8e0cd5e295eee42f5860d3c86e483dd|/data/app/com.dts.freefireth-bn_eNop_JP3CpNToKwZgHg==/base.apk")]);
    proto = Buffer.concat([proto, encodeInt(78, 3)]);
    proto = Buffer.concat([proto, encodeInt(79, 1)]);
    proto = Buffer.concat([proto, encodeString(81, "32")]);
    proto = Buffer.concat([proto, encodeString(83, "2019121229")]);
    proto = Buffer.concat([proto, encodeString(86, "OpenGLES2")]);
    proto = Buffer.concat([proto, encodeInt(87, 4095)]);
    proto = Buffer.concat([proto, encodeInt(88, 4)]);
    proto = Buffer.concat([proto, encodeInt(92, 10714)]);
    proto = Buffer.concat([proto, encodeString(93, "android")]);
    proto = Buffer.concat([proto, encodeString(94, "KqsHT0byQgtagqduavxpr7mZurZ9Zlhg8RsreTB3FWkovV55waaBJxyzVB79/a2PfJuH17vhyhgxpj3PIxDr1bVUc5aNe3vUi2Et93Uu7fASlt6P")]);
    proto = Buffer.concat([proto, encodeInt(95, 111207)]);
    proto = Buffer.concat([proto, encodeString(96, "{\"cur_rate\":null,\"support_etc2\":false}")]);
    proto = Buffer.concat([proto, encodeInt(97, 1)]);
    proto = Buffer.concat([proto, encodeInt(98, 1)]);
    proto = Buffer.concat([proto, encodeString(99, "4")]);
    proto = Buffer.concat([proto, encodeString(100, "4")]);
    proto = Buffer.concat([proto, encodeString(102, Buffer.from("4b55414e570d0e01495059100d504d0d133b5a57085305605e580a3d040e3a0d5462", "hex"))]);
    proto = Buffer.concat([proto, encodeInt(104, 77129)]);
    proto = Buffer.concat([proto, encodeInt(105, 1)]);
    proto = Buffer.concat([proto, encodeString(106, "https://dl.ak.freefiremobile.com/live/ABHotUpdates/|https://core-ak.freefiremobile.com/live/ABHotUpdates/|dff941d41e6e3a9e76f05ed71fdc8d87")]);
    proto = Buffer.concat([proto, encodeString(107, "1.61362382768feeea")]);

    return proto;
}

function encodeString(fieldNum, value) {
    const header = (fieldNum << 3) | 2;
    const encodedVal = typeof value === 'string' ? Buffer.from(value, 'utf-8') : value;
    return Buffer.concat([encodeVarint(header), encodeVarint(encodedVal.length), encodedVal]);
}

function encodeInt(fieldNum, value) {
    const header = (fieldNum << 3) | 0;
    return Buffer.concat([encodeVarint(header), encodeVarint(value)]);
}

async function majorLogin(accessToken, openId, region, isGhost, axiosConfig) {
    const lang = isGhost ? "pt" : (REGION_LANG[region.toUpperCase()] || "en");

    let combinedBytes;
    try {
        combinedBytes = buildPythonLikeMajorLogin(openId, accessToken, lang, region);

    } catch (e) {
        console.error("[DEBUG] Erro ao usar buildPythonLikeMajorLogin:", e);
        return null;
    }

    const encryptedData = aesEncrypt(combinedBytes);

    const isCommonRegion = ['ME', 'TH'].includes(region.toUpperCase());
    const domain = (isGhost || !isCommonRegion) ? "loginbp.ppmainecoonghj.com" : "loginbp.common.ggbluefox.com";
    const url = `https://${domain}/MajorLogin`;

    const nowSec = Math.floor(Date.now() / 1000);
    const headers = {
        "Accept": "*/*",
        "Accept-Encoding": "deflate, gzip",
        "Authorization": "Bearer",
        "Connection": "Keep-Alive",
        "Content-Type": "application/x-www-form-urlencoded",
        "Expect": "100-continue",
        "Host": domain,
        "ReleaseVersion": "OB55",
        "User-Agent": "UnityPlayer/2018.4.12f1 (UnityWebRequest/1.0, libcurl/8.5.0-DEV)",
        "X-GA": "v1 1",
        "X-GA-SV": String(nowSec),
        "X-Unity-Version": "2018.4.12f1"
    };

    const config = { ...axiosConfig, headers: { ...axiosConfig.headers, ...headers }, responseType: 'arraybuffer', timeout: 15000 };

    try {
        const response = await axios.post(url, encryptedData, config);
        const status = response.status;
        const dataLen = response.data ? response.data.length : 0;

        if (status === 200 && response.data && dataLen > 10) {
            const buf = Buffer.from(response.data);
            const fields = parseProtobufRaw(buf);

            const jwtField = fields[8];
            const urlField = fields[10];
            const uidField = fields[1];
            const ktsField = fields[21];
            const akField = fields[22];
            const aivField = fields[23];

            let jwtToken = null;
            if (jwtField && jwtField[0]?.data) {
                const cand = jwtField[0].data.toString('utf-8');
                if (cand.startsWith('eyJ')) jwtToken = cand;
            }
            let accountUid = uidField && uidField[0]?.value ? String(uidField[0].value) : "N/A";
            let serverRegionCode = fields[4] && fields[4][0]?.data ? fields[4][0].data.toString('utf-8') : null;
            let clientUrl = null;

            // Extração resiliente via JWT caso o protobuf parser tenha desvio
            if (!jwtToken) {
                const strData = buf.toString('latin1');
                const jwtMatch = strData.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
                if (jwtMatch) {
                    jwtToken = jwtMatch[0];
                }
            }

            if (jwtToken) {
                try {
                    const parts = jwtToken.split('.');
                    if (parts.length >= 2) {
                        let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
                        while (base64.length % 4) base64 += '=';
                        const data = JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'));
                        if (data.account_id) accountUid = String(data.account_id);
                        if (data.noti_region || data.lock_region) serverRegionCode = data.noti_region || data.lock_region;
                        if (data.server_url) {
                            clientUrl = data.server_url;
                            console.log(`[DEBUG] server_url from game JWT: ${clientUrl}`);
                        }
                    }
                } catch (e) { /* ignore */ }
            }

            // Region → Client server URL map (for GetLoginData)
            const REGION_CLIENT_URL_MAP = {
                'BR': 'https://client.br.ggbluefox.com',
                'US': 'https://client.us.freefiremobile.com',
                'SG': 'https://client.sg.freefiremobile.com',
                'TW': 'https://client.tw.freefiremobile.com',
                'TH': 'https://client.th.freefiremobile.com',
                'ID': 'https://client.ind.freefiremobile.com',
                'ME': 'https://client.mena.freefiremobile.com',
                'VN': 'https://client.vn.freefiremobile.com',
                'IN': 'https://client.ind.freefiremobile.com',
                'CIS': 'https://client.ru.freefiremobile.com',
                'EU': 'https://client.eu.freefiremobile.com',
            };

            // 2. Try proto field 10 (url)
            if (!clientUrl && urlField && urlField[0]?.data) {
                clientUrl = urlField[0].data.toString('utf-8');
                console.log(`[DEBUG] server_url from proto field 10: ${clientUrl}`);
            }

            // 3. Use region map based on server's returned region code (field 4)
            const ACCESSIBLE_URL = 'https://client.us.freefiremobile.com';
            if (!clientUrl && serverRegionCode && REGION_CLIENT_URL_MAP[serverRegionCode]) {
                const regionUrl = REGION_CLIENT_URL_MAP[serverRegionCode];
                clientUrl = (serverRegionCode === 'US') ? regionUrl : ACCESSIBLE_URL;
                console.log(`[DEBUG] server_url resolved (${serverRegionCode}): ${clientUrl}`);
            }

            // 4. Final fallback
            if (!clientUrl) {
                clientUrl = ACCESSIBLE_URL;
                console.log(`[DEBUG] server_url fallback US: ${clientUrl}`);
            }

            const timestamp = ktsField && ktsField[0]?.value ? ktsField[0].value : null;
            const key = akField && akField[0]?.data ? akField[0].data : null;
            const iv = aivField && aivField[0]?.data ? aivField[0].data : null;

            return {
                account_uid: accountUid,
                jwt_token: jwtToken,
                url: clientUrl,
                timestamp,
                key,
                iv,
                encrypted_payload: encryptedData,
                response_len: dataLen
            };
        } else {
            console.log(`[DEBUG] majorLogin status: ${status}, body length: ${dataLen}`);
            if (response.data) {
                console.log(`[DEBUG] majorLogin body: ${Buffer.from(response.data).toString('utf-8')}`);
            }
        }
    } catch (e) {
        console.error(`[DEBUG] majorLogin error: ${e.message}`);
    }
    return null;
}

async function getLoginData(baseUrl, encryptedPayload, jwtToken, axiosConfig) {
    const url = `${baseUrl}/GetLoginData`;
    const nowSec = Math.floor(Date.now() / 1000);
    const headers = {
        "Accept": "*/*",
        "Accept-Encoding": "deflate, gzip",
        "Authorization": `Bearer ${jwtToken}`,
        "Connection": "Keep-Alive",
        "Content-Type": "application/x-www-form-urlencoded",
        "Expect": "100-continue",
        "ReleaseVersion": "OB55",
        "User-Agent": "UnityPlayer/2018.4.12f1 (UnityWebRequest/1.0, libcurl/8.5.0-DEV)",
        "X-GA": "v1 1",
        "X-GA-SV": String(nowSec),
        "X-Unity-Version": "2018.4.12f1"
    };

    const getLoginConfig = { ...axiosConfig, headers: { ...axiosConfig.headers, ...headers }, responseType: 'arraybuffer', timeout: 15000 };

    try {
        const resp = await axios.post(url, encryptedPayload, getLoginConfig);
        if (resp.status === 200 && resp.data && resp.data.length > 10) {
            const buf = Buffer.from(resp.data);
            const fields = parseProtobufRaw(buf);

            const nameField = fields[4];
            const onlineField = fields[14];
            const accountIpField = fields[32];

            const name = nameField && nameField[0]?.data ? nameField[0].data.toString('utf-8') : 'Unknown';
            const onlineIpPort = onlineField && onlineField[0]?.data ? onlineField[0].data.toString('utf-8') : 'N/A';
            const accountIpPort = accountIpField && accountIpField[0]?.data ? accountIpField[0].data.toString('utf-8') : 'N/A';

            return {
                name,
                online_ip_port: onlineIpPort,
                account_ip_port: accountIpPort
            };
        }
    } catch (e) {
        // Ignora erros normais de primeira tentativa
    }
    return null;
}

async function manterContaOnlineEmBackground(loginRes, region, isGhost, axiosConfig, name) {
    try {
        console.log(`[BACKGROUND-ONLINE] Iniciado para UID ${loginRes.account_uid}. Aguardando 40s para propagação de DB da Garena...`);
        await sleep(40000);

        let loginData = null;
        for (let attempt = 1; attempt <= 10; attempt++) {
            try {
                loginData = await getLoginData(loginRes.url, loginRes.encrypted_payload, loginRes.jwt_token, axiosConfig);
                if (loginData && loginData.account_ip_port !== 'N/A' && loginData.online_ip_port !== 'N/A') {
                    console.log(`[BACKGROUND-ONLINE] Sucesso no GetLoginData para UID ${loginRes.account_uid}!`);
                    break;
                }
            } catch (e) { /* ignore */ }
            await sleep(5000);
        }

        if (!loginData || loginData.account_ip_port === 'N/A') {
            console.error(`[BACKGROUND-ONLINE] Não foi possível obter dados de conexão válidos para o UID ${loginRes.account_uid} após 10 tentativas. Abortando TCP.`);
            return;
        }

        if (loginRes.timestamp && loginRes.key && loginRes.iv) {
            const startupHex = calcularAuthStartup(loginRes.account_uid, loginRes.jwt_token, loginRes.timestamp, loginRes.key, loginRes.iv);

            console.log(`[ONLINE] 🤖 Dev By: Neon Store | UID: ${loginRes.account_uid} | Nome: ${loginData.name || name} | Região: ${region} | Chat: ${loginData.account_ip_port} | Online: ${loginData.online_ip_port} | Status: 🟢 READY`);

            // Conecta e mantém online no background
            Promise.all([
                conectarCanalTCP(`${region} TCP CHAT`, loginData.account_ip_port, startupHex),
                conectarCanalTCP(`${region} TCP ONLINE`, loginData.online_ip_port, startupHex)
            ]).catch(err => {
                console.error(`[BACKGROUND-ONLINE] Erro ao manter sockets ativos para UID ${loginRes.account_uid}:`, err.message);
            });
        }
    } catch (err) {
        console.error(`[BACKGROUND-ONLINE] Erro geral para UID ${loginRes.account_uid}:`, err.message);
    }
}

async function forceRegionBind(region, jwtToken, axiosConfig) {
    try {
        const isCommonRegion = ['ME', 'TH'].includes(region.toUpperCase());
        const domain = isCommonRegion ? "loginbp.common.ggbluefox.com" : "loginbp.ppmainecoonghj.com";
        const url = `https://${domain}/ChooseRegion`;

        let regionCode = region.toUpperCase();
        if (regionCode === "CIS") regionCode = "RU";

        const protoData = buildProto({ 1: regionCode });
        const encryptedData = aesEncrypt(protoData);

        const nowSec = Math.floor(Date.now() / 1000);
        const headers = {
            'Accept': "*/*",
            'Accept-Encoding': "deflate, gzip",
            'Authorization': `Bearer ${jwtToken}`,
            'Connection': "Keep-Alive",
            'Content-Type': "application/x-www-form-urlencoded",
            'Expect': "100-continue",
            'Host': domain,
            'ReleaseVersion': "OB55",
            'User-Agent': "UnityPlayer/2018.4.12f1 (UnityWebRequest/1.0, libcurl/8.5.0-DEV)",
            'X-GA': "v1 1",
            'X-GA-SV': String(nowSec),
            'X-Unity-Version': "2018.4.12f1"
        };

        const config = { ...axiosConfig, headers: { ...axiosConfig.headers, ...headers }, responseType: 'arraybuffer' };

        await axios.post(url, encryptedData, config);
    } catch (e) {
        console.error(`[REGION_BIND] Falha: ${e.message}`);
    }
}

async function chooseEmote(baseUrl, jwtToken, axiosConfig) {
    try {
        const url = `${baseUrl}/ChooseEmote`;
        const headers = {
            "Accept-Encoding": "gzip",
            "Authorization": `Bearer ${jwtToken}`,
            "Connection": "Keep-Alive",
            "Content-Type": "application/x-www-form-urlencoded",
            "Expect": "100-continue",
            "ReleaseVersion": "OB55",
            "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 9; G011A Build/PI)",
            "X-GA": "v1 1",
            "X-Unity-Version": "2018.4.12f1",
        };
        const config = { ...axiosConfig, headers: { ...axiosConfig.headers, ...headers }, responseType: 'arraybuffer' };
        const data = Buffer.from("CAF683222A25C7BEFEB51F59544DB313", "hex");
        await axios.post(url, data, config);
    } catch (e) {
        console.error(`[CHOOSE_EMOTE] Falha: ${e.message}`);
    }
}

// Worker: gera e valida uma conta completa
async function gerarUmaContaValida(region, namePrefix, passwordPrefix, maxTentativas = 3) {
    const isGhost = (region.toUpperCase() === 'BR' || region.toUpperCase() === 'GHOST');
    for (let i = 0; i < maxTentativas; i++) {
        try {
            // Gerar um sessionId dinâmico exclusivo por tentativa de geração para evitar bans por IP compartilhado
            const sessionId = Math.random().toString(36).substring(2, 12);
            const proxyConfig = obterProxyParaRegiao(region);
            const axiosConfig = getAxiosConfig(proxyConfig, sessionId);
            const password = gerarSenhaCustomizada(passwordPrefix);

            // Passo 1: Registrar na Garena
            const uid = await registerGarenaGuest(password, axiosConfig);
            if (!uid) continue;

            await sleep(1500 + Math.random() * 1000);

            // Passo 2: Pegar Token
            const tokenRes = await getGarenaToken(uid, password, axiosConfig);
            if (!tokenRes) continue;
            const { open_id, access_token } = tokenRes;

            await sleep(800 + Math.random() * 700);

            // Passo 3: Registrar no jogo (MajorRegister)
            const name = gerarNomeAleatorio(namePrefix);
            const keystream = [0x30, 0x30, 0x30, 0x32, 0x30, 0x31, 0x37, 0x30, 0x30, 0x30, 0x30, 0x30, 0x32, 0x30, 0x31, 0x37, 0x30, 0x30, 0x30, 0x30, 0x30, 0x32, 0x30, 0x31, 0x37, 0x30, 0x30, 0x30, 0x30, 0x30, 0x32, 0x30];
            const openIdBuf = Buffer.from(open_id, 'utf-8');
            const field = Buffer.alloc(openIdBuf.length);
            for (let j = 0; j < openIdBuf.length; j++) {
                field[j] = openIdBuf[j] ^ keystream[j % keystream.length];
            }

            // Passo 3: Registrar no jogo (MajorRegister)
            const regSuccess = await majorRegister(access_token, open_id, field, region, name, isGhost, axiosConfig);
            if (!regSuccess) {
                console.log(`[GERADOR] MajorRegister falhou para UID ${uid}. Tentando próxima...`);
                continue;
            }

            // Aguarda 6 segundos para a Garena propagar a criação do personagem nos bancos de dados
            console.log("[DEBUG] Aguardando 6 segundos para propagacao do personagem...");
            await sleep(6000);

            // Passo 4: Login no jogo para obter credenciais e dados de socket (com retry se propagação atrasar)
            let loginRes = null;
            for (let loginAttempt = 1; loginAttempt <= 3; loginAttempt++) {
                loginRes = await majorLogin(access_token, open_id, region, isGhost, axiosConfig);
                if (loginRes && loginRes.account_uid !== "N/A") break;
                if (loginAttempt < 3) {
                    console.log(`[DEBUG] majorLogin falhou (tentativa ${loginAttempt}/3). Aguardando 4s adicionais para retry...`);
                    await sleep(4000);
                }
            }
            if (loginRes && loginRes.account_uid !== "N/A") {
                await sleep(800 + Math.random() * 700);

                // Passo 5: Vincular região se não for BR/GHOST
                if (!isGhost && region.toUpperCase() !== 'BR' && loginRes.jwt_token) {
                    await forceRegionBind(region, loginRes.jwt_token, axiosConfig);
                }

                // Logs simplificados e compactos de geração
                console.log(`[GERADOR] 👤 UID: ${uid} | Região: ${region} | Status: 🟢 CONTA ATIVADA COM SUCESSO`);
                console.log(`[LOGIN] 📡 MajorLogin (UID Jogo: ${loginRes.account_uid} | Nome: ${name})`);

                return {
                    uid: String(uid),
                    password: String(password),
                    name: name,
                    account_id: loginRes.account_uid,
                    region: isGhost ? "GHOST" : region
                };
            }
        } catch (e) {
            console.error(`[WORKER] Erro na geração: ${e.message}`);
            rotacionarSessionId(`Erro na geracao: ${e.message}`, region);
        }
        await sleep(1000 + Math.random() * 1000);
    }
    return null;
}

// Processa geração em background
async function processarGeracao(processId, quantidade, workers, region, namePrefix, passwordPrefix) {
    const processo = processos[processId];
    processo.status = 'GERANDO';
    processo.stats = {
        total: quantidade,
        geradas: 0,
        falhas: 0,
        success_rate: '0%',
        total_delivered: 0
    };

    const contasGeradas = [];
    const batchSize = Math.min(workers, 50); // max 50 workers simultâneos
    let pendentes = quantidade;

    while (pendentes > 0 && !processo.cancelado) {
        const batch = Math.min(batchSize, pendentes);
        const promessas = [];

        for (let i = 0; i < batch; i++) {
            promessas.push(gerarUmaContaValida(region, namePrefix, passwordPrefix, 3));
        }

        const resultados = await Promise.allSettled(promessas);

        for (const r of resultados) {
            if (r.status === 'fulfilled' && r.value) {
                contasGeradas.push(r.value);
                processo.stats.geradas++;
                processo.stats.total_delivered++;
                require('fs').appendFileSync('contas_geradas.txt', `${r.value.uid}:${r.value.password}\n`);
            } else {
                processo.stats.falhas++;
            }
        }

        pendentes -= batch;
        const total = processo.stats.geradas + processo.stats.falhas;
        processo.stats.success_rate = total > 0 ? `${Math.round((processo.stats.geradas / total) * 100)}%` : '0%';

        console.log(`[${processId.slice(0, 8)}] Progresso: ${processo.stats.geradas}/${quantidade} contas geradas`);

        if (pendentes > 0) await sleep(500);
    }

    processo.contas = contasGeradas;
    processo.status = contasGeradas.length > 0 ? 'CONCLUIDO' : 'ERRO';
    processo.stats.total_accounts = contasGeradas.length;
    processo.concluidoEm = Date.now();

    console.log(`[${processId.slice(0, 8)}] Finalizado: ${contasGeradas.length} contas válidas`);
}

// ============================================================
// ROTAS
// ============================================================

// POST /api/v1/gerar_contas?quantidade=X&region=BR&workers=50&namePrefix=ZeUS&passwordPrefix=FF
app.get('/api/v1/gerar_contas', async (req, res) => {
    const quantidade = Math.min(parseInt(req.query.quantidade) || 10, 1000);
    const workers = Math.min(parseInt(req.query.workers) || 10, 50);
    const region = req.query.region || 'BR';
    const namePrefix = req.query.namePrefix || req.query.sigla || req.query.name || 'Neon3tore';
    const passwordPrefix = req.query.passwordPrefix || 'FF';

    const processId = uuidv4();
    processos[processId] = {
        processId,
        status: 'INICIANDO',
        criadoEm: Date.now(),
        quantidade,
        workers,
        cancelado: false,
        contas: [],
        stats: {}
    };

    // Inicia em background
    processarGeracao(processId, quantidade, workers, region, namePrefix, passwordPrefix).catch(e => {
        if (processos[processId]) {
            processos[processId].status = 'ERRO';
            processos[processId].erro = e.message;
        }
    });

    console.log(`[GERADOR] Novo processo: ${processId.slice(0, 8)} | ${quantidade} contas | ${workers} workers | Região: ${region} | Sigla: ${namePrefix}`);

    res.json({ processId, status: 'INICIADO', quantidade, workers });
});

// GET /api/v2/status?processId=XXX
app.get('/api/v2/status', (req, res) => {
    const { processId } = req.query;
    if (!processId || !processos[processId]) {
        return res.status(404).json({ erro: 'Processo não encontrado' });
    }

    const p = processos[processId];
    res.json({
        processId,
        status: p.status,
        total_accounts: p.contas?.length || 0,
        stats: p.stats || {}
    });
});

// GET /api/v2/download-accounts
app.get('/api/v2/download-accounts', (req, res) => {
    const { processId } = req.query;

    // Se não mandar processId, baixa o arquivo contas_geradas.txt inteiro
    if (!processId) {
        const fs = require('fs');
        if (fs.existsSync('contas_geradas.txt')) {
            const txt = fs.readFileSync('contas_geradas.txt', 'utf-8');
            res.setHeader('Content-Type', 'text/plain');
            return res.send(txt);
        } else {
            return res.status(404).json({ erro: 'Nenhuma conta gerada ainda.' });
        }
    }

    if (!processos[processId]) {
        return res.status(404).json({ erro: 'Processo não encontrado' });
    }

    const p = processos[processId];
    if (p.status !== 'CONCLUIDO') {
        return res.status(400).json({ erro: 'Processo ainda não concluído', status: p.status });
    }

    // Retorna no formato uid:senha
    const txt = p.contas.map(c => `${c.uid}:${c.password}`).join('\n');
    res.setHeader('Content-Type', 'text/plain');
    res.send(txt);

    // Limpa processo depois de baixar
    setTimeout(() => { delete processos[processId]; }, 60000);
});

// GET /health
app.get('/health', (req, res) => {
    res.json({ status: 'ok', processos_ativos: Object.keys(processos).length });
});

// Limpar processos antigos a cada 30 min
setInterval(() => {
    const agora = Date.now();
    for (const id of Object.keys(processos)) {
        const p = processos[id];
        const idade = (agora - p.criadoEm) / 1000 / 60; // minutos
        if (idade > 30) {
            delete processos[id];
        }
    }
}, 30 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('  ╔══════════════════════════════════════════════════════════╗');
    console.log('  ║       Gerador de Contas FF - API v1.0.0                 ║');
    console.log('  ╚══════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`  [HTTP] Servidor rodando na porta ${PORT}`);
    console.log(`  [INFO] Endpoints:`);
    console.log(`    GET  /api/v1/gerar_contas?quantidade=X&workers=Y`);
    console.log(`    GET  /api/v2/status?processId=XXX`);
    console.log(`    GET  /api/v2/download-accounts?processId=XXX`);
    console.log(`    GET  /health`);
    console.log('');
});

module.exports = app;
