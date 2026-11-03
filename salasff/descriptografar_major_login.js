const crypto = require('crypto');

// =========================================================================
// DESCRIPTOGRAFADOR DE MAJOR LOGIN - FREE FIRE
// Cole aqui o payload (corpo da requisição / POST body) que você capturou
// no HTTP Toolkit ao acessar o endpoint: https://loginbp.ggblueshark.com/MajorLogin
// =========================================================================

// Cole o payload em formato HEX:
const PAYLOAD_MAJOR_LOGIN_HEX = "BD 78 3F 36 50 DE EF D7 16 21 F9 F7 58 98 32 9C 88 FD B7 76 42 88 77 13 46 FD F9 7B AD 6B FC 54 71 8C 8A 76 43 2F AD 8E 9F FC 4A 60 B4 31 87 8F F6 52 F4 FD 7D E6 E7 2B 04 6D 9D B9 B8 80 F6 25 1C CA 30 6F 77 16 26 CC 94 82 C5 2C 15 83 1A 2C 75 4A 49 9F 11 80 23 4F E1 5E 15 B1 AB 74 DB 15 9F 80 3F 13 32 B7 A9 11 FF 41 15 6D 38 03 2A 7F 4F C8 99 0A 5F 1A 36 AF EA AF 91 F9 E3 BC AE B5 CC 4F B5 AE 79 A2 97 52 4B 9F 39 D3 06 AE 88 CB 50 C0 51 1D 09 94 87 6B 35 52 ED 2E F3 62 D5 49 08 1B 34 4B 83 AF 76 2A 0E 6F 77 02 F9 3B 67 E9 50 63 A3 D0 1C 92 58 3E 0C 9F 2E 7F A5 25 3B CC 9B E8 31 83 9C 9F C0 F7 0E 78 8E 0D 1A BA 01 47 E9 F8 78 85 94 2B DE 47 DF 9C C9 5F 52 33 DF 35 0F A0 35 7E 10 43 D5 BE EC 2B E8 6B 08 66 CE C2 48 E9 3A 8D 62 11 D3 40 94 5B 6E D8 22 1F 78 F9 62 59 97 3A 33 02 89 99 9B AF B1 28 CA 92 B5 27 04 72 59 7A B9 BC B0 15 DB FD 39 57 C2 26 56 88 97 CA 9E CD 01 12 48 B9 B7 DC 5A 12 06 A1 DA A0 88 AC 98 C4 1E DB 39 1C C1 59 0C F0 0F 5C D2 01 78 46 C3 25 DC F9 4C 24 D8 E6 B7 66 43 E6 49 A6 DA CC 00 F7 D5 04 27 80 3D 52 89 97 9D 0C 88 40 42 5C 34 0F 78 7E 2E DE 38 9C 87 12 FC D0 6C 2A 0A 01 7B EF 73 11 AD 88 EE 25 EE F5 87 0F 49 C5 20 42 8C 93 76 62 B6 88 C3 A8 68 82 CA C1 9B E0 ED F2 7A 98 2C 3F 44 5D 05 4B FA A1 C5 89 B8 58 90 7B B8 B3 78 4B AA 95 6D F6 B7 F5 FE 6C 64 FD E3 FE DD 64 2D D9 DE 60 41 1E C9 7A F6 0E BB 46 71 BA 92 1F 80 A0 68 5D BD B2 9D 51 1B 62 E1 7F 89 6F 00 DA 27 C8 36 A8 EA DA 6A 2F E2 6C 38 61 69 E3 33 2B 9F 64 AC 68 4E 28 3F D2 E2 81 AF B9 17 40 4A DE DD 6C 7D A0 1B 43 4D 49 C9 36 E5 4F 77 8E 69 4A 6E 38 2F 1F A5 D0 57 66 87 4B 48 9D E1 6F 81 99 1F 1C AC 6B 1D E8 06 4D CE 35 0E 4B 9D 66 42 D9 6D EF A7 E2 F5 4E 5D 17 A0 69 AC B9 B9 7E 87 6A 08 19 9C 19 54 EB 7D A8 2C D5 0F A9 9C 44 A7 91 F5 0F 45 68 97 02 18 E3 08 07 8E 13 AE 99 06 93 C5 F5 92 9E 9E 11 79 F2 73 51 0C 73 4B 3B E1 B3 CC FA 1D C7 47 C6 13 1F 90 3A EF 67 7B 6D E3 2D E8 C1 86 89 1D 8B B3 06 4F F9 70 0C 22 53 EA 24 86 AC 71 4C BC 96 62 AC B6 0E DD 2F F2 E6 A1 0D 0A A3 4D 4B 36 FB 9A 90 E4 9B 03 32 EC 4C A5 0A 0D E6 3F 0F 86 65 12 E7 3E A2 AC B0 A1 AA 1E CB 7E 19 74 00 AC F3 60 A3 A9 BE 76 6C 79 4F EA 7A 4C CE 99 DB B6 8B 57 A2 A2 EB 91 B7 BA F8 8B D7 E0 52 96 10 A1 11 DD 18 02 C5 73 7B E0 8F 8D E6 A8 EA B7 E0 A4 DC B4 93 EB 3E 72 01 5E BC CC D8 9D 4C C9 B0 F8 71 5B 2B 62 2E 35 64 CA 0E 51 4D BB BE B3 7B 7D 43 3F FC CF DF 7B C8 BB 4C C1 78 5C F2 E1 42 57 1D 79 2E 87 7F 5D A2 A2 4C 18 DE 2F 0C 08 99 61 5C 53 1E 3D CA 13 75 C9 C8 A1 AE 59 F9 4B BA 97 79 78 CD E6 18 78 4D 2A F6 30 C3 2B C4 B9 A2 E0 58 25 DB 93 FA 42 C7 5F 59 88 8E 13 CB 1E A4 72 B5 03 09 1B 29 F6 35 48 2A 4B 65 B5 59 B0 81 94 D2 05 F7 AB BF 38 B3 BA 2F 03 A0 E2 D3 53 91 29 C7 B1 2F E5 93 4B CA 28 44 7D 06 BA B2 6B C2 58 02 2E 17 F4 A3 2D EF EA 96 CD B3 3A B8 EF 00 4E 24 DB A0 99 AF 0F 0B A5 29 CB 92 93 51 BB 60 42 1F CB 54 5D 10 D0 A7 8B 42 BD E2 96 7B 78 23 78 6A 87 45 F7 E7 03 99 07 2E 32 44 C2 92 18 AD AA 44 6B 68 F9 3E 0E 24 6F B4 6C 9F D9 C9 5A 83 73 FE 62 68 F0 B4 85 B6 3F 37 BE 53 12 93 5B 56 FD AC 26 FD 26 CC B4 69 C6 30 37 CF 82 2A 08 1C CE E1 4F 4A 6A BC A0 8F 3E 5C 01 27 B2 67 A5 8E DF 0B 65 55 0A D9 99 5E 18 37 90 FB B5 64 C8 F9 1F 3F 85 5B B1 67 10 27 3A C5 C4 FC 22 B4 0F 18 68 5F 7A 94 E7 73 5C 72 B2 E4 DB 5A BE 18 DF DE AF 88 B8 AC CB 37 95 0E B8 D5 CF E5 83 76 8A E8 48 6B E5 85 6D 7D 47 9D 2F FB 44 A9 F3 51 69 09 48 F7 00 92 34 39 B2 AA A7 56 C2 D7 9B E8 CC AB 42 F7 1A 07 4A E6 80 96"; 

// Chave e IV estáticos usados no MajorLogin
const KEY = Buffer.from([89, 103, 38, 116, 99, 37, 68, 69, 117, 104, 54, 37, 90, 99, 94, 56]);
const IV = Buffer.from([54, 111, 121, 90, 68, 114, 50, 50, 69, 51, 121, 99, 104, 106, 77, 37]);

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

function descriptografar(encryptedHex) {
    // Remove espaços em branco
    const hexLimpo = encryptedHex.replace(/\s+/g, '');
    const encryptedBuf = Buffer.from(hexLimpo, 'hex');
    const decipher = crypto.createDecipheriv('aes-128-cbc', KEY, IV);
    decipher.setAutoPadding(true);
    try {
        const decrypted = Buffer.concat([decipher.update(encryptedBuf), decipher.final()]);
        return decrypted;
    } catch (e) {
        console.error("Erro na descriptografia:", e.message);
        return null;
    }
}

function decodificarProtobuf(buffer) {
    let pos = 0;
    const campos = [];

    while (pos < buffer.length) {
        let tag;
        [tag, pos] = lerVarint(buffer, pos);
        const numCampo = tag >> 3;
        const tipoWire = tag & 0x07;

        if (tipoWire === 0) { // Varint
            let valor;
            [valor, pos] = lerVarint(buffer, pos);
            campos.push({ campo: numCampo, tipo: 'Inteiro (Varint)', valor });
        } else if (tipoWire === 2) { // Length-delimited
            let len;
            [len, pos] = lerVarint(buffer, pos);
            const valorBytes = buffer.slice(pos, pos + len);
            pos += len;
            
            let valorStr;
            let éString = true;
            
            // Verifica se contém apenas caracteres imprimíveis
            for (let i = 0; i < valorBytes.length; i++) {
                const char = valorBytes[i];
                if (char < 32 || char > 126) {
                    // Ignora quebras de linha/abas comuns
                    if (char !== 10 && char !== 13 && char !== 9) {
                        éString = false;
                        break;
                    }
                }
            }

            if (éString && valorBytes.length > 0) {
                valorStr = valorBytes.toString('utf-8');
            } else {
                valorStr = `[Hex] ${valorBytes.toString('hex')}`;
            }
            
            campos.push({ campo: numCampo, tipo: 'String/Bytes', valor: valorStr });
        } else if (tipoWire === 1) { // 64-bit
            const valorBytes = buffer.slice(pos, pos + 8);
            pos += 8;
            campos.push({ campo: numCampo, tipo: '64-bit', valor: valorBytes.toString('hex') });
        } else if (tipoWire === 5) { // 32-bit
            const valorBytes = buffer.slice(pos, pos + 4);
            pos += 4;
            campos.push({ campo: numCampo, tipo: '32-bit', valor: valorBytes.toString('hex') });
        } else {
            console.error(`Tipo wire desconhecido: ${tipoWire} na posição ${pos}`);
            break;
        }
    }
    return campos;
}

if (!PAYLOAD_MAJOR_LOGIN_HEX) {
    console.log("\n[ERRO] Cole o payload hex do MajorLogin na variável 'PAYLOAD_MAJOR_LOGIN_HEX'.");
    console.log("Para usar: node descriptografar_major_login.js\n");
    process.exit(1);
}

console.log("Tentando descriptografar o MajorLogin...");
const dec = descriptografar(PAYLOAD_MAJOR_LOGIN_HEX);

if (dec) {
    console.log("[OK] Descriptografado com sucesso!\n");
    console.log("--- CAMPOS DO PROTOCOLO ENCONTRADOS ---");
    const campos = decodificarProtobuf(dec);
    
    const configObj = {};
    
    // Agrupa e exibe de forma formatada para colar no pacotes.js
    campos.forEach(c => {
        let codeSnippet = "";
        let valorParaSalvar = c.valor;
        
        if (c.tipo === 'String/Bytes') {
            const limpo = c.valor.startsWith('[Hex]') ? c.valor : `"${c.valor.replace(/"/g, '\\"')}"`;
            codeSnippet = `proto = Buffer.concat([proto, encodeString(${c.campo}, ${limpo})]);`;
            if (c.valor.startsWith('[Hex]')) {
                valorParaSalvar = c.valor.replace('[Hex] ', '');
            }
        } else {
            codeSnippet = `proto = Buffer.concat([proto, encodeInt(${c.campo}, ${c.valor})]);`;
        }
        
        // Não salva campos dinâmicos que mudam a cada requisição ou dependem de parâmetros da função
        if (c.campo !== 3 && c.campo !== 20 && c.campo !== 22 && c.campo !== 29) {
            configObj[c.campo] = valorParaSalvar;
        }
        
        console.log(`Campo ${c.campo.toString().padEnd(3)} | ${c.tipo.padEnd(16)} | Valor: ${c.valor}`);
        console.log(`   Código para pacotes.js -> ${codeSnippet}\n`);
    });
    console.log("---------------------------------------");
    
    // Grava as informações no arquivo JSON de configurações
    const path = require('path');
    const fs = require('fs');
    const outputPath = path.join(__dirname, 'major_login_config.json');
    try {
        fs.writeFileSync(outputPath, JSON.stringify(configObj, null, 2), 'utf8');
        console.log(`[SUCESSO] Configurações salvas e atualizadas em: ${outputPath}\n`);
    } catch (e) {
        console.error(`[ERRO] Falha ao salvar arquivo JSON: ${e.message}\n`);
    }
} else {
    console.error("Falha ao descriptografar. Verifique se o hex copiado está correto e completo.");
}
