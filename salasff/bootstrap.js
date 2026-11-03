const axios = require('axios');
const fs = require('fs');
const path = require('path');

const GERADOR_URL = 'http://127.0.0.1:3000';
const QUANTIDADE = 5;
const ARQUIVO = path.join(__dirname, 'Contas', 'room-accounts.txt');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function start() {
    console.log(`[BOOTSTRAP] Solicitando ${QUANTIDADE} contas ao gerador local...`);
    try {
        const res = await axios.get(`${GERADOR_URL}/api/v1/gerar_contas?quantidade=${QUANTIDADE}&region=BR&workers=10`);
        const processId = res.data.processId;
        console.log(`[BOOTSTRAP] Processo criado: ${processId}. Aguardando geração...`);

        while (true) {
            await sleep(3000);
            const statusRes = await axios.get(`${GERADOR_URL}/api/v2/status?processId=${processId}`);
            const data = statusRes.data;
            if (data.status === 'CONCLUIDO') {
                console.log(`[BOOTSTRAP] Geração concluída! Baixando contas...`);
                break;
            } else {
                console.log(`[BOOTSTRAP] Progresso: ${data.stats.geradas}/${QUANTIDADE} contas...`);
            }
        }

        const downRes = await axios.get(`${GERADOR_URL}/api/v2/download-accounts?processId=${processId}`);
        const contasNovas = downRes.data.trim();
        
        if (contasNovas) {
            fs.appendFileSync(ARQUIVO, '\n' + contasNovas + '\n');
            console.log(`[BOOTSTRAP] Sucesso! ${QUANTIDADE} contas foram adicionadas no room-accounts.txt`);
        } else {
            console.log(`[BOOTSTRAP] Nenhuma conta recebida.`);
        }
    } catch (e) {
        console.error(`[BOOTSTRAP] Erro: ${e.message}`);
    }
}

start();
