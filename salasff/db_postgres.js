const { Pool } = require('pg');

// Configuracao via variaveis de ambiente
const PG_HOST = process.env.PG_HOST || '127.0.0.1';
const PG_PORT = parseInt(process.env.PG_PORT || '5432');
const PG_USER = process.env.PG_USER || 'postgres';
const PG_PASS = process.env.PG_PASS || '';
const PG_DB = process.env.PG_DB || 'postgres';

let pool = null;

function _getPool() {
    if (!pool) {
        pool = new Pool({
            host: PG_HOST,
            port: PG_PORT,
            user: PG_USER,
            password: PG_PASS,
            database: PG_DB,
            max: 20,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000,
        });
        pool.on('error', (err) => {
            console.error('[DB-PG] Erro no pool:', err.message);
        });
    }
    return pool;
}

// Helper: executa query e retorna rows
async function _query(sql, params = []) {
    const p = _getPool();
    try {
        const res = await p.query(sql, params);
        return res.rows || [];
    } catch (e) {
        console.error('[DB-PG] Erro query:', e.message, '\nSQL:', sql.substring(0, 200));
        return [];
    }
}

// Helper: executa query e retorna primeira row ou null
async function _queryOne(sql, params = []) {
    const rows = await _query(sql, params);
    return rows.length > 0 ? rows[0] : null;
}

// Helper: executa INSERT/UPDATE/DELETE
async function _exec(sql, params = []) {
    const p = _getPool();
    try {
        await p.query(sql, params);
    } catch (e) {
        console.error('[DB-PG] Erro exec:', e.message, '\nSQL:', sql.substring(0, 200));
    }
}

// Helper: executa multiplas queries em transacao
async function _transaction(fn) {
    const p = _getPool();
    const client = await p.connect();
    try {
        await client.query('BEGIN');
        await fn(client);
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('[DB-PG] Erro transacao:', e.message);
    } finally {
        client.release();
    }
}

function _boolToInt(v) { return v ? 1 : 0; }

const _cache = {};
let _initialized = false;

async function inicializarSchema() {
    if (_initialized) return;
    const p = _getPool();

    // Criar tabelas
    await p.query(`
        CREATE TABLE IF NOT EXISTS rooms (
            sshash TEXT PRIMARY KEY,
            room_id TEXT,
            uid_conta TEXT,
            modo INTEGER DEFAULT 1,
            senha TEXT DEFAULT '',
            nome TEXT DEFAULT '',
            created_at TEXT,
            created_timestamp DOUBLE PRECISION,
            estado TEXT DEFAULT 'ESPERANDO_COMECAR',
            last_update DOUBLE PRECISION,
            partida_iniciada INTEGER DEFAULT 0,
            partida_iniciada_timestamp DOUBLE PRECISION,
            oauth_key TEXT DEFAULT '',
            saldo_devolvido INTEGER DEFAULT 0,
            aguardando_reconexao INTEGER DEFAULT 0,
            iniciar_ao_reconectar INTEGER DEFAULT 0,
            auto_iniciada INTEGER DEFAULT 0,
            auto_start_min REAL DEFAULT 5,
            telegram_callback TEXT,
            error TEXT,
            msg_timeout TEXT,
            extra_data TEXT
        )
    `);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_rooms_estado ON rooms(estado)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_rooms_uid_conta ON rooms(uid_conta)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_rooms_created_timestamp ON rooms(created_timestamp)`);

    await p.query(`
        CREATE TABLE IF NOT EXISTS stats (
            chave TEXT PRIMARY KEY,
            valor TEXT
        )
    `);

    await p.query(`
        CREATE TABLE IF NOT EXISTS room_accounts (
            uid TEXT PRIMARY KEY,
            nick TEXT DEFAULT 'N/A',
            account_id TEXT,
            pass_hash TEXT,
            status_api TEXT DEFAULT 'livre',
            status_jogo TEXT DEFAULT 'offline',
            jwt_exp TEXT,
            chave_atual TEXT,
            iv_atual TEXT,
            main_ip TEXT,
            main_porta TEXT,
            online_ip TEXT,
            online_porta TEXT,
            extra_data TEXT
        )
    `);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_room_accounts_status ON room_accounts(status_api, status_jogo)`);

    await p.query(`
        CREATE TABLE IF NOT EXISTS usuarios (
            user_id TEXT PRIMARY KEY,
            username TEXT,
            avatar TEXT,
            primeiro_login TEXT,
            total_logins INTEGER DEFAULT 0,
            ultimo_login TEXT
        )
    `);

    await p.query(`
        CREATE TABLE IF NOT EXISTS sessoes (
            token TEXT PRIMARY KEY,
            csrf_token TEXT,
            user_id TEXT,
            username TEXT,
            avatar TEXT,
            criada_em TEXT,
            ultimo_acesso TEXT,
            expira_em TEXT
        )
    `);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_sessoes_user ON sessoes(user_id)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_sessoes_expira ON sessoes(expira_em)`);

    await p.query(`
        CREATE TABLE IF NOT EXISTS saldos (
            user_id TEXT PRIMARY KEY,
            creditos DOUBLE PRECISION DEFAULT 0,
            total_gasto DOUBLE PRECISION DEFAULT 0,
            total_salas_compradas INTEGER DEFAULT 0,
            extra_data TEXT
        )
    `);

    await p.query(`
        CREATE TABLE IF NOT EXISTS keys_info (
            key TEXT PRIMARY KEY,
            ativa INTEGER DEFAULT 1,
            criada_em TEXT,
            user_id TEXT DEFAULT '',
            ilimitada INTEGER DEFAULT 0,
            limite_usos INTEGER DEFAULT 0,
            nome TEXT DEFAULT 'Sem nome',
            total_usos INTEGER DEFAULT 0,
            usos_totais INTEGER DEFAULT 0,
            ultima_request TEXT,
            comprado_por TEXT,
            extra_data TEXT
        )
    `);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_keys_ativa ON keys_info(ativa)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_keys_user ON keys_info(user_id)`);

    await p.query(`
        CREATE TABLE IF NOT EXISTS user_keys (
            telegram_user_id TEXT,
            key_name TEXT,
            PRIMARY KEY (telegram_user_id, key_name)
        )
    `);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_user_keys_tid ON user_keys(telegram_user_id)`);

    await p.query(`
        CREATE TABLE IF NOT EXISTS user_config (
            telegram_user_id TEXT PRIMARY KEY,
            auto_start INTEGER DEFAULT 0,
            full_capa INTEGER DEFAULT 0,
            senha_fixa TEXT DEFAULT '',
            extra_data TEXT
        )
    `);

    await p.query(`
        CREATE TABLE IF NOT EXISTS pagamentos (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            tipo TEXT,
            quantidade INTEGER DEFAULT 0,
            valor DOUBLE PRECISION DEFAULT 0,
            status TEXT DEFAULT 'PENDENTE',
            criado_em TEXT,
            pago_em TEXT,
            txid TEXT,
            cpf TEXT,
            nome TEXT,
            link_pagamento TEXT,
            qrcode_imagem TEXT,
            qrcode_texto TEXT,
            extra_data TEXT
        )
    `);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_pagamentos_user ON pagamentos(user_id)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_pagamentos_status ON pagamentos(status)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_pagamentos_txid ON pagamentos(txid)`);

    await p.query(`
        CREATE TABLE IF NOT EXISTS pagamentos_config (
            chave TEXT PRIMARY KEY,
            valor TEXT
        )
    `);

    await p.query(`
        CREATE TABLE IF NOT EXISTS admin_sessions (
            user_id TEXT PRIMARY KEY,
            username TEXT,
            avatar TEXT,
            email TEXT,
            session_token TEXT,
            csrf_token TEXT,
            ultimo_acesso TEXT,
            extra_data TEXT
        )
    `);

    await p.query(`
        CREATE TABLE IF NOT EXISTS admins_dashboard (
            user_id TEXT PRIMARY KEY,
            adicionado_em TEXT,
            cargo TEXT DEFAULT 'admin'
        )
    `);

    await p.query(`
        CREATE TABLE IF NOT EXISTS admin_session_store (
            session_hash TEXT PRIMARY KEY,
            data TEXT
        )
    `);

    await p.query(`
        CREATE TABLE IF NOT EXISTS info_admin (
            chave TEXT PRIMARY KEY,
            valor TEXT
        )
    `);

    await p.query(`
        CREATE TABLE IF NOT EXISTS fornecedores (
            chave TEXT PRIMARY KEY,
            valor TEXT
        )
    `);

    await p.query(`
        CREATE TABLE IF NOT EXISTS transmissoes (
            id TEXT PRIMARY KEY,
            admin_user_id TEXT,
            admin_username TEXT,
            criada_em TEXT,
            duracao_segundos DOUBLE PRECISION,
            enviados INTEGER DEFAULT 0,
            erros INTEGER DEFAULT 0,
            finalizada_em TEXT,
            fotos TEXT,
            media_por_segundo DOUBLE PRECISION,
            mensagem TEXT,
            status TEXT DEFAULT 'enviando',
            total_usuarios INTEGER DEFAULT 0
        )
    `);

    await p.query(`
        CREATE TABLE IF NOT EXISTS telegram_vips (
            user_id TEXT PRIMARY KEY,
            adicionado_em TEXT,
            expira_em TEXT,
            tipo TEXT DEFAULT 'permanente'
        )
    `);

    await p.query(`
        CREATE TABLE IF NOT EXISTS telegram_vips_config (
            chave TEXT PRIMARY KEY,
            valor TEXT
        )
    `);

    await p.query(`
        CREATE TABLE IF NOT EXISTS telegram_vips_meta (
            chave TEXT PRIMARY KEY,
            valor TEXT
        )
    `);

    await p.query(`
        CREATE TABLE IF NOT EXISTS info_accounts (
            uid TEXT PRIMARY KEY,
            password TEXT,
            "accessToken" TEXT,
            "openID" TEXT,
            invalidado INTEGER DEFAULT 0
        )
    `);

    await p.query(`
        CREATE TABLE IF NOT EXISTS avisos (
            id TEXT PRIMARY KEY,
            titulo TEXT,
            conteudo TEXT,
            imagem TEXT,
            criado_em TEXT,
            extra_data TEXT
        )
    `);

    await p.query(`
        CREATE TABLE IF NOT EXISTS user_bot_info (
            user_id TEXT PRIMARY KEY,
            data TEXT
        )
    `);

    await p.query(`
        CREATE TABLE IF NOT EXISTS users_bot (
            user_id TEXT PRIMARY KEY,
            first_name TEXT,
            username TEXT,
            registrado_em TEXT,
            ultimo_uso TEXT,
            extra_data TEXT
        )
    `);

    await p.query(`
        CREATE TABLE IF NOT EXISTS keys_arquivadas (
            id SERIAL PRIMARY KEY,
            dados TEXT
        )
    `);

    await p.query(`
        CREATE TABLE IF NOT EXISTS pagamentos_pendentes_expirados (
            id SERIAL PRIMARY KEY,
            dados TEXT
        )
    `);

    await p.query(`
        CREATE TABLE IF NOT EXISTS partner_keys (
            key TEXT PRIMARY KEY,
            nome TEXT DEFAULT '',
            ativa INTEGER DEFAULT 1,
            criada_em TEXT,
            extra_data TEXT
        )
    `);

    const pKeys = await p.query('SELECT 1 FROM partner_keys LIMIT 1');
    if (pKeys.rows.length === 0) {
        const timeNow = new Date().toISOString().replace('T', ' ').slice(0, 19);
        await p.query(`INSERT INTO partner_keys (key, nome, ativa, criada_em) VALUES ($1, $2, $3, $4)`,
            ['neonstore7700099aaAHHhhzhha', 'Neon Store', 1, timeNow]);
    }

    _initialized = true;
    console.log('[DB-PG] Schema inicializado com sucesso');
}

// Room helpers

const _ROOM_KNOWN_FIELDS = new Set([
    'sshash', 'room_id', 'uid_conta', 'modo', 'senha', 'nome',
    'created_at', 'created_timestamp', 'estado', 'last_update',
    'partida_iniciada', 'partida_iniciada_timestamp', 'oauth_key',
    'saldo_devolvido', 'aguardando_reconexao', 'iniciar_ao_reconectar',
    'auto_iniciada', 'auto_start_min', 'telegram_callback', 'error', 'msg_timeout'
]);

function _salaRowToDict(row) {
    const d = { ...row };
    d.partida_iniciada = Boolean(d.partida_iniciada);
    d.saldo_devolvido = Boolean(d.saldo_devolvido);
    d.aguardando_reconexao = Boolean(d.aguardando_reconexao);
    d.iniciar_ao_reconectar = Boolean(d.iniciar_ao_reconectar);
    d.auto_iniciada = Boolean(d.auto_iniciada);
    if (d.telegram_callback && typeof d.telegram_callback === 'string') {
        try { d.telegram_callback = JSON.parse(d.telegram_callback); } catch (e) { /* */ }
    }
    if (d.extra_data) {
        try { const extra = JSON.parse(d.extra_data); if (typeof extra === 'object' && extra !== null) Object.assign(d, extra); } catch (e) { /* */ }
    }
    delete d.extra_data;
    return d;
}

function _salaDictToParams(sshash, data) {
    const extra = {};
    for (const [k, v] of Object.entries(data)) {
        if (!_ROOM_KNOWN_FIELDS.has(k) && k !== 'extra_data') extra[k] = v;
    }
    const extraJson = Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;
    let tcb = data.telegram_callback;
    if (typeof tcb === 'object' && tcb !== null) tcb = JSON.stringify(tcb);
    return [
        sshash, data.room_id || null, data.uid_conta || null, data.modo || 1,
        data.senha || '', data.nome || '', data.created_at || null,
        data.created_timestamp || null, data.estado || 'ESPERANDO_COMECAR',
        data.last_update || null, _boolToInt(data.partida_iniciada),
        data.partida_iniciada_timestamp || null, data.oauth_key || '',
        _boolToInt(data.saldo_devolvido), _boolToInt(data.aguardando_reconexao),
        _boolToInt(data.iniciar_ao_reconectar), _boolToInt(data.auto_iniciada),
        data.auto_start_min || 5, tcb || null, data.error || null,
        data.msg_timeout || null, extraJson,
    ];
}

const _ROOM_UPSERT_SQL = `
    INSERT INTO rooms (
        sshash, room_id, uid_conta, modo, senha, nome,
        created_at, created_timestamp, estado, last_update,
        partida_iniciada, partida_iniciada_timestamp, oauth_key,
        saldo_devolvido, aguardando_reconexao, iniciar_ao_reconectar,
        auto_iniciada, auto_start_min, telegram_callback, error, msg_timeout, extra_data
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
    ON CONFLICT (sshash) DO UPDATE SET
        room_id=EXCLUDED.room_id, uid_conta=EXCLUDED.uid_conta, modo=EXCLUDED.modo,
        senha=EXCLUDED.senha, nome=EXCLUDED.nome, created_at=EXCLUDED.created_at,
        created_timestamp=EXCLUDED.created_timestamp, estado=EXCLUDED.estado,
        last_update=EXCLUDED.last_update, partida_iniciada=EXCLUDED.partida_iniciada,
        partida_iniciada_timestamp=EXCLUDED.partida_iniciada_timestamp, oauth_key=EXCLUDED.oauth_key,
        saldo_devolvido=EXCLUDED.saldo_devolvido, aguardando_reconexao=EXCLUDED.aguardando_reconexao,
        iniciar_ao_reconectar=EXCLUDED.iniciar_ao_reconectar, auto_iniciada=EXCLUDED.auto_iniciada,
        auto_start_min=EXCLUDED.auto_start_min, telegram_callback=EXCLUDED.telegram_callback,
        error=EXCLUDED.error, msg_timeout=EXCLUDED.msg_timeout, extra_data=EXCLUDED.extra_data
`;

// Rooms

function carregarTodasSalas() {
    // Sincrono: retorna do cache, atualiza em background
    if (_cache.rooms) return { ..._cache.rooms };
    return {};
}

function _carregarTodasSalasAsync() {
    return _query('SELECT * FROM rooms').then(rows => {
        const result = {};
        for (const row of rows) {
            const d = _salaRowToDict(row);
            const sshash = d.sshash;
            delete d.sshash;
            result[sshash] = d;
        }
        _cache.rooms = result;
        return result;
    });
}

function salvarSala(sshash, data) {
    // Atualizar cache
    if (!_cache.rooms) _cache.rooms = {};
    _cache.rooms[sshash] = { ...data };
    // Salvar no banco em background
    const params = _salaDictToParams(sshash, data);
    _exec(_ROOM_UPSERT_SQL, params);
}

function salvarTodasSalas(salasDict) {
    _cache.rooms = { ...salasDict };
    _transaction(async (client) => {
        const sshashesAtivos = new Set(Object.keys(salasDict));
        const res = await client.query('SELECT sshash FROM rooms');
        const sshashesDb = new Set(res.rows.map(r => r.sshash));
        const remover = [...sshashesDb].filter(s => !sshashesAtivos.has(s));
        for (const s of remover) {
            await client.query('DELETE FROM rooms WHERE sshash = $1', [s]);
        }
        for (const [sshash, data] of Object.entries(salasDict)) {
            const params = _salaDictToParams(sshash, data);
            await client.query(_ROOM_UPSERT_SQL, params);
        }
    });
}

function deletarSala(sshash) {
    if (_cache.rooms) delete _cache.rooms[sshash];
    _exec('DELETE FROM rooms WHERE sshash = $1', [sshash]);
}

function atualizarSalaCampos(sshash, campos) {
    // Atualizar cache
    if (_cache.rooms && _cache.rooms[sshash]) {
        for (const [k, v] of Object.entries(campos)) {
            _cache.rooms[sshash][k] = v;
        }
    }
    // Atualizar banco: ler, modificar, salvar
    _query('SELECT * FROM rooms WHERE sshash = $1', [sshash]).then(rows => {
        if (rows.length === 0) return;
        const current = { ...rows[0] };
        for (const [k, v] of Object.entries(campos)) {
            if (_ROOM_KNOWN_FIELDS.has(k)) {
                if (['partida_iniciada', 'saldo_devolvido', 'aguardando_reconexao', 'iniciar_ao_reconectar', 'auto_iniciada'].includes(k)) {
                    current[k] = _boolToInt(v);
                } else if (k === 'telegram_callback' && typeof v === 'object') {
                    current[k] = JSON.stringify(v);
                } else {
                    current[k] = v;
                }
            } else {
                let extra = {};
                if (current.extra_data) {
                    try { extra = JSON.parse(current.extra_data); } catch (e) { extra = {}; }
                }
                extra[k] = v;
                current.extra_data = JSON.stringify(extra);
            }
        }
        _exec(_ROOM_UPSERT_SQL, [
            current.sshash, current.room_id, current.uid_conta, current.modo, current.senha, current.nome,
            current.created_at, current.created_timestamp, current.estado, current.last_update,
            current.partida_iniciada, current.partida_iniciada_timestamp, current.oauth_key,
            current.saldo_devolvido, current.aguardando_reconexao, current.iniciar_ao_reconectar,
            current.auto_iniciada, current.auto_start_min, current.telegram_callback, current.error, current.msg_timeout, current.extra_data
        ]);
    });
}

// Stats

function carregarStats() {
    if (_cache.stats) return { ..._cache.stats };
    return {};
}

function _carregarStatsAsync() {
    return _query('SELECT chave, valor FROM stats').then(rows => {
        const result = {};
        for (const row of rows) {
            try { result[row.chave] = JSON.parse(row.valor); } catch (e) { result[row.chave] = row.valor; }
        }
        _cache.stats = result;
        return result;
    });
}

function salvarStat(chave, valor) {
    if (!_cache.stats) _cache.stats = {};
    _cache.stats[chave] = valor;
    _exec('INSERT INTO stats (chave, valor) VALUES ($1, $2) ON CONFLICT (chave) DO UPDATE SET valor=EXCLUDED.valor', [chave, JSON.stringify(valor)]);
}

function salvarStats(dados) {
    if (!_cache.stats) _cache.stats = {};
    Object.assign(_cache.stats, dados);
    _transaction(async (client) => {
        for (const [chave, valor] of Object.entries(dados)) {
            await client.query('INSERT INTO stats (chave, valor) VALUES ($1, $2) ON CONFLICT (chave) DO UPDATE SET valor=EXCLUDED.valor', [chave, JSON.stringify(valor)]);
        }
    });
}

// Room Accounts

function carregarRoomAccounts() {
    if (_cache.roomAccounts) return { ..._cache.roomAccounts };
    return {};
}

function _carregarRoomAccountsAsync() {
    return _query('SELECT * FROM room_accounts').then(rows => {
        const result = {};
        for (const row of rows) {
            const d = { ...row };
            const uid = d.uid;
            d['pass'] = d.pass_hash || '';
            delete d.pass_hash;
            if (d.extra_data) {
                try { const extra = JSON.parse(d.extra_data); if (typeof extra === 'object' && extra !== null) Object.assign(d, extra); } catch (e) { /* */ }
            }
            delete d.extra_data;
            result[uid] = d;
        }
        _cache.roomAccounts = result;
        return result;
    });
}

function salvarRoomAccount(uid, data) {
    if (!_cache.roomAccounts) _cache.roomAccounts = {};
    _cache.roomAccounts[String(uid)] = { ...data, uid: String(uid) };
    const known = new Set(['uid', 'nick', 'account_id', 'pass', 'status_api', 'status_jogo', 'jwt_exp', 'chave_atual', 'iv_atual', 'main_ip', 'main_porta', 'online_ip', 'online_porta']);
    const extra = {};
    for (const [k, v] of Object.entries(data)) {
        if (!known.has(k) && k !== 'extra_data' && k !== 'pass_hash') extra[k] = v;
    }
    const extraJson = Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;
    _exec(`INSERT INTO room_accounts (uid, nick, account_id, pass_hash, status_api, status_jogo, jwt_exp, chave_atual, iv_atual, main_ip, main_porta, online_ip, online_porta, extra_data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (uid) DO UPDATE SET nick=EXCLUDED.nick, account_id=EXCLUDED.account_id, pass_hash=EXCLUDED.pass_hash, status_api=EXCLUDED.status_api, status_jogo=EXCLUDED.status_jogo, jwt_exp=EXCLUDED.jwt_exp, chave_atual=EXCLUDED.chave_atual, iv_atual=EXCLUDED.iv_atual, main_ip=EXCLUDED.main_ip, main_porta=EXCLUDED.main_porta, online_ip=EXCLUDED.online_ip, online_porta=EXCLUDED.online_porta, extra_data=EXCLUDED.extra_data`,
        [String(uid), data.nick || 'N/A', String(data.account_id || ''), data['pass'] || '',
        data.status_api || 'livre', data.status_jogo || 'offline', String(data.jwt_exp || ''),
        data.chave_atual || '', data.iv_atual || '', data.main_ip || '', String(data.main_porta || ''),
        data.online_ip || '', String(data.online_porta || ''), extraJson]);
}

function salvarTodosRoomAccounts(accountsDict) {
    _cache.roomAccounts = { ...accountsDict };
    const known = new Set(['uid', 'nick', 'account_id', 'pass', 'status_api', 'status_jogo', 'jwt_exp', 'chave_atual', 'iv_atual', 'main_ip', 'main_porta', 'online_ip', 'online_porta']);
    _transaction(async (client) => {
        for (const [uid, data] of Object.entries(accountsDict)) {
            const extra = {};
            for (const [k, v] of Object.entries(data)) {
                if (!known.has(k) && k !== 'extra_data' && k !== 'pass_hash') extra[k] = v;
            }
            const extraJson = Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;
            await client.query(`INSERT INTO room_accounts (uid, nick, account_id, pass_hash, status_api, status_jogo, jwt_exp, chave_atual, iv_atual, main_ip, main_porta, online_ip, online_porta, extra_data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
                ON CONFLICT (uid) DO UPDATE SET nick=EXCLUDED.nick, account_id=EXCLUDED.account_id, pass_hash=EXCLUDED.pass_hash, status_api=EXCLUDED.status_api, status_jogo=EXCLUDED.status_jogo, jwt_exp=EXCLUDED.jwt_exp, chave_atual=EXCLUDED.chave_atual, iv_atual=EXCLUDED.iv_atual, main_ip=EXCLUDED.main_ip, main_porta=EXCLUDED.main_porta, online_ip=EXCLUDED.online_ip, online_porta=EXCLUDED.online_porta, extra_data=EXCLUDED.extra_data`,
                [String(uid), data.nick || 'N/A', String(data.account_id || ''), data['pass'] || '',
                data.status_api || 'livre', data.status_jogo || 'offline', String(data.jwt_exp || ''),
                data.chave_atual || '', data.iv_atual || '', data.main_ip || '', String(data.main_porta || ''),
                data.online_ip || '', String(data.online_porta || ''), extraJson]);
        }
    });
}

function removerRoomAccounts(uidsSet) {
    for (const uid of uidsSet) {
        if (_cache.roomAccounts) delete _cache.roomAccounts[String(uid)];
        _exec('DELETE FROM room_accounts WHERE uid = $1', [String(uid)]);
    }
}

// Usuarios

function carregarUsuarios() {
    if (_cache.usuarios) return { usuarios: Object.values(_cache.usuarios) };
    return { usuarios: [] };
}

function _carregarUsuariosAsync() {
    return _query('SELECT * FROM usuarios').then(rows => {
        const result = {};
        for (const row of rows) {
            result[row.user_id] = { ...row };
        }
        _cache.usuarios = result;
        return result;
    });
}

function salvarUsuario(userId, data) {
    if (!_cache.usuarios) _cache.usuarios = {};
    _cache.usuarios[String(userId)] = { ...data, user_id: String(userId) };
    _exec(`INSERT INTO usuarios (user_id, username, avatar, primeiro_login, total_logins, ultimo_login) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (user_id) DO UPDATE SET username=EXCLUDED.username, avatar=EXCLUDED.avatar, primeiro_login=EXCLUDED.primeiro_login, total_logins=EXCLUDED.total_logins, ultimo_login=EXCLUDED.ultimo_login`,
        [String(userId), data.username || '', data.avatar || '', data.primeiro_login || '', parseInt(data.total_logins || 0), data.ultimo_login || '']);
}

// Sessoes

function carregarSessoes() {
    if (_cache.sessoes) return { sessoes: Object.values(_cache.sessoes) };
    return { sessoes: [] };
}

function _carregarSessoesAsync() {
    return _query('SELECT * FROM sessoes').then(rows => {
        const result = {};
        for (const row of rows) {
            result[row.token] = { ...row };
        }
        _cache.sessoes = result;
        return result;
    });
}

function salvarSessao(data) {
    if (!_cache.sessoes) _cache.sessoes = {};
    _cache.sessoes[data.token] = { ...data };
    _exec(`INSERT INTO sessoes (token, csrf_token, user_id, username, avatar, criada_em, ultimo_acesso, expira_em) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (token) DO UPDATE SET csrf_token=EXCLUDED.csrf_token, user_id=EXCLUDED.user_id, username=EXCLUDED.username, avatar=EXCLUDED.avatar, criada_em=EXCLUDED.criada_em, ultimo_acesso=EXCLUDED.ultimo_acesso, expira_em=EXCLUDED.expira_em`,
        [data.token || '', data.csrf_token || '', data.user_id || '', data.username || '', data.avatar || null, data.criada_em || '', data.ultimo_acesso || '', data.expira_em || '']);
}

function deletarSessaoPorToken(token) {
    if (_cache.sessoes) delete _cache.sessoes[token];
    _exec('DELETE FROM sessoes WHERE token = $1', [token]);
}

function deletarSessoesPorUser(userId) {
    if (_cache.sessoes) {
        for (const [token, sess] of Object.entries(_cache.sessoes)) {
            if (sess.user_id === String(userId)) delete _cache.sessoes[token];
        }
    }
    _exec('DELETE FROM sessoes WHERE user_id = $1', [String(userId)]);
}

function atualizarSessaoAcesso(token) {
    const now = new Date().toISOString();
    if (_cache.sessoes && _cache.sessoes[token]) {
        _cache.sessoes[token].ultimo_acesso = now;
    }
    _exec('UPDATE sessoes SET ultimo_acesso = $1 WHERE token = $2', [now, token]);
}

function salvarTodasSessoes(sessoesInput) {
    const listaSessoes = Array.isArray(sessoesInput) ? sessoesInput : (sessoesInput.sessoes || []);
    const newCache = {};
    for (const s of listaSessoes) { newCache[s.token] = { ...s }; }
    _cache.sessoes = newCache;
    _transaction(async (client) => {
        await client.query('DELETE FROM sessoes');
        for (const s of listaSessoes) {
            await client.query(`INSERT INTO sessoes (token, csrf_token, user_id, username, avatar, criada_em, ultimo_acesso, expira_em) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                [s.token || '', s.csrf_token || '', s.user_id || '', s.username || '', s.avatar || null, s.criada_em || '', s.ultimo_acesso || '', s.expira_em || '']);
        }
    });
}

// Saldos

function carregarSaldos() {
    if (_cache.saldos) return { ..._cache.saldos };
    return {};
}

function _carregarSaldosAsync() {
    return _query('SELECT * FROM saldos').then(rows => {
        const result = {};
        for (const row of rows) {
            const d = { ...row }; const id = d.user_id; delete d.user_id;
            if (d.extra_data) { try { const extra = JSON.parse(d.extra_data); if (typeof extra === 'object') Object.assign(d, extra); } catch (e) { /* */ } }
            delete d.extra_data; result[id] = d;
        }
        _cache.saldos = result;
        return result;
    });
}

function salvarSaldo(userId, data) {
    if (!_cache.saldos) _cache.saldos = {};
    _cache.saldos[String(userId)] = { ...data };
    const known = new Set(['creditos', 'total_gasto', 'total_salas_compradas']);
    const extra = {}; for (const [k, v] of Object.entries(data)) { if (!known.has(k) && k !== 'extra_data') extra[k] = v; }
    const extraJson = Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;
    _exec(`INSERT INTO saldos (user_id, creditos, total_gasto, total_salas_compradas, extra_data) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (user_id) DO UPDATE SET creditos=EXCLUDED.creditos, total_gasto=EXCLUDED.total_gasto, total_salas_compradas=EXCLUDED.total_salas_compradas, extra_data=EXCLUDED.extra_data`,
        [String(userId), parseFloat(data.creditos || 0), parseFloat(data.total_gasto || 0), parseInt(data.total_salas_compradas || 0), extraJson]);
}

function salvarTodosSaldos(saldosDict) {
    _cache.saldos = { ...saldosDict };
    const known = new Set(['creditos', 'total_gasto', 'total_salas_compradas']);
    _transaction(async (client) => {
        await client.query('DELETE FROM saldos');
        for (const [did, data] of Object.entries(saldosDict)) {
            const extra = {}; for (const [k, v] of Object.entries(data)) { if (!known.has(k) && k !== 'extra_data') extra[k] = v; }
            const extraJson = Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;
            await client.query(`INSERT INTO saldos (user_id, creditos, total_gasto, total_salas_compradas, extra_data) VALUES ($1,$2,$3,$4,$5)`,
                [String(did), parseFloat(data.creditos || 0), parseFloat(data.total_gasto || 0), parseInt(data.total_salas_compradas || 0), extraJson]);
        }
    });
}

// Keys Info

function carregarKeysInfo() {
    if (_cache.keys) return { keys: [...(_cache.keys || [])] };
    return { keys: [] };
}

function _carregarKeysInfoAsync() {
    return _query('SELECT * FROM keys_info').then(rows => {
        const result = [];
        for (const row of rows) {
            const d = { ...row }; d.ativa = Boolean(d.ativa); d.ilimitada = Boolean(d.ilimitada);
            if (d.extra_data) { try { const extra = JSON.parse(d.extra_data); if (typeof extra === 'object') Object.assign(d, extra); } catch (e) { /* */ } }
            delete d.extra_data; result.push(d);
        }
        _cache.keys = result;
        return { keys: result };
    });
}

function salvarKeyInfo(data) {
    // Atualizar cache
    if (!_cache.keys) _cache.keys = [];
    const idx = _cache.keys.findIndex(k => k.key === data.key);
    const cacheEntry = { ...data, ativa: Boolean(data.ativa !== undefined ? data.ativa : true), ilimitada: Boolean(data.ilimitada || false) };
    if (idx >= 0) _cache.keys[idx] = cacheEntry; else _cache.keys.push(cacheEntry);

    const known = new Set(['key', 'ativa', 'criada_em', 'user_id', 'ilimitada', 'limite_usos', 'nome', 'total_usos', 'usos_totais', 'ultima_request', 'comprado_por']);
    const extra = {}; for (const [k, v] of Object.entries(data)) { if (!known.has(k) && k !== 'extra_data') extra[k] = v; }
    const extraJson = Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;
    _exec(`INSERT INTO keys_info (key, ativa, criada_em, user_id, ilimitada, limite_usos, nome, total_usos, usos_totais, ultima_request, comprado_por, extra_data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (key) DO UPDATE SET ativa=EXCLUDED.ativa, criada_em=EXCLUDED.criada_em, user_id=EXCLUDED.user_id, ilimitada=EXCLUDED.ilimitada, limite_usos=EXCLUDED.limite_usos, nome=EXCLUDED.nome, total_usos=EXCLUDED.total_usos, usos_totais=EXCLUDED.usos_totais, ultima_request=EXCLUDED.ultima_request, comprado_por=EXCLUDED.comprado_por, extra_data=EXCLUDED.extra_data`,
        [data.key || '', _boolToInt(data.ativa !== undefined ? data.ativa : true), data.criada_em || '', data.user_id || '', _boolToInt(data.ilimitada || false), parseInt(data.limite_usos || 0), data.nome || 'Sem nome', parseInt(data.total_usos || 0), parseInt(data.usos_totais || 0), data.ultima_request || '', data.comprado_por || null, extraJson]);
}

function salvarTodasKeys(keysInput) {
    const keysList = Array.isArray(keysInput) ? keysInput : (keysInput.keys || []);
    _cache.keys = keysList.map(k => ({ ...k, ativa: Boolean(k.ativa !== undefined ? k.ativa : true), ilimitada: Boolean(k.ilimitada || false) }));
    const known = new Set(['key', 'ativa', 'criada_em', 'user_id', 'ilimitada', 'limite_usos', 'nome', 'total_usos', 'usos_totais', 'ultima_request', 'comprado_por']);
    _transaction(async (client) => {
        for (const data of keysList) {
            if (!data.key) continue;
            const extra = {}; for (const [k, v] of Object.entries(data)) { if (!known.has(k) && k !== 'extra_data') extra[k] = v; }
            const extraJson = Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;
            await client.query(`INSERT INTO keys_info (key, ativa, criada_em, user_id, ilimitada, limite_usos, nome, total_usos, usos_totais, ultima_request, comprado_por, extra_data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                ON CONFLICT (key) DO UPDATE SET ativa=EXCLUDED.ativa, criada_em=EXCLUDED.criada_em, user_id=EXCLUDED.user_id, ilimitada=EXCLUDED.ilimitada, limite_usos=EXCLUDED.limite_usos, nome=EXCLUDED.nome, total_usos=EXCLUDED.total_usos, usos_totais=EXCLUDED.usos_totais, ultima_request=EXCLUDED.ultima_request, comprado_por=EXCLUDED.comprado_por, extra_data=EXCLUDED.extra_data`,
                [data.key || '', _boolToInt(data.ativa !== undefined ? data.ativa : true), data.criada_em || '', data.user_id || '', _boolToInt(data.ilimitada || false), parseInt(data.limite_usos || 0), data.nome || 'Sem nome', parseInt(data.total_usos || 0), parseInt(data.usos_totais || 0), data.ultima_request || '', data.comprado_por || null, extraJson]);
        }
    });
}

// v33c: FIX BUG-RB1 - Decremento atomico de usos_totais via SQL
async function decrementarUsoKey(oauthKey) {
    const result = await _query(
        'UPDATE keys_info SET usos_totais = usos_totais - 1 WHERE key = $1 AND usos_totais > 0 RETURNING usos_totais',
        [oauthKey]
    );
    // Atualizar cache
    if (result.length > 0 && _cache.keys) {
        const idx = _cache.keys.findIndex(k => k.key === oauthKey);
        if (idx >= 0) _cache.keys[idx].usos_totais = result[0].usos_totais;
    }
    return result.length > 0;
}

function deletarKey(keyName) {
    if (_cache.keys) _cache.keys = _cache.keys.filter(k => k.key !== keyName);
    _exec('DELETE FROM keys_info WHERE key = $1', [keyName]);
}

// User Keys

function carregarUserKeys() {
    if (_cache.userKeys) return { ..._cache.userKeys };
    return {};
}

function _carregarUserKeysAsync() {
    return _query('SELECT * FROM user_keys').then(rows => {
        const result = {};
        for (const row of rows) {
            const tid = row.telegram_user_id;
            if (!result[tid]) result[tid] = [];
            result[tid].push(row.key_name);
        }
        _cache.userKeys = result;
        return result;
    });
}

function salvarUserKeysAll(userKeysDict) {
    _cache.userKeys = { ...userKeysDict };
    _transaction(async (client) => {
        await client.query('DELETE FROM user_keys');
        for (const [tid, keys] of Object.entries(userKeysDict)) {
            for (const kn of keys) {
                await client.query('INSERT INTO user_keys (telegram_user_id, key_name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [String(tid), kn]);
            }
        }
    });
}

function adicionarUserKey(telegramUserId, keyName) {
    if (!_cache.userKeys) _cache.userKeys = {};
    if (!_cache.userKeys[String(telegramUserId)]) _cache.userKeys[String(telegramUserId)] = [];
    if (!_cache.userKeys[String(telegramUserId)].includes(keyName)) _cache.userKeys[String(telegramUserId)].push(keyName);
    _exec('INSERT INTO user_keys (telegram_user_id, key_name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [String(telegramUserId), keyName]);
}

function salvarUserKey(telegramUserId, keyName) {
    adicionarUserKey(telegramUserId, keyName);
}

function removerUserKey(telegramUserId, keyName) {
    if (_cache.userKeys && _cache.userKeys[String(telegramUserId)]) {
        _cache.userKeys[String(telegramUserId)] = _cache.userKeys[String(telegramUserId)].filter(k => k !== keyName);
    }
    _exec('DELETE FROM user_keys WHERE telegram_user_id = $1 AND key_name = $2', [String(telegramUserId), keyName]);
}

// User Config

function carregarUserConfig() {
    if (_cache.userConfig) return { ..._cache.userConfig };
    return {};
}

function _carregarUserConfigAsync() {
    return _query('SELECT * FROM user_config').then(rows => {
        const result = {};
        for (const row of rows) {
            const d = { ...row }; const tid = d.telegram_user_id; delete d.telegram_user_id;
            d.auto_start = Boolean(d.auto_start); d.full_capa = Boolean(d.full_capa);
            if (d.extra_data) { try { const extra = JSON.parse(d.extra_data); if (typeof extra === 'object') Object.assign(d, extra); } catch (e) { /* */ } }
            delete d.extra_data; result[tid] = d;
        }
        _cache.userConfig = result;
        return result;
    });
}

function salvarUserConfigEntry(telegramUserId, data) {
    if (!_cache.userConfig) _cache.userConfig = {};
    _cache.userConfig[String(telegramUserId)] = { ...data };
    const known = new Set(['auto_start', 'full_capa', 'senha_fixa']);
    const extra = {}; for (const [k, v] of Object.entries(data)) { if (!known.has(k) && k !== 'extra_data') extra[k] = v; }
    const extraJson = Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;
    _exec(`INSERT INTO user_config (telegram_user_id, auto_start, full_capa, senha_fixa, extra_data) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (telegram_user_id) DO UPDATE SET auto_start=EXCLUDED.auto_start, full_capa=EXCLUDED.full_capa, senha_fixa=EXCLUDED.senha_fixa, extra_data=EXCLUDED.extra_data`,
        [String(telegramUserId), _boolToInt(data.auto_start || false), _boolToInt(data.full_capa || false), data.senha_fixa || '', extraJson]);
}

function salvarTodosUserConfig(configDict) {
    _cache.userConfig = { ...configDict };
    const known = new Set(['auto_start', 'full_capa', 'senha_fixa']);
    _transaction(async (client) => {
        await client.query('DELETE FROM user_config');
        for (const [tid, data] of Object.entries(configDict)) {
            const extra = {}; for (const [k, v] of Object.entries(data)) { if (!known.has(k) && k !== 'extra_data') extra[k] = v; }
            const extraJson = Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;
            await client.query(`INSERT INTO user_config (telegram_user_id, auto_start, full_capa, senha_fixa, extra_data) VALUES ($1,$2,$3,$4,$5)`,
                [String(tid), _boolToInt(data.auto_start || false), _boolToInt(data.full_capa || false), data.senha_fixa || '', extraJson]);
        }
    });
}

// Pagamentos

function carregarPagamentos() {
    if (!_cache.pagamentos) return { pagamentos: [] };
    const res = { ..._cache.pagamentos };
    res.pagamentos = Object.values(_cache.pagamentos);
    return res;
}

function _carregarPagamentosAsync() {
    return _query('SELECT * FROM pagamentos ORDER BY criado_em DESC').then(rows => {
        const result = {};
        for (const row of rows) {
            const d = { ...row };
            if (d.extra_data) { try { const extra = JSON.parse(d.extra_data); if (typeof extra === 'object') Object.assign(d, extra); } catch (e) { /* */ } }
            delete d.extra_data; result[d.id || ''] = d;
        }
        _cache.pagamentos = result;
        return result;
    });
}

function salvarPagamento(data) {
    if (!_cache.pagamentos) _cache.pagamentos = {};
    _cache.pagamentos[data.id || ''] = { ...data };
    const known = new Set(['id', 'user_id', 'tipo', 'quantidade', 'valor', 'status', 'criado_em', 'pago_em', 'txid', 'cpf', 'nome', 'link_pagamento', 'qrcode_imagem', 'qrcode_texto']);
    const extra = {}; for (const [k, v] of Object.entries(data)) { if (!known.has(k) && k !== 'extra_data') extra[k] = v; }
    const extraJson = Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;
    _exec(`INSERT INTO pagamentos (id, user_id, tipo, quantidade, valor, status, criado_em, pago_em, txid, cpf, nome, link_pagamento, qrcode_imagem, qrcode_texto, extra_data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        ON CONFLICT (id) DO UPDATE SET user_id=EXCLUDED.user_id, tipo=EXCLUDED.tipo, quantidade=EXCLUDED.quantidade, valor=EXCLUDED.valor, status=EXCLUDED.status, criado_em=EXCLUDED.criado_em, pago_em=EXCLUDED.pago_em, txid=EXCLUDED.txid, cpf=EXCLUDED.cpf, nome=EXCLUDED.nome, link_pagamento=EXCLUDED.link_pagamento, qrcode_imagem=EXCLUDED.qrcode_imagem, qrcode_texto=EXCLUDED.qrcode_texto, extra_data=EXCLUDED.extra_data`,
        [data.id || '', data.user_id || '', data.tipo || '', parseInt(data.quantidade || 0), parseFloat(data.valor || 0), data.status || 'PENDENTE', data.criado_em || '', data.pago_em || null, data.txid || null, data.cpf || null, data.nome || null, data.link_pagamento || null, data.qrcode_imagem || null, data.qrcode_texto || null, extraJson]);
}

function salvarTodosPagamentos(pagamentosInput) {
    let lista;
    if (typeof pagamentosInput === 'object' && !Array.isArray(pagamentosInput)) {
        lista = pagamentosInput.pagamentos || Object.values(pagamentosInput);
    } else { lista = pagamentosInput; }
    const newCache = {};
    for (const d of lista) { newCache[d.id || ''] = { ...d }; }
    _cache.pagamentos = newCache;
    const known = new Set(['id', 'user_id', 'tipo', 'quantidade', 'valor', 'status', 'criado_em', 'pago_em', 'txid', 'cpf', 'nome', 'link_pagamento', 'qrcode_imagem', 'qrcode_texto']);
    _transaction(async (client) => {
        await client.query('DELETE FROM pagamentos');
        for (const data of lista) {
            const extra = {}; for (const [k, v] of Object.entries(data)) { if (!known.has(k) && k !== 'extra_data') extra[k] = v; }
            const extraJson = Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;
            await client.query(`INSERT INTO pagamentos (id, user_id, tipo, quantidade, valor, status, criado_em, pago_em, txid, cpf, nome, link_pagamento, qrcode_imagem, qrcode_texto, extra_data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
                [data.id || '', data.user_id || '', data.tipo || '', parseInt(data.quantidade || 0), parseFloat(data.valor || 0), data.status || 'PENDENTE', data.criado_em || '', data.pago_em || null, data.txid || null, data.cpf || null, data.nome || null, data.link_pagamento || null, data.qrcode_imagem || null, data.qrcode_texto || null, extraJson]);
        }
    });
}

function deletarPagamento(pagamentoId) {
    if (_cache.pagamentos) delete _cache.pagamentos[pagamentoId];
    _exec('DELETE FROM pagamentos WHERE id = $1', [pagamentoId]);
}

function carregarPagamentosConfig() {
    if (_cache.pagamentosConfig) return { ..._cache.pagamentosConfig };
    return {};
}

function _carregarPagamentosConfigAsync() {
    return _query('SELECT chave, valor FROM pagamentos_config').then(rows => {
        const result = {};
        for (const row of rows) { try { result[row.chave] = JSON.parse(row.valor); } catch (e) { result[row.chave] = row.valor; } }
        _cache.pagamentosConfig = result;
        return result;
    });
}

function salvarPagamentosConfig(dados) {
    _cache.pagamentosConfig = { ...dados };
    _transaction(async (client) => {
        await client.query('DELETE FROM pagamentos_config');
        for (const [chave, valor] of Object.entries(dados)) {
            await client.query('INSERT INTO pagamentos_config (chave, valor) VALUES ($1, $2)', [chave, JSON.stringify(valor)]);
        }
    });
}

// Admin Sessions

function carregarAdminSessions() {
    if (_cache.adminSessions) return { ..._cache.adminSessions };
    return {};
}

function _carregarAdminSessionsAsync() {
    return _query('SELECT * FROM admin_sessions').then(rows => {
        const result = {};
        for (const row of rows) {
            const d = { ...row };
            if (d.extra_data) { try { const extra = JSON.parse(d.extra_data); if (typeof extra === 'object') Object.assign(d, extra); } catch (e) { /* */ } }
            delete d.extra_data; result[d.user_id] = d;
        }
        _cache.adminSessions = result;
        return result;
    });
}

function salvarAdminSession(userId, data) {
    if (!_cache.adminSessions) _cache.adminSessions = {};
    _cache.adminSessions[String(userId)] = { ...data, user_id: String(userId) };
    const known = new Set(['user_id', 'username', 'avatar', 'email', 'session_token', 'csrf_token', 'ultimo_acesso']);
    const extra = {}; for (const [k, v] of Object.entries(data)) { if (!known.has(k) && k !== 'extra_data') extra[k] = v; }
    const extraJson = Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;
    _exec(`INSERT INTO admin_sessions (user_id, username, avatar, email, session_token, csrf_token, ultimo_acesso, extra_data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (user_id) DO UPDATE SET username=EXCLUDED.username, avatar=EXCLUDED.avatar, email=EXCLUDED.email, session_token=EXCLUDED.session_token, csrf_token=EXCLUDED.csrf_token, ultimo_acesso=EXCLUDED.ultimo_acesso, extra_data=EXCLUDED.extra_data`,
        [String(userId), data.username || '', data.avatar || '', data.email || '', data.session_token || '', data.csrf_token || '', data.ultimo_acesso || '', extraJson]);
}

function salvarTodosAdminSessions(sessionsDict) {
    _cache.adminSessions = { ...sessionsDict };
    const known = new Set(['user_id', 'username', 'avatar', 'email', 'session_token', 'csrf_token', 'ultimo_acesso']);
    _transaction(async (client) => {
        await client.query('DELETE FROM admin_sessions');
        for (const [uid, data] of Object.entries(sessionsDict)) {
            const extra = {}; for (const [k, v] of Object.entries(data)) { if (!known.has(k) && k !== 'extra_data') extra[k] = v; }
            const extraJson = Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;
            await client.query(`INSERT INTO admin_sessions (user_id, username, avatar, email, session_token, csrf_token, ultimo_acesso, extra_data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                [String(uid), data.username || '', data.avatar || '', data.email || '', data.session_token || '', data.csrf_token || '', data.ultimo_acesso || '', extraJson]);
        }
    });
}

// Admins Dashboard

function carregarAdminsDashboard() {
    if (_cache.adminsDashboard) return { ..._cache.adminsDashboard };
    return {};
}

function _carregarAdminsDashboardAsync() {
    return _query('SELECT * FROM admins_dashboard').then(rows => {
        const result = {};
        for (const row of rows) result[row.user_id] = { ...row };
        _cache.adminsDashboard = result;
        return result;
    });
}

function salvarAdminDashboard(userId, data) {
    if (!_cache.adminsDashboard) _cache.adminsDashboard = {};
    _cache.adminsDashboard[String(userId)] = { ...data, user_id: String(userId) };
    _exec(`INSERT INTO admins_dashboard (user_id, adicionado_em, cargo) VALUES ($1,$2,$3)
        ON CONFLICT (user_id) DO UPDATE SET adicionado_em=EXCLUDED.adicionado_em, cargo=EXCLUDED.cargo`,
        [String(userId), data.adicionado_em || '', data.cargo || 'admin']);
}

function salvarTodosAdminsDashboard(adminsDict) {
    _cache.adminsDashboard = { ...adminsDict };
    _transaction(async (client) => {
        await client.query('DELETE FROM admins_dashboard');
        for (const [did, data] of Object.entries(adminsDict)) {
            await client.query(`INSERT INTO admins_dashboard (user_id, adicionado_em, cargo) VALUES ($1,$2,$3)`,
                [String(did), data.adicionado_em || '', data.cargo || 'admin']);
        }
    });
}

function deletarAdminDashboard(userId) {
    if (_cache.adminsDashboard) delete _cache.adminsDashboard[String(userId)];
    _exec('DELETE FROM admins_dashboard WHERE user_id = $1', [String(userId)]);
}

// Admin Session Store

function carregarAdminSessionStore() {
    if (_cache.adminSessionStore) return { ..._cache.adminSessionStore };
    return {};
}

function _carregarAdminSessionStoreAsync() {
    return _query('SELECT session_hash, data FROM admin_session_store').then(rows => {
        const result = {};
        for (const row of rows) { try { result[row.session_hash] = JSON.parse(row.data); } catch (e) { result[row.session_hash] = row.data; } }
        _cache.adminSessionStore = result;
        return result;
    });
}

function salvarAdminSessionStore(dados) {
    _cache.adminSessionStore = { ...dados };
    _transaction(async (client) => {
        await client.query('DELETE FROM admin_session_store');
        for (const [key, val] of Object.entries(dados)) {
            await client.query('INSERT INTO admin_session_store (session_hash, data) VALUES ($1, $2)', [key, JSON.stringify(val)]);
        }
    });
}

function salvarAdminSessionStoreEntry(sessionHash, data) {
    if (!_cache.adminSessionStore) _cache.adminSessionStore = {};
    _cache.adminSessionStore[sessionHash] = data;
    _exec('INSERT INTO admin_session_store (session_hash, data) VALUES ($1, $2) ON CONFLICT (session_hash) DO UPDATE SET data=EXCLUDED.data', [sessionHash, JSON.stringify(data)]);
}

function deletarAdminSessionStoreEntry(sessionHash) {
    if (_cache.adminSessionStore) delete _cache.adminSessionStore[sessionHash];
    _exec('DELETE FROM admin_session_store WHERE session_hash = $1', [sessionHash]);
}

// Transmissoes

function carregarTransmissoes() {
    if (_cache.transmissoes) return { ..._cache.transmissoes };
    return {};
}

function _carregarTransmissoesAsync() {
    return _query('SELECT * FROM transmissoes ORDER BY criada_em DESC').then(rows => {
        const result = {};
        for (const row of rows) {
            const d = { ...row };
            if (d.fotos) { try { d.fotos = JSON.parse(d.fotos); } catch (e) { /* */ } }
            result[d.id || ''] = d;
        }
        _cache.transmissoes = result;
        return result;
    });
}

function salvarTransmissao(data) {
    if (!_cache.transmissoes) _cache.transmissoes = {};
    _cache.transmissoes[data.id || ''] = { ...data };
    let fotos = data.fotos;
    if (typeof fotos === 'object' && fotos !== null) fotos = JSON.stringify(fotos);
    _exec(`INSERT INTO transmissoes (id, admin_user_id, admin_username, criada_em, duracao_segundos, enviados, erros, finalizada_em, fotos, media_por_segundo, mensagem, status, total_usuarios) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (id) DO UPDATE SET admin_user_id=EXCLUDED.admin_user_id, admin_username=EXCLUDED.admin_username, criada_em=EXCLUDED.criada_em, duracao_segundos=EXCLUDED.duracao_segundos, enviados=EXCLUDED.enviados, erros=EXCLUDED.erros, finalizada_em=EXCLUDED.finalizada_em, fotos=EXCLUDED.fotos, media_por_segundo=EXCLUDED.media_por_segundo, mensagem=EXCLUDED.mensagem, status=EXCLUDED.status, total_usuarios=EXCLUDED.total_usuarios`,
        [data.id || '', data.admin_user_id || '', data.admin_username || '', data.criada_em || '', data.duracao_segundos || null, parseInt(data.enviados || 0), parseInt(data.erros || 0), data.finalizada_em || null, fotos || null, data.media_por_segundo || null, data.mensagem || '', data.status || 'enviando', parseInt(data.total_usuarios || 0)]);
}

function salvarTodasTransmissoes(transmissoesInput) {
    let lista;
    if (typeof transmissoesInput === 'object' && !Array.isArray(transmissoesInput)) {
        lista = transmissoesInput.transmissoes || Object.values(transmissoesInput);
    } else { lista = transmissoesInput; }
    const newCache = {};
    for (const d of lista) { newCache[d.id || ''] = { ...d }; }
    _cache.transmissoes = newCache;
    _transaction(async (client) => {
        await client.query('DELETE FROM transmissoes');
        for (const data of lista) {
            let fotos = data.fotos;
            if (typeof fotos === 'object' && fotos !== null) fotos = JSON.stringify(fotos);
            await client.query(`INSERT INTO transmissoes (id, admin_user_id, admin_username, criada_em, duracao_segundos, enviados, erros, finalizada_em, fotos, media_por_segundo, mensagem, status, total_usuarios) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
                [data.id || '', data.admin_user_id || '', data.admin_username || '', data.criada_em || '', data.duracao_segundos || null, parseInt(data.enviados || 0), parseInt(data.erros || 0), data.finalizada_em || null, fotos || null, data.media_por_segundo || null, data.mensagem || '', data.status || 'enviando', parseInt(data.total_usuarios || 0)]);
        }
    });
}

// Telegram VIPs

function carregarTelegramVips() {
    if (_cache.telegramVips) return { ..._cache.telegramVips };
    return {};
}

function _carregarTelegramVipsAsync() {
    return _query('SELECT * FROM telegram_vips').then(rows => {
        const result = {};
        for (const row of rows) result[row.user_id] = { ...row };
        _cache.telegramVips = result;
        return result;
    });
}

function salvarTelegramVip(userId, data) {
    if (!_cache.telegramVips) _cache.telegramVips = {};
    _cache.telegramVips[String(userId)] = { ...data, user_id: String(userId) };
    _exec(`INSERT INTO telegram_vips (user_id, adicionado_em, expira_em, tipo) VALUES ($1,$2,$3,$4)
        ON CONFLICT (user_id) DO UPDATE SET adicionado_em=EXCLUDED.adicionado_em, expira_em=EXCLUDED.expira_em, tipo=EXCLUDED.tipo`,
        [String(userId), data.adicionado_em || '', data.expira_em || null, data.tipo || 'permanente']);
}

function salvarTodosTelegramVips(vipsDict) {
    _cache.telegramVips = { ...vipsDict };
    _transaction(async (client) => {
        await client.query('DELETE FROM telegram_vips');
        for (const [did, data] of Object.entries(vipsDict)) {
            await client.query(`INSERT INTO telegram_vips (user_id, adicionado_em, expira_em, tipo) VALUES ($1,$2,$3,$4)`,
                [String(did), data.adicionado_em || '', data.expira_em || null, data.tipo || 'permanente']);
        }
    });
}

function deletarTelegramVip(userId) {
    if (_cache.telegramVips) delete _cache.telegramVips[String(userId)];
    _exec('DELETE FROM telegram_vips WHERE user_id = $1', [String(userId)]);
}

function carregarTelegramVipsConfig() {
    if (_cache.telegramVipsConfig) return { ..._cache.telegramVipsConfig };
    return {};
}

function _carregarTelegramVipsConfigAsync() {
    return _query('SELECT chave, valor FROM telegram_vips_config').then(rows => {
        const result = {};
        for (const row of rows) { try { result[row.chave] = JSON.parse(row.valor); } catch (e) { result[row.chave] = row.valor; } }
        _cache.telegramVipsConfig = result;
        return result;
    });
}

function salvarTelegramVipsConfig(dados) {
    _cache.telegramVipsConfig = { ...dados };
    _transaction(async (client) => {
        await client.query('DELETE FROM telegram_vips_config');
        for (const [chave, valor] of Object.entries(dados)) {
            await client.query('INSERT INTO telegram_vips_config (chave, valor) VALUES ($1, $2)', [chave, JSON.stringify(valor)]);
        }
    });
}

// Info Accounts

function carregarInfoAccounts() {
    if (_cache.infoAccounts) return { ..._cache.infoAccounts };
    return {};
}

function _carregarInfoAccountsAsync() {
    return _query('SELECT * FROM info_accounts').then(rows => {
        const result = {};
        for (const row of rows) {
            const d = { ...row }; d.invalidado = Boolean(d.invalidado); result[d.uid] = d;
        }
        _cache.infoAccounts = result;
        return result;
    });
}

function salvarInfoAccount(uid, data) {
    if (!_cache.infoAccounts) _cache.infoAccounts = {};
    _cache.infoAccounts[String(uid)] = { ...data, uid: String(uid), invalidado: Boolean(data.invalidado) };
    _exec(`INSERT INTO info_accounts (uid, password, "accessToken", "openID", invalidado) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (uid) DO UPDATE SET password=EXCLUDED.password, "accessToken"=EXCLUDED."accessToken", "openID"=EXCLUDED."openID", invalidado=EXCLUDED.invalidado`,
        [String(uid), data.password || '', data.accessToken || '', data.openID || '', _boolToInt(data.invalidado || false)]);
}

function deletarInfoAccount(uid) {
    if (_cache.infoAccounts) delete _cache.infoAccounts[String(uid)];
    _exec('DELETE FROM info_accounts WHERE uid = $1', [String(uid)]);
}

function salvarTodosInfoAccounts(accountsDict) {
    if (!_cache.infoAccounts) _cache.infoAccounts = {};
    for (const [uid, data] of Object.entries(accountsDict)) {
        _cache.infoAccounts[String(uid)] = { ...data, uid: String(uid), invalidado: Boolean(data.invalidado) };
    }
    _transaction(async (client) => {
        for (const [uid, data] of Object.entries(accountsDict)) {
            await client.query(`INSERT INTO info_accounts (uid, password, "accessToken", "openID", invalidado) VALUES ($1,$2,$3,$4,$5)
                ON CONFLICT (uid) DO UPDATE SET password=EXCLUDED.password, "accessToken"=EXCLUDED."accessToken", "openID"=EXCLUDED."openID", invalidado=EXCLUDED.invalidado`,
                [String(uid), data.password || '', data.accessToken || '', data.openID || '', _boolToInt(data.invalidado || false)]);
        }
    });
}

function invalidarInfoAccount(uid) {
    if (_cache.infoAccounts && _cache.infoAccounts[String(uid)]) {
        _cache.infoAccounts[String(uid)].invalidado = true;
    }
    _exec('UPDATE info_accounts SET invalidado = 1 WHERE uid = $1', [String(uid)]);
}

function obterInfoAccount(uid) {
    if (_cache.infoAccounts) {
        const acc = _cache.infoAccounts[String(uid)];
        if (acc && !acc.invalidado) return { ...acc };
        return null;
    }
    return null;
}

// Avisos

function carregarAvisos() {
    if (_cache.avisos) return { avisos: [..._cache.avisos] };
    return { avisos: [] };
}

function _carregarAvisosAsync() {
    return _query('SELECT * FROM avisos ORDER BY criado_em DESC').then(rows => {
        const result = [];
        for (const row of rows) {
            const d = { ...row };
            if (d.extra_data) { try { const extra = JSON.parse(d.extra_data); if (typeof extra === 'object') Object.assign(d, extra); } catch (e) { /* */ } }
            delete d.extra_data; result.push(d);
        }
        _cache.avisos = result;
        return { avisos: result };
    });
}

function salvarAvisos(avisosInput) {
    const lista = Array.isArray(avisosInput) ? avisosInput : (avisosInput.avisos || []);
    _cache.avisos = [...lista];
    const known = new Set(['id', 'titulo', 'conteudo', 'imagem', 'criado_em']);
    _transaction(async (client) => {
        await client.query('DELETE FROM avisos');
        for (const a of lista) {
            const extra = {}; for (const [k, v] of Object.entries(a)) { if (!known.has(k) && k !== 'extra_data') extra[k] = v; }
            const extraJson = Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;
            await client.query(`INSERT INTO avisos (id, titulo, conteudo, imagem, criado_em, extra_data) VALUES ($1,$2,$3,$4,$5,$6)`,
                [a.id || '', a.titulo || '', a.conteudo || '', a.imagem || null, a.criado_em || '', extraJson]);
        }
    });
}

const CarregarAvisosMap = carregarAvisos;
const SalvarAvisosMap = salvarAvisos;

// Fornecedores, Info Admin (KV tables)

function _carregarKvTableAsync(tableName, pkCol, dataCol) {
    return _query(`SELECT ${pkCol}, ${dataCol} FROM ${tableName}`).then(rows => {
        const result = {};
        for (const row of rows) {
            try { result[row[pkCol]] = JSON.parse(row[dataCol]); } catch (e) { result[row[pkCol]] = row[dataCol]; }
        }
        return result;
    });
}

function _salvarKvTable(tableName, pkCol, dataCol, dados, cacheKey) {
    _cache[cacheKey] = { ...dados };
    _transaction(async (client) => {
        await client.query(`DELETE FROM ${tableName}`);
        for (const [key, val] of Object.entries(dados)) {
            const valStr = typeof val === 'string' ? val : JSON.stringify(val);
            await client.query(`INSERT INTO ${tableName} (${pkCol}, ${dataCol}) VALUES ($1, $2)`, [String(key), valStr]);
        }
    });
}

function carregarFornecedores() {
    if (_cache.fornecedores) return { ..._cache.fornecedores };
    return {};
}
function _carregarFornecedoresAsync() { return _carregarKvTableAsync('fornecedores', 'chave', 'valor').then(r => { _cache.fornecedores = r; return r; }); }
function salvarFornecedores(dados) { _salvarKvTable('fornecedores', 'chave', 'valor', dados, 'fornecedores'); }

function carregarInfoAdmin() {
    if (_cache.infoAdmin) return { ..._cache.infoAdmin };
    return {};
}
function _carregarInfoAdminAsync() { return _carregarKvTableAsync('info_admin', 'chave', 'valor').then(r => { _cache.infoAdmin = r; return r; }); }
function salvarInfoAdmin(dados) { _salvarKvTable('info_admin', 'chave', 'valor', dados, 'infoAdmin'); }

// Partner Keys
function carregarPartnerKeys() {
    if (_cache.partnerKeys) {
        const agora = Date.now();
        for (const key of Object.keys(_cache.partnerKeys)) {
            const k = _cache.partnerKeys[key];
            if (k.sem_desconto === true && k.sem_desconto_expira) {
                const expiraEm = new Date(k.sem_desconto_expira).getTime();
                if (agora > expiraEm) {
                    k.sem_desconto = false;
                    k.sem_desconto_expirou = true;
                    k.sem_desconto_expira = null;
                    
                    const known = new Set(['key', 'nome', 'ativa', 'criada_em']);
                    const extra = {};
                    for (const [keyName, v] of Object.entries(k)) {
                        if (!known.has(keyName) && keyName !== 'extra_data') extra[keyName] = v;
                    }
                    const extraJson = Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;
                    _exec(`INSERT INTO partner_keys (key, nome, ativa, criada_em, extra_data) VALUES ($1,$2,$3,$4,$5)
                        ON CONFLICT (key) DO UPDATE SET nome=EXCLUDED.nome, ativa=EXCLUDED.ativa, criada_em=EXCLUDED.criada_em, extra_data=EXCLUDED.extra_data`,
                        [k.key, k.nome || '', _boolToInt(k.ativa !== undefined ? k.ativa : true), k.criada_em || new Date().toISOString().replace('T', ' ').slice(0, 19), extraJson]);
                }
            }
        }
        return { ..._cache.partnerKeys };
    }
    return {};
}

function _carregarPartnerKeysAsync() {
    return _query('SELECT * FROM partner_keys').then(rows => {
        const result = {};
        for (const row of rows) {
            const d = { ...row };
            d.ativa = Boolean(d.ativa);
            if (d.extra_data) {
                try {
                    const extra = JSON.parse(d.extra_data);
                    if (typeof extra === 'object') Object.assign(d, extra);
                } catch (e) { /* ignore */ }
            }
            delete d.extra_data;
            result[d.key] = d;
        }
        _cache.partnerKeys = result;
        return result;
    });
}

function salvarPartnerKey(data) {
    if (!_cache.partnerKeys) _cache.partnerKeys = {};
    _cache.partnerKeys[data.key] = { ...data, ativa: Boolean(data.ativa !== undefined ? data.ativa : true) };
    const known = new Set(['key', 'nome', 'ativa', 'criada_em']);
    const extra = {};
    for (const [k, v] of Object.entries(data)) {
        if (!known.has(k) && k !== 'extra_data') extra[k] = v;
    }
    const extraJson = Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;
    _exec(`INSERT INTO partner_keys (key, nome, ativa, criada_em, extra_data) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (key) DO UPDATE SET nome=EXCLUDED.nome, ativa=EXCLUDED.ativa, criada_em=EXCLUDED.criada_em, extra_data=EXCLUDED.extra_data`,
        [data.key, data.nome || '', _boolToInt(data.ativa !== undefined ? data.ativa : true), data.criada_em || new Date().toISOString().replace('T', ' ').slice(0, 19), extraJson]);
}

function deletarPartnerKey(key) {
    if (_cache.partnerKeys) delete _cache.partnerKeys[key];
    _exec('DELETE FROM partner_keys WHERE key = $1', [key]);
}

function carregarAdminSessionStore() {
    if (_cache.adminSessionStore) return { ..._cache.adminSessionStore };
    return {};
}

// User Bot Info

function carregarUserBotInfo() {
    if (_cache.userBotInfo) return { ..._cache.userBotInfo };
    return {};
}

function _carregarUserBotInfoAsync() {
    return _query('SELECT user_id, data FROM user_bot_info').then(rows => {
        const result = {};
        for (const row of rows) { try { result[row.user_id] = JSON.parse(row.data); } catch (e) { result[row.user_id] = row.data; } }
        _cache.userBotInfo = result;
        return result;
    });
}

function salvarUserBotInfo(dados) {
    _cache.userBotInfo = { ...dados };
    _transaction(async (client) => {
        await client.query('DELETE FROM user_bot_info');
        for (const [uid, data] of Object.entries(dados)) {
            await client.query('INSERT INTO user_bot_info (user_id, data) VALUES ($1, $2)', [String(uid), JSON.stringify(data)]);
        }
    });
}

function salvarUserBotInfoEntry(userId, data) {
    if (!_cache.userBotInfo) _cache.userBotInfo = {};
    _cache.userBotInfo[String(userId)] = data;
    _exec('INSERT INTO user_bot_info (user_id, data) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET data=EXCLUDED.data', [String(userId), JSON.stringify(data)]);
}

// Users Bot

function carregarUsersBot() {
    if (_cache.usersBot) return { ..._cache.usersBot };
    return {};
}

function _carregarUsersBotAsync() {
    return _query('SELECT * FROM users_bot').then(rows => {
        const result = {};
        for (const row of rows) {
            const d = { ...row }; const uid = d.user_id; delete d.user_id; d.id = uid;
            if (d.extra_data) { try { const extra = JSON.parse(d.extra_data); if (typeof extra === 'object') Object.assign(d, extra); } catch (e) { /* */ } }
            delete d.extra_data; result[uid] = d;
        }
        _cache.usersBot = result;
        return result;
    });
}

function salvarUsersBot(dados) {
    _cache.usersBot = { ...dados };
    const known = new Set(['id', 'first_name', 'username', 'registrado_em', 'ultimo_uso']);
    _transaction(async (client) => {
        await client.query('DELETE FROM users_bot');
        for (const [uid, data] of Object.entries(dados)) {
            const extra = {}; for (const [k, v] of Object.entries(data)) { if (!known.has(k) && k !== 'extra_data') extra[k] = v; }
            const extraJson = Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;
            await client.query(`INSERT INTO users_bot (user_id, first_name, username, registrado_em, ultimo_uso, extra_data) VALUES ($1,$2,$3,$4,$5,$6)`,
                [String(uid), data.first_name || '', data.username || '', data.registrado_em || '', data.ultimo_uso || '', extraJson]);
        }
    });
}

function salvarUserBotEntry(userId, data) {
    if (!_cache.usersBot) _cache.usersBot = {};
    _cache.usersBot[String(userId)] = { ...data };
    const known = new Set(['id', 'first_name', 'username', 'registrado_em', 'ultimo_uso']);
    const extra = {}; for (const [k, v] of Object.entries(data)) { if (!known.has(k) && k !== 'extra_data') extra[k] = v; }
    const extraJson = Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;
    _exec(`INSERT INTO users_bot (user_id, first_name, username, registrado_em, ultimo_uso, extra_data) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (user_id) DO UPDATE SET first_name=EXCLUDED.first_name, username=EXCLUDED.username, registrado_em=EXCLUDED.registrado_em, ultimo_uso=EXCLUDED.ultimo_uso, extra_data=EXCLUDED.extra_data`,
        [String(userId), data.first_name || '', data.username || '', data.registrado_em || '', data.ultimo_uso || '', extraJson]);
}

// Cache Loader - carrega tudo do banco para o cache na inicializacao

async function carregarCacheCompleto() {
    console.log('[DB-PG] Carregando cache completo do banco...');
    const start = Date.now();
    await Promise.all([
        _carregarTodasSalasAsync(),
        _carregarStatsAsync(),
        _carregarRoomAccountsAsync(),
        _carregarUsuariosAsync(),
        _carregarSessoesAsync(),
        _carregarSaldosAsync(),
        _carregarKeysInfoAsync(),
        _carregarUserKeysAsync(),
        _carregarUserConfigAsync(),
        _carregarPagamentosAsync(),
        _carregarPagamentosConfigAsync(),
        _carregarAdminSessionsAsync(),
        _carregarAdminsDashboardAsync(),
        _carregarAdminSessionStoreAsync(),
        _carregarTransmissoesAsync(),
        _carregarTelegramVipsAsync(),
        _carregarTelegramVipsConfigAsync(),
        _carregarInfoAccountsAsync(),
        _carregarAvisosAsync(),
        _carregarFornecedoresAsync(),
        _carregarInfoAdminAsync(),
        _carregarUserBotInfoAsync(),
        _carregarUsersBotAsync(),
        _carregarPartnerKeysAsync(),
    ]);
    const elapsed = Date.now() - start;
    console.log(`[DB-PG] Cache carregado em ${elapsed}ms`);
}

function carregarConfigGeral() {
    try {
        const configManager = require('./config_manager');
        configManager.carregarConfig();
        return configManager.getAll();
    } catch (e) {
        return {};
    }
}

function salvarConfigGeral(dados) {
    try {
        const configManager = require('./config_manager');
        configManager.setValues(dados);
    } catch (e) {
        console.error('[DB-PG] Erro ao salvar config geral:', e);
    }
}

function salvarTodosUsuarios(usuariosInput) {
    const listaUsuarios = Array.isArray(usuariosInput) ? usuariosInput : (usuariosInput.usuarios || []);
    const newCache = {};
    for (const u of listaUsuarios) { if (u && u.user_id) newCache[u.user_id] = { ...u }; }
    _cache.usuarios = newCache;
    _transaction(async (client) => {
        await client.query('DELETE FROM usuarios');
        for (const u of listaUsuarios) {
            if (!u || !u.user_id) continue;
            await client.query(`INSERT INTO usuarios (user_id, username, avatar, primeiro_login, total_logins, ultimo_login) VALUES ($1,$2,$3,$4,$5,$6)`,
                [String(u.user_id), u.username || '', u.avatar || '', u.primeiro_login || '', parseInt(u.total_logins || 0), u.ultimo_login || '']);
        }
    });
}

// Fechar pool

async function fecharPool() {
    if (pool) {
        await pool.end();
        pool = null;
        _initialized = false;
    }
}

// Exports

module.exports = {
    inicializarSchema,
    carregarCacheCompleto,
    fecharPool,
    carregarConfigGeral,
    salvarConfigGeral,
    carregarAvisosMap: carregarAvisos,
    salvarAvisosMap: salvarAvisos,
    salvarAdminsDashboard: salvarTodosAdminsDashboard,
    salvarPagamentos: salvarTodosPagamentos,
    salvarSessoes: salvarTodasSessoes,
    salvarUsuarios: salvarTodosUsuarios,
    salvarSaldos: salvarTodosSaldos,
    salvarTelegramVips: salvarTodosTelegramVips,
    salvarUserConfig: salvarTodosUserConfig,
    salvarTransmissoes: salvarTodasTransmissoes,
    carregarTelegramUsers: carregarUsersBot,
    salvarUserKeys: salvarUserKeysAll,
    carregarTodasSalas, salvarSala, salvarTodasSalas, deletarSala, atualizarSalaCampos,
    carregarStats, salvarStat, salvarStats,
    carregarRoomAccounts, salvarRoomAccount, salvarTodosRoomAccounts, removerRoomAccounts,
    carregarUsuarios, salvarUsuario,
    carregarSessoes, salvarSessao, deletarSessaoPorToken, deletarSessoesPorUser, atualizarSessaoAcesso, salvarTodasSessoes,
    carregarSaldos, salvarSaldo, salvarTodosSaldos,
    carregarKeysInfo, salvarKeyInfo, salvarTodasKeys, deletarKey, decrementarUsoKey,
    carregarUserKeys, salvarUserKeysAll, adicionarUserKey, salvarUserKey, removerUserKey,
    carregarUserConfig, salvarUserConfigEntry, salvarTodosUserConfig,
    carregarPagamentos, salvarPagamento, salvarTodosPagamentos, deletarPagamento,
    carregarPagamentosConfig, salvarPagamentosConfig,
    carregarAdminSessions, salvarAdminSession, salvarTodosAdminSessions,
    carregarAdminsDashboard, salvarAdminDashboard, salvarTodosAdminsDashboard, deletarAdminDashboard,
    carregarTransmissoes, salvarTransmissao, salvarTodasTransmissoes,
    carregarTelegramVips, salvarTelegramVip, salvarTodosTelegramVips, deletarTelegramVip,
    carregarTelegramVipsConfig, salvarTelegramVipsConfig,
    carregarInfoAccounts, salvarInfoAccount, deletarInfoAccount, salvarTodosInfoAccounts, invalidarInfoAccount, obterInfoAccount,
    carregarAvisos, salvarAvisos, CarregarAvisosMap, SalvarAvisosMap,
    carregarFornecedores, salvarFornecedores,
    carregarAdminSessionStore, salvarAdminSessionStore, salvarAdminSessionStoreEntry, deletarAdminSessionStoreEntry,
    carregarInfoAdmin, salvarInfoAdmin,
    carregarUserBotInfo, salvarUserBotInfo, salvarUserBotInfoEntry,
    carregarUsersBot, salvarUsersBot, salvarUserBotEntry,
    carregarPartnerKeys, salvarPartnerKey, deletarPartnerKey,
};
