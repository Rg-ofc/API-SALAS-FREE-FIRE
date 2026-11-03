const crypto = require('crypto');

// =========================================================================
// MODO FÁCIL E BRUTO:
// Cole as informações exatamente como você as copia, sem precisar converter nada manual.
// Depois digite apenas "node descriptografar_wireshark.js" no terminal.
// =========================================================================

// 1. Cole aqui o JSON INTEIRO que você pegou no HTTP Toolkit:
const JSON_LOGIN_BRUTO = {
  "22": [
    9,
    168,
    51,
    17,
    91,
    251,
    97,
    255,
    64,
    4,
    1,
    56,
    2,
    18,
    16,
    48
  ],
  "23": [
    56,
    144,
    64,
    31,
    123,
    239,
    114,
    254,
    97,
    33,
    1,
    16,
    20,
    16,
    0,
    50
  ],
};

// 2. Cole aqui o pacote hex bruto obtido no Wireshark (iniciando com 0e05):
const PACOTE_WIRESHARK_BRUTO = "0e05000000e09b2b66920ebeb1de7a5fd04268bf52eac318f248c9d08db9d1b6e79cc1c6fb1330b0eb623faba440e7988f7bf042854ed057c664f8ce1ec3dc152ca11e7e78440f3517281679302e80ea1d46a9f3ecfdb183d1c1f0a30e0de1bd532c37b1cf764ce1ed8922506212849d939fd1e61123fc69b26d92a731a5de1af6db51edd7c1b281a30ae4d6740800e4446067f5ad768983a729425d6f3f1d6619018fb017b3329bb6def0b2d92355dcfbf1856e4f0d8a6cbc511de573ffa3bb752e42873fe00d5a68cdad93300196d03fa2ad3a8dec7f588e568d6e6e1890c7aee6807afd38";

// =========================================================================

function lerVarint(data, pos) {
    let valor = 0, shift = 0;
    while (pos < data.length) {
        const b = data[pos]; pos++;
        valor += (b & 0x7F) * Math.pow(2, shift);
        if (!(b & 0x80)) break;
        shift += 7;
    }
    return [valor, pos];
}

function descriptografarPacote(encryptedHex, chaveHex, ivHex) {
    const keyBuf = Buffer.from(chaveHex, 'hex');
    const ivBuf = Buffer.from(ivHex, 'hex');
    const encryptedBuf = Buffer.from(encryptedHex, 'hex');
    
    const decipher = crypto.createDecipheriv('aes-128-cbc', keyBuf, ivBuf);
    decipher.setAutoPadding(true);
    try {
        const decrypted = Buffer.concat([decipher.update(encryptedBuf), decipher.final()]);
        return decrypted;
    } catch (e) {
        console.error("Erro na descriptografia:", e.message);
        return null;
    }
}

function extrairParteConfig(pacote) {
    if (pacote[0] !== 0x08 || pacote[1] !== 0x02 || pacote[2] !== 0x12) {
        throw new Error("O pacote descriptografado não possui a assinatura de criação de sala (08 02 12)");
    }
    
    let pos = 3;
    let submsgLen;
    [submsgLen, pos] = lerVarint(pacote, pos);
    
    const submsg = pacote.slice(pos, pos + submsgLen);
    
    const sig = submsg.slice(0, 6).toString('hex');
    if (sig !== "0801100f1803") {
        throw new Error("Submsg não possui a assinatura esperada (0801100f1803)");
    }
    
    pos = 6;
    if (submsg[pos] !== 0x22) {
        throw new Error("Tag do Campo 4 (0x22) não encontrada na submsg");
    }
    pos++;
    let nameLen;
    [nameLen, pos] = lerVarint(submsg, pos);
    pos += nameLen;
    
    if (submsg[pos] === 0x2a) {
        pos++;
        let passLen;
        [passLen, pos] = lerVarint(submsg, pos);
        pos += passLen;
    }
    
    const parteConfig = submsg.slice(pos);
    return parteConfig.toString('hex');
}

// Processamento e conversão automática do JSON bruto
let chave = "";
let iv = "";

if (JSON_LOGIN_BRUTO) {
    let jsonObj = null;
    if (typeof JSON_LOGIN_BRUTO === 'string') {
        try {
            jsonObj = JSON.parse(JSON_LOGIN_BRUTO);
        } catch (e) {
            // Tenta extrair usando Regex se for uma string colada parcialmente
            const match22 = JSON_LOGIN_BRUTO.match(/["']?22["']?\s*:\s*\[([\s\d,]+)\]/);
            const match23 = JSON_LOGIN_BRUTO.match(/["']?23["']?\s*:\s*\[([\s\d,]+)\]/);
            if (match22 && match23) {
                jsonObj = {
                    "22": match22[1].split(',').map(Number),
                    "23": match23[1].split(',').map(Number)
                };
            }
        }
    } else if (typeof JSON_LOGIN_BRUTO === 'object') {
        jsonObj = JSON_LOGIN_BRUTO;
    }

    if (jsonObj) {
        const akArr = jsonObj["22"] || jsonObj[22];
        const aivArr = jsonObj["23"] || jsonObj[23];
        if (akArr && Array.isArray(akArr)) {
            chave = Buffer.from(akArr).toString('hex');
        }
        if (aivArr && Array.isArray(aivArr)) {
            iv = Buffer.from(aivArr).toString('hex');
        }
    }
}

// Prioriza argumentos do terminal. Se não houver, usa os configurados acima.
const args = process.argv.slice(2);
const finalChave = args[0] || chave;
const finalIv = args[1] || iv;
const hexParaDescriptografar = args[2] || PACOTE_WIRESHARK_BRUTO;

if (!finalChave || !finalIv || !hexParaDescriptografar) {
    console.log("\n[ERRO] Chave, IV ou pacote não informados.");
    console.log("\nModo de uso:");
    console.log("  1. Abra este arquivo (descriptografar_wireshark.js).");
    console.log("  2. Cole o JSON do login em 'JSON_LOGIN_BRUTO' e o pacote em 'PACOTE_WIRESHARK_BRUTO'.");
    console.log("  3. Salve e execute: node descriptografar_wireshark.js\n");
    process.exit(1);
}

if (!hexParaDescriptografar.toLowerCase().startsWith("0e05")) {
    console.error("Erro: O pacote deve iniciar com o cabeçalho '0e05'.");
    process.exit(1);
}
const payloadCriptografadoHex = hexParaDescriptografar.slice(12);

console.log(`Usando chave (ak): ${finalChave}`);
console.log(`Usando IV (aiv):   ${finalIv}`);
console.log("Tentando descriptografar...");

const pacoteDec = descriptografarPacote(payloadCriptografadoHex, finalChave, finalIv);

if (pacoteDec) {
    console.log("\n[OK] Descriptografado com sucesso!");
    try {
        const configHex = extrairParteConfig(pacoteDec);
        console.log("\n--- PARTE CONFIG HEX ENCONTRADA ---");
        console.log(configHex);
        console.log("-----------------------------------\n");
    } catch (err) {
        console.error("Erro ao analisar estrutura do pacote:", err.message);
        console.log("Conteúdo descriptografado em hex:", pacoteDec.toString('hex'));
    }
} else {
    console.error("\n[ERRO] Falha ao descriptografar. Verifique se a chave e o IV estão corretos e correspondem a esta sessão.");
}
