const crypto = require('crypto');
const { criptografarPacote, decParaHex, garantirBytes, codificarVarint, Logger } = require('./utils');

function encodeVarint(value) {
    value = Number(value);
    let bits = value & 0x7f;
    value = Math.floor(value / 128);
    let result = Buffer.alloc(0);
    while (value) {
        result = Buffer.concat([result, Buffer.from([0x80 | bits])]);
        bits = value & 0x7f;
        value = Math.floor(value / 128);
    }
    result = Buffer.concat([result, Buffer.from([bits])]);
    return result;
}

function encodeString(fieldNum, value) {
    const tag = (fieldNum << 3) | 2;
    const encodedValue = typeof value === 'string' ? Buffer.from(value, 'utf-8') : value;
    return Buffer.concat([encodeVarint(tag), encodeVarint(encodedValue.length), encodedValue]);
}

function encodeInt(fieldNum, value) {
    const tag = (fieldNum << 3) | 0;
    return Buffer.concat([encodeVarint(tag), encodeVarint(value)]);
}

function criarPacoteMajorLogin(openId, accessToken, clientIp = "45.188.255.23", region = "BR", isGetLoginData = false) {
    const agora = new Date();
    const offset = -3 * 60;
    const local = new Date(agora.getTime() + offset * 60 * 1000);
    const y = local.getUTCFullYear();
    const m = String(local.getUTCMonth() + 1).padStart(2, '0');
    const d = String(local.getUTCDate()).padStart(2, '0');
    const h = String(local.getUTCHours()).padStart(2, '0');
    const min = String(local.getUTCMinutes()).padStart(2, '0');
    const s = String(local.getUTCSeconds()).padStart(2, '0');
    const agoraStr = `${y}-${m}-${d} ${h}:${min}:${s}`;

    let proto = Buffer.alloc(0);
    proto = Buffer.concat([proto, encodeString(3, agoraStr)]);
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
    proto = Buffer.concat([proto, encodeString(19, "Google|5766a26a-df0a-4b42-8bb5-1083cdb5eabc")]);
    proto = Buffer.concat([proto, encodeString(20, clientIp)]);
    proto = Buffer.concat([proto, encodeString(21, "pt-br")]);
    proto = Buffer.concat([proto, encodeString(22, openId)]);
    // Campos 23/99/100 = plataforma de login. Contas guest usam "4".
    proto = Buffer.concat([proto, encodeString(23, "4")]);
    proto = Buffer.concat([proto, encodeString(24, "Handheld")]);
    proto = Buffer.concat([proto, encodeString(25, "Asus ASUS_AI2401_B")]);
    proto = Buffer.concat([proto, encodeString(26, region)]);
    proto = Buffer.concat([proto, encodeString(29, accessToken)]);
    proto = Buffer.concat([proto, encodeInt(30, 1)]);
    proto = Buffer.concat([proto, encodeString(41, "Vivo ")]);
    proto = Buffer.concat([proto, encodeString(42, "WIFI")]);
    proto = Buffer.concat([proto, encodeString(57, "7428b253defc164018c604a1ebbfebdf")]);
    proto = Buffer.concat([proto, encodeInt(60, 34335)]);
    proto = Buffer.concat([proto, encodeInt(61, 30664)]);
    proto = Buffer.concat([proto, encodeInt(62, 2479)]);
    proto = Buffer.concat([proto, encodeInt(63, 697)]);
    proto = Buffer.concat([proto, encodeInt(64, 32115)]);
    proto = Buffer.concat([proto, encodeInt(65, 34335)]);
    proto = Buffer.concat([proto, encodeInt(66, 32115)]);
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
    if (isGetLoginData) {
        proto = Buffer.concat([proto, encodeString(90, Buffer.from("53c3a36f205061756c6f", "hex"))]); // "São Paulo"
        proto = Buffer.concat([proto, encodeString(91, "SP")]);
    }
    proto = Buffer.concat([proto, encodeInt(92, 10636)]);
    proto = Buffer.concat([proto, encodeString(93, "android")]);
    proto = Buffer.concat([proto, encodeString(94, "KqsHT4UfyT88LBF4h6jNlKqLRuPNZFcF7iTSAKqrRccvwu3ePaNssbTjMr2G5uoUjZL4vN+2avB0oaXuMsVmflUt/61iB5imujb3FKt1xj3/wsuq")]);
    proto = Buffer.concat([proto, encodeInt(95, 111207)]);
    proto = Buffer.concat([proto, encodeString(96, "{\"cur_rate\":null,\"support_etc2\":false}")]);
    proto = Buffer.concat([proto, encodeInt(97, 1)]);
    proto = Buffer.concat([proto, encodeInt(98, 1)]);
    proto = Buffer.concat([proto, encodeString(99, isGetLoginData ? "0" : "4")]);
    proto = Buffer.concat([proto, encodeString(100, "4")]);
    proto = Buffer.concat([proto, encodeString(102, Buffer.from("4b55414e570d0e01495059100d504d0d133b5a57085305605e580a3d040e3a0d5462", "hex"))]);
    if (isGetLoginData) {
        proto = Buffer.concat([proto, encodeInt(103, 1)]);
    }
    proto = Buffer.concat([proto, encodeInt(104, 68116)]);
    proto = Buffer.concat([proto, encodeInt(105, 1)]);
    proto = Buffer.concat([proto, encodeString(106, "https://dl.aw.freefiremobile.com/live/ABHotUpdates/|https://core-aw.freefiremobile.com/live/ABHotUpdates/|dff941d41e6e3a9e76f05ed71fdc8d87")]);
    proto = Buffer.concat([proto, encodeString(107, "1.7d5b46e36677892a")]);
    return proto;
}

function criarPacoteProtobuf(campos) {
    let resultadoHex = "";
    const sortedKeys = Object.keys(campos).map(Number).sort((a, b) => a - b);
    for (const numCampo of sortedKeys) {
        const valor = campos[numCampo];
        if (Array.isArray(valor)) {
            for (const item of valor) {
                if (typeof item === 'object' && item !== null && !Buffer.isBuffer(item)) {
                    const bytesAninhados = criarPacoteProtobuf(item);
                    const hexAninhados = bytesAninhados.toString('hex');
                    const hexComprimento = codificarVarint(bytesAninhados.length);
                    const tag = (numCampo << 3) | 2;
                    const hexTag = codificarVarint(tag);
                    resultadoHex += hexTag + hexComprimento + hexAninhados;
                } else {
                    const tag = (numCampo << 3) | 0;
                    const hexTag = codificarVarint(tag);
                    const hexVal = codificarVarint(item);
                    resultadoHex += hexTag + hexVal;
                }
            }
        } else if (typeof valor === 'object' && valor !== null && !Buffer.isBuffer(valor) && typeof valor !== 'boolean') {
            const bytesAninhados = criarPacoteProtobuf(valor);
            const hexAninhados = bytesAninhados.toString('hex');
            const hexComprimento = codificarVarint(bytesAninhados.length);
            const tag = (numCampo << 3) | 2;
            const hexTag = codificarVarint(tag);
            resultadoHex += hexTag + hexComprimento + hexAninhados;
        } else if (typeof valor === 'string') {
            const codificado = Buffer.from(valor, 'utf-8');
            const hexComprimento = codificarVarint(codificado.length);
            const tag = (numCampo << 3) | 2;
            const hexTag = codificarVarint(tag);
            resultadoHex += hexTag + hexComprimento + codificado.toString('hex');
        } else if (Buffer.isBuffer(valor)) {
            const hexComprimento = codificarVarint(valor.length);
            const tag = (numCampo << 3) | 2;
            const hexTag = codificarVarint(tag);
            resultadoHex += hexTag + hexComprimento + valor.toString('hex');
        } else if (typeof valor === 'boolean') {
            const tag = (numCampo << 3) | 0;
            const hexTag = codificarVarint(tag);
            const hexVal = codificarVarint(valor ? 1 : 0);
            resultadoHex += hexTag + hexVal;
        } else if (valor === null || valor === undefined) {
            const tag = (numCampo << 3) | 2;
            const hexTag = codificarVarint(tag);
            resultadoHex += hexTag + "00";
        } else if (typeof valor === 'number') {
            const hexValor = codificarVarint(valor);
            const tag = (numCampo << 3) | 0;
            const hexTag = codificarVarint(tag);
            resultadoHex += hexTag + hexValor;
        }
    }
    return Buffer.from(resultadoHex, 'hex');
}

function processarResultados(resultadosParseados) {
    const dictResultado = {};
    for (const resultado of resultadosParseados) {
        const dadosCampo = {};
        dadosCampo.wire_type = resultado.wire_type;
        if (resultado.wire_type === "varint") {
            dadosCampo.data = resultado.data;
        }
        if (resultado.wire_type === "string") {
            dadosCampo.data = resultado.data;
        }
        if (resultado.wire_type === "bytes") {
            dadosCampo.data = resultado.data;
        } else if (resultado.wire_type === "length_delimited") {
            dadosCampo.data = processarResultados(resultado.data.results);
        }
        dictResultado[resultado.field] = dadosCampo;
    }
    return dictResultado;
}

function processarResultadosComRepeated(resultadosParseados) {
    const dictResultado = {};
    for (const resultado of resultadosParseados) {
        const dadosCampo = {};
        dadosCampo.wire_type = resultado.wire_type;
        if (resultado.wire_type === "varint") {
            dadosCampo.data = resultado.data;
        }
        if (resultado.wire_type === "string") {
            dadosCampo.data = resultado.data;
        }
        if (resultado.wire_type === "bytes") {
            dadosCampo.data = resultado.data;
        } else if (resultado.wire_type === "length_delimited") {
            dadosCampo.data = processarResultadosComRepeated(resultado.data.results);
        }
        const key = resultado.field;
        if (key in dictResultado) {
            if (!Array.isArray(dictResultado[key])) {
                dictResultado[key] = [dictResultado[key]];
            }
            dictResultado[key].push(dadosCampo);
        } else {
            dictResultado[key] = dadosCampo;
        }
    }
    return dictResultado;
}

function obterSalaDisponivelComRepeated(textoEntrada) {
    try {
        const buf = Buffer.from(textoEntrada, 'hex');
        const resultadosParseados = _parseProtobufFields(buf);
        const dictResultados = processarResultadosComRepeated(resultadosParseados);
        return JSON.stringify(dictResultados);
    } catch (e) {
        return null;
    }
}

function _parseVarintFromBuf(buf, offset) {
    let result = 0;
    let shift = 0;
    let pos = offset;
    while (pos < buf.length) {
        const b = buf[pos];
        result += (b & 0x7f) * Math.pow(2, shift);
        shift += 7;
        pos++;
        if ((b & 0x80) === 0) break;
    }
    return [result, pos];
}

function _parseProtobufFields(buf) {
    const results = [];
    let offset = 0;
    while (offset < buf.length) {
        let tag, newOffset;
        try {
            [tag, newOffset] = _parseVarintFromBuf(buf, offset);
        } catch (e) { break; }
        if (newOffset === offset) break;
        offset = newOffset;
        const fieldNumber = Math.floor(tag / 8);
        const wireType = tag & 0x07;
        if (fieldNumber === 0) break;
        if (wireType === 0) {
            // Varint
            let value;
            [value, offset] = _parseVarintFromBuf(buf, offset);
            results.push({ field: fieldNumber, wire_type: "varint", data: value });
        } else if (wireType === 2) {
            // Length-delimited
            let length;
            [length, offset] = _parseVarintFromBuf(buf, offset);
            if (offset + length > buf.length) break;
            const payload = buf.slice(offset, offset + length);
            offset += length;
            let isMaybeNested = false;
            try {
                const decoded = payload.toString('utf-8');
                const checkLen = Math.min(decoded.length, 4);
                for (let i = 0; i < checkLen; i++) {
                    if (decoded.charCodeAt(i) < 0x20) {
                        isMaybeNested = true;
                        break;
                    }
                }
                if (!isMaybeNested && decoded.includes('\uFFFD')) {
                    isMaybeNested = true;
                }
            } catch (e) {
                isMaybeNested = true;
            }
            if (isMaybeNested) {
                let subResults = null;
                try {
                    const sub = _parseProtobufFields(payload);
                    if (sub.length > 0) {
                        let valid = true;
                        for (const s of sub) {
                            if (s.field > 500 || s.field < 1) { valid = false; break; }
                        }
                        if (valid) subResults = sub;
                    }
                } catch (e) { /* nao e sub-mensagem */ }
                if (subResults) {
                    results.push({ field: fieldNumber, wire_type: "length_delimited", data: { results: subResults } });
                } else {
                    results.push({ field: fieldNumber, wire_type: "bytes", data: payload.toString('hex') });
                }
            } else {

                if (payload.length > 0) {
                    results.push({ field: fieldNumber, wire_type: "string", data: payload.toString('utf-8') });
                } else {
                    results.push({ field: fieldNumber, wire_type: "string", data: "" });
                }
            }
        } else if (wireType === 1) {

            if (offset + 8 > buf.length) break;
            const val = buf.readDoubleLE(offset);
            offset += 8;
            results.push({ field: fieldNumber, wire_type: "64bit", data: val });
        } else if (wireType === 5) {
            if (offset + 4 > buf.length) break;
            const val = buf.readFloatLE(offset);
            offset += 4;
            results.push({ field: fieldNumber, wire_type: "32bit", data: val });
        } else {
            break;
        }
    }
    return results;
}

function obterSalaDisponivel(textoEntrada) {
    try {
        const buf = Buffer.from(textoEntrada, 'hex');
        const resultadosParseados = _parseProtobufFields(buf);
        const dictResultados = processarResultados(resultadosParseados);
        return JSON.stringify(dictResultados);
    } catch (e) {
        return null;
    }
}

function _montarPacoteFinal(prefixo, pacoteHex, chave, iv) {
    const encrypted = criptografarPacote(pacoteHex, chave, iv);
    const comprimento = encrypted.length / 2;
    const comprimentoHex = decParaHex(comprimento);
    let pacoteFinal;
    if (comprimentoHex.length === 2) {
        pacoteFinal = prefixo + "000000" + comprimentoHex + encrypted;
    } else if (comprimentoHex.length === 3) {
        pacoteFinal = prefixo + "00000" + comprimentoHex + encrypted;
    } else if (comprimentoHex.length === 4) {
        pacoteFinal = prefixo + "0000" + comprimentoHex + encrypted;
    } else if (comprimentoHex.length === 5) {
        pacoteFinal = prefixo + "000" + comprimentoHex + encrypted;
    } else {
        pacoteFinal = prefixo + "00" + comprimentoHex + encrypted;
    }
    return Buffer.from(pacoteFinal, 'hex');
}

function criarPacoteEntrarSalaSpec(roomId, senha, chave, iv) {
    const camposSala = {
        1: parseInt(roomId),
        6: [{ 1: "IDC1", 2: 22, 3: "BR" }, { 1: "IDC2", 2: 58, 3: "BR" }],
        7: Buffer.from("01030407090a0b120e16191a201d", "hex"),
        8: 1,
        9: "pt-br",
        11: [
            { 1: 3, 2: 391 },
            { 1: 4, 2: 350 },
            { 1: 5, 2: 192 },
            { 1: 29, 2: 204 },
            { 1: 22, 2: 115 },
            { 1: 14, 2: 175 },
            { 1: 21 }
        ]
    };
    if (senha) {
        camposSala[2] = String(senha);
    }
    const campos = { 1: 4, 2: camposSala };
    const pacote = criarPacoteProtobuf(campos);
    const pacoteHex = pacote.toString('hex');
    return _montarPacoteFinal("0E14", pacoteHex, chave, iv);
}

function criarPacoteSairSala(roomId, chave, iv) {
    const campos = { 1: 6, 2: { 1: parseInt(roomId) } };
    const pacote = criarPacoteProtobuf(campos);
    const pacoteHex = pacote.toString('hex');
    return _montarPacoteFinal("0E05", pacoteHex, chave, iv);
}

function criarPacoteComecarSala(idSala, chave, iv) {
    const campos = { 1: 39, 2: { 1: parseInt(idSala), 2: 3 } };
    const pacote = criarPacoteProtobuf(campos);
    const pacoteHex = pacote.toString('hex');
    return _montarPacoteFinal("0E05", pacoteHex, chave, iv);
}

function criarPacoteConfirmarInicio(idSala, chave, iv) {
    const campos = { 1: 11, 2: { 1: parseInt(idSala) } };
    const pacote = criarPacoteProtobuf(campos);
    const pacoteHex = pacote.toString('hex');
    return _montarPacoteFinal("0E05", pacoteHex, chave, iv);
}

function criarPacoteSairPartida(chave, iv) {
    const pacote = Buffer.from([0x08, 0x0f]);
    const pacoteHex = pacote.toString('hex');
    return _montarPacoteFinal("0E05", pacoteHex, chave, iv);
}

function _encodeVarintLocal(value) {
    value = Number(value);
    const result = [];
    while (value > 127) {
        result.push((value & 0x7F) | 0x80);
        value = Math.floor(value / 128);
    }
    result.push(value & 0x7F);
    return Buffer.from(result);
}

function criarPacoteVirarEspectador(idSala, accountId, chave, iv) {
    let submsg = Buffer.alloc(0);
    submsg = Buffer.concat([submsg, Buffer.from([0x08]), _encodeVarintLocal(parseInt(idSala))]);    // field 1: room_id
    submsg = Buffer.concat([submsg, Buffer.from([0x10]), _encodeVarintLocal(parseInt(accountId))]); // field 2: account_id
    submsg = Buffer.concat([submsg, Buffer.from([0x18, 0x02])]);                                    // field 3: to_role = SPECTATOR (2)
    submsg = Buffer.concat([submsg, Buffer.from([0x30, 0x01])]);                                    // field 6: room_type = 1
    const pacote = Buffer.concat([Buffer.from([0x08, 0x14, 0x12, submsg.length]), submsg]);
    const pacoteHex = pacote.toString('hex');
    return _montarPacoteFinal("0E05", pacoteHex, chave, iv);
}

function criarPacoteExpulsarPlayer(accountId, roomId, chave, iv) {
    let submsg = Buffer.alloc(0);
    submsg = Buffer.concat([submsg, Buffer.from([0x08]), _encodeVarintLocal(parseInt(accountId))]);
    submsg = Buffer.concat([submsg, Buffer.from([0x10]), _encodeVarintLocal(parseInt(roomId))]);
    const pacote = Buffer.concat([Buffer.from([0x08, 0x09, 0x12, submsg.length]), submsg]);
    const pacoteHex = pacote.toString('hex');
    return _montarPacoteFinal("0E05", pacoteHex, chave, iv);
}

module.exports = {
    encodeVarint,
    encodeString,
    encodeInt,
    criarPacoteMajorLogin,
    criarPacoteProtobuf,
    processarResultados,
    obterSalaDisponivel,
    obterSalaDisponivelComRepeated,
    processarResultadosComRepeated,
    criarPacoteEntrarSalaSpec,
    criarPacoteSairSala,
    criarPacoteComecarSala,
    criarPacoteConfirmarInicio,
    criarPacoteSairPartida,
    criarPacoteVirarEspectador,
    criarPacoteExpulsarPlayer,
};
