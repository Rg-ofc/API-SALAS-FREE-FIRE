const efiPix = require('./web/handlers/efi_pix');
const config = require('./web/config');
const db = require('./db_postgres');

async function test() {
    console.log('Inicializando banco de dados...');
    await db.carregarCacheCompleto();
    
    // Configura o diretório base para carregar os certificados corretos
    config.init(__dirname);
    
    console.log('Gerando cobrança de R$ 1,50 na Efí para testes...');
    try {
        const res = await efiPix.criarCobrancaPixEfi(
            1.50,
            '123.456.789-09',
            'Teste Neon Store',
            'Teste de integracao Pix Efi'
        );
        
        if (res.erro) {
            console.error('Erro retornado pela Efí:', res.erro);
        } else {
            console.log('\n=== PIX GERADO COM SUCESSO ===');
            console.log('TXID:', res.txid);
            console.log('Chave Copia e Cola:', res.qrcode_texto);
            console.log('Link de Pagamento:', res.link_pagamento);
            console.log('==============================\n');
        }
    } catch (e) {
        console.error('Erro na requisição:', e.message);
    }
}

test();
