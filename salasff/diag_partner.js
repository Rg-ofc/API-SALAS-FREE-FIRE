const db = require('./db_postgres');

async function run() {
    console.log("Inicializando banco...");
    await db.inicializarSchema();
    console.log("Carregando caches...");
    await db.carregarCacheCompleto();
    console.log("Carregando chaves de parceiros...");
    const keys = await db.carregarPartnerKeys();
    console.log("Chaves carregadas:", JSON.stringify(keys, null, 2));
    process.exit(0);
}

run().catch(e => {
    console.error("Erro no diagnóstico:", e);
    process.exit(1);
});
