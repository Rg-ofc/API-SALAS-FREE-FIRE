'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const config = require('./config');
const mw = require('./middleware/middleware');
const router = require('./router');
const admin = require('./handlers/admin_handlers');
const pag = require('./handlers/pagamento_handlers');

function garantirPastas(baseDir) {
    const dirs = [
        path.join(baseDir, 'DB_SYSTEM'),
        path.join(baseDir, 'DB_BACKUP'),
        path.join(baseDir, 'Contas'),
        path.join(baseDir, 'uploads'),
        path.join(baseDir, 'src_web', 'database'),
        path.join(baseDir, 'src_web', 'config'),
        path.join(baseDir, 'src_dashboard-web', 'database'),
        path.join(baseDir, 'src_dashboard-web', 'config'),
        path.join(baseDir, 'src_telegram', 'database'),
        path.join(baseDir, 'src_telegram', 'config'),
        path.join(baseDir, 'arquivo_morto'),
    ];
    for (const d of dirs) {
        fs.mkdirSync(d, { recursive: true });
    }
}

async function startServer(baseDir) {
    if (!baseDir) baseDir = process.env.KALLIDADE_BASE_DIR || process.cwd();

    config.init(baseDir);
    garantirPastas(baseDir);

    let db;
    try {
        db = require('../db_postgres');
        await db.inicializarSchema();
        if (typeof db.carregarCacheCompleto === 'function') await db.carregarCacheCompleto();
        console.log('  \x1b[92m[SQLITE]\x1b[0m Banco de dados inicializado com sucesso');
    } catch (e) {
        console.error(`  \x1b[91m[ERRO]\x1b[0m Falha ao inicializar SQLite: ${e.message}`);
        process.exit(1);
    }

    if (typeof admin.initStats === 'function') admin.initStats();
    if (typeof admin.loadSessionStore === 'function') admin.loadSessionStore();

    const routeHandler = router.setup();

    if (typeof pag.iniciarLimpezaFornecedores === 'function') pag.iniciarLimpezaFornecedores();

    const handler = (req, res) => {
        // CORS
        mw.setCORS(res);
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        mw.setSecurityHeaders(res);

        // Logger
        const start = Date.now();
        const originalEnd = res.end.bind(res);
        res.end = function (...args) {
            const duration = Date.now() - start;
            const statusCode = res.statusCode || 200;
            const color = statusCode >= 400 ? '\x1b[91m' : '\x1b[92m';
            console.log(`  ${color}[${statusCode}]\x1b[0m ${req.method} ${req.url} (${duration}ms)`);
            originalEnd(...args);
        };

        // Route
        try {
            const result = routeHandler(req, res);
            if (result && typeof result.catch === 'function') {
                result.catch(err => {
                    console.error(`  \x1b[91m[ERRO]\x1b[0m Handler error: ${err.message}`);
                    if (!res.headersSent) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ erro: 'Erro interno do servidor' }));
                    }
                });
            }
        } catch (err) {
            console.error(`  \x1b[91m[ERRO]\x1b[0m Handler error: ${err.message}`);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ erro: 'Erro interno do servidor' }));
            }
        }
    };

    const addr = '0.0.0.0';
    const port = parseInt(config.Port) || 25565;

    const server = http.createServer(handler);

    server.timeout = 30000;
    server.keepAliveTimeout = 120000;
    server.headersTimeout = 5000;
    server.maxHeadersCount = 100;

    server.listen(port, addr, () => {
        console.log('');
        console.log(' bot salas blabla ');
    console.log('');
    console.log(`  \x1b[92m[HTTP]\x1b[0m Servidor iniciado em ${addr}:${port}`);
    console.log(`  \x1b[92m[HTTP]\x1b[0m Bridge Node.js em 127.0.0.1:${config.BridgePort}`);
    console.log(`  \x1b[92m[HTTP]\x1b[0m Base dir: ${baseDir}`);
    console.log(`  \x1b[92m[HTTP]\x1b[0m CPUs: ${os.cpus().length}`);
    console.log('');
});

// Graceful shutdown
const shutdown = (signal) => {
    console.log(`\n  \x1b[93m[HTTP]\x1b[0m Recebido ${signal}, encerrando servidor graciosamente...`);
    server.close(() => {
        console.log('  \x1b[92m[HTTP]\x1b[0m Servidor encerrado com sucesso');
        if (db && typeof db.fechar === 'function') db.fechar();
        process.exit(0);
    });
    setTimeout(() => {
        console.log('  \x1b[91m[ERRO]\x1b[0m Timeout ao encerrar, forçando saída');
        process.exit(1);
    }, 10000);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

return server;
}

// Se executado diretamente
if (require.main === module) {
    startServer().catch(err => {
        console.error(`  \x1b[91m[ERRO]\x1b[0m Falha ao iniciar servidor: ${err.message}`);
        process.exit(1);
    });
}

module.exports = { startServer };
