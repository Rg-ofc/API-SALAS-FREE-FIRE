/**
 * desbugar_contas.js
 * Script para desbugar e tirar todas as contas de partidas / salas fantasmas.
 * Envia pacotes de "Sair de Partida" e "Sair de Sala" para o servidor da Garena.
 */

const fs = require('fs');
const path = require('path');
const { RoomClient } = require('./cliente');
const { criarPacoteSairPartida, criarPacoteSairSala } = require('./pacotes');

const ARQUIVO_CONTAS = path.join(__dirname, 'Contas', 'room-accounts.txt');

async function desbugarConta(uid, senha, index, total) {
    console.log(`\n[${index}/${total}] Processando conta UID ${uid}...`);
    const client = new RoomClient(uid, senha);
    try {
        const [at, oi] = await client.obterTokenGuest();
        if (!at || !oi) {
            console.log(`  ❌ [${uid}] Falha ao obter token Guest.`);
            return false;
        }

        const ok = await client.criarToken(at, oi);
        if (!ok) {
            console.log(`  ❌ [${uid}] Falha no MajorLogin.`);
            return false;
        }

        await client.iniciarConexoes();
        for (let i = 0; i < 25; i++) {
            if (client.isConnected()) break;
            await new Promise(r => setTimeout(r, 200));
        }

        if (!client.isConnected()) {
            console.log(`  ❌ [${uid}] Timeout na conexão TCP.`);
            await client.pararConexoes();
            return false;
        }

        // 1. Enviar pacote de sair de partida pendente
        const pktSairPartida = criarPacoteSairPartida(client.chave, client.iv);
        client.onlineSocket.write(pktSairPartida);
        await new Promise(r => setTimeout(r, 500));

        // 2. Enviar pacote de sair de sala pendente
        const pktSairSala = criarPacoteSairSala(0, client.chave, client.iv);
        client.onlineSocket.write(pktSairSala);
        await new Promise(r => setTimeout(r, 500));

        console.log(`  ✅ [${uid}] Comandos de sair da partida/sala enviados com sucesso!`);
        await client.pararConexoes();
        return true;
    } catch (err) {
        console.log(`  ❌ [${uid}] Erro: ${err.message}`);
        try { await client.pararConexoes(); } catch (e) {}
        return false;
    }
}

async function main() {
    console.log('====================================================');
    console.log('   DESBUGADOR DE CONTAS FREE FIRE (SAIR DE PARTIDA) ');
    console.log('====================================================');

    if (!fs.existsSync(ARQUIVO_CONTAS)) {
        console.error(`Arquivo ${ARQUIVO_CONTAS} não encontrado!`);
        process.exit(1);
    }

    const linhas = fs.readFileSync(ARQUIVO_CONTAS, 'utf-8')
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l && l.includes(':') && !l.startsWith('#'));

    console.log(`Total de contas encontradas: ${linhas.length}`);

    let sucesso = 0;
    let falhas = 0;

    for (let i = 0; i < linhas.length; i++) {
        const [uid, senha] = linhas[i].split(':');
        const ok = await desbugarConta(uid, senha, i + 1, linhas.length);
        if (ok) sucesso++;
        else falhas++;
        // Pequena pausa entre contas para não sobrecarregar
        await new Promise(r => setTimeout(r, 400));
    }

    console.log('\n====================================================');
    console.log(`FINALIZADO: ${sucesso} contas desbugadas com sucesso, ${falhas} falhas.`);
    console.log('====================================================');
}

main().catch(console.error);
