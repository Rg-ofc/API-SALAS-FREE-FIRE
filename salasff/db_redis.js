const Redis = require('ioredis');

// Configuracao via variaveis de ambiente
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || null;
const REDIS_DB = parseInt(process.env.REDIS_DB || '0');
const REDIS_PREFIX = 'sala:';

let redis = null;
let _cache = {}; // Cache local em memoria para acesso sincrono

function _getRedis() {
    if (!redis) {
        const opts = {
            host: REDIS_HOST,
            port: REDIS_PORT,
            db: REDIS_DB,
            retryStrategy: (times) => Math.min(times * 200, 5000),
            maxRetriesPerRequest: 3,
            lazyConnect: false,
            enableReadyCheck: true,
        };
        if (REDIS_PASSWORD) opts.password = REDIS_PASSWORD;
        redis = new Redis(opts);
        redis.on('error', (err) => {
            console.error('[DB-REDIS] Erro:', err.message);
        });
        redis.on('connect', () => {
            console.log('[DB-REDIS] Conectado ao Redis');
        });
        redis.on('ready', () => {
            console.log('[DB-REDIS] Redis pronto');
        });
    }
    return redis;
}

function carregarTodasSalas() {
    // Retorna cache local (sincrono)
    return { ..._cache };
}

async function carregarTodasSalasAsync() {
    const r = _getRedis();
    try {
        const keys = await r.keys(`${REDIS_PREFIX}*`);
        if (!keys || keys.length === 0) {
            _cache = {};
            return {};
        }
        const pipeline = r.pipeline();
        for (const key of keys) {
            pipeline.get(key);
        }
        const results = await pipeline.exec();
        const salas = {};
        for (let i = 0; i < keys.length; i++) {
            const sshash = keys[i].replace(REDIS_PREFIX, '');
            const [err, val] = results[i];
            if (!err && val) {
                try {
                    const data = JSON.parse(val);
                    // Converter campos booleanos
                    data.partida_iniciada = Boolean(data.partida_iniciada);
                    data.saldo_devolvido = Boolean(data.saldo_devolvido);
                    data.aguardando_reconexao = Boolean(data.aguardando_reconexao);
                    data.iniciar_ao_reconectar = Boolean(data.iniciar_ao_reconectar);
                    data.auto_iniciada = Boolean(data.auto_iniciada);
                    salas[sshash] = data;
                } catch (e) {
                    console.error(`[DB-REDIS] Erro ao parsear sala ${sshash}:`, e.message);
                }
            }
        }
        _cache = salas;
        console.log(`[DB-REDIS] ${Object.keys(salas).length} sala(s) carregada(s) do Redis`);
        return salas;
    } catch (e) {
        console.error('[DB-REDIS] Erro ao carregar salas:', e.message);
        return {};
    }
}

function salvarSala(sshash, data) {
    _cache[sshash] = { ...data };
    const r = _getRedis();
    // TTL de 3 horas (salas expiram naturalmente)
    r.setex(`${REDIS_PREFIX}${sshash}`, 10800, JSON.stringify(data)).catch(e => {
        console.error(`[DB-REDIS] Erro ao salvar sala ${sshash}:`, e.message);
    });
}

function salvarTodasSalas(salasDict) {
    _cache = { ...salasDict };
    const r = _getRedis();
    (async () => {
        try {
            // Buscar chaves existentes
            const existingKeys = await r.keys(`${REDIS_PREFIX}*`);
            const sshashesAtivos = new Set(Object.keys(salasDict));
            // Pipeline para eficiencia
            const pipeline = r.pipeline();
            // Remover salas que nao existem mais
            for (const key of existingKeys) {
                const sshash = key.replace(REDIS_PREFIX, '');
                if (!sshashesAtivos.has(sshash)) {
                    pipeline.del(key);
                }
            }
            // Salvar/atualizar salas ativas
            for (const [sshash, data] of Object.entries(salasDict)) {
                pipeline.setex(`${REDIS_PREFIX}${sshash}`, 10800, JSON.stringify(data));
            }
            await pipeline.exec();
        } catch (e) {
            console.error('[DB-REDIS] Erro ao salvar todas as salas:', e.message);
        }
    })();
}

function deletarSala(sshash) {
    delete _cache[sshash];
    const r = _getRedis();
    r.del(`${REDIS_PREFIX}${sshash}`).catch(e => {
        console.error(`[DB-REDIS] Erro ao deletar sala ${sshash}:`, e.message);
    });
}

function atualizarSalaCampos(sshash, campos) {
    if (_cache[sshash]) {
        for (const [k, v] of Object.entries(campos)) {
            _cache[sshash][k] = v;
        }
        // Salvar no Redis com os campos atualizados
        salvarSala(sshash, _cache[sshash]);
    }
}

async function fecharRedis() {
    if (redis) {
        await redis.quit();
        redis = null;
    }
}

async function inicializarRedis() {
    _getRedis();
    await carregarTodasSalasAsync();
}

module.exports = {
    inicializarRedis,
    carregarTodasSalas,
    carregarTodasSalasAsync,
    salvarSala,
    salvarTodasSalas,
    deletarSala,
    atualizarSalaCampos,
    fecharRedis,
};
