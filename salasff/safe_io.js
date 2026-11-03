/**
 * safe_io.js - I/O seguro com cache, locks e backups (conversao de safe_io.py)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const _BASE_DIR = __dirname;
const LOCK_DIR = path.join(_BASE_DIR, '.locks');
const BACKUP_DIR = path.join(_BASE_DIR, 'backups');
const ENV_FILE = path.join(_BASE_DIR, '.env');

let _backupTimer = null;
let _backupRodando = false;

fs.mkdirSync(LOCK_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const _jsonCache = new Map();
const _JSON_CACHE_MAX = 50;

function _agoraBr() {
    const now = new Date();
    const offset = -3 * 60;
    const local = new Date(now.getTime() + offset * 60 * 1000);
    const y = local.getUTCFullYear();
    const m = String(local.getUTCMonth() + 1).padStart(2, '0');
    const d = String(local.getUTCDate()).padStart(2, '0');
    const h = String(local.getUTCHours()).padStart(2, '0');
    const min = String(local.getUTCMinutes()).padStart(2, '0');
    const s = String(local.getUTCSeconds()).padStart(2, '0');
    return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

function carregarJsonSeguro(caminho) {
    if (!fs.existsSync(caminho)) return null;
    try {
        const stat = fs.statSync(caminho);
        const mtime = stat.mtimeMs;
        const cached = _jsonCache.get(caminho);
        if (cached && cached[0] === mtime) {
            return cached[1];
        }
    } catch (e) { /* ignore */ }
    try {
        const conteudo = fs.readFileSync(caminho, 'utf-8');
        const dados = JSON.parse(conteudo);
        try {
            const mtime = fs.statSync(caminho).mtimeMs;
            if (_jsonCache.size >= _JSON_CACHE_MAX) {
                const oldest = _jsonCache.keys().next().value;
                _jsonCache.delete(oldest);
            }
            _jsonCache.set(caminho, [mtime, dados]);
        } catch (e) { /* ignore */ }
        return dados;
    } catch (e) { /* ignore */ }
    const bak = caminho + '.bak';
    if (fs.existsSync(bak)) {
        try {
            return JSON.parse(fs.readFileSync(bak, 'utf-8'));
        } catch (e) { /* ignore */ }
    }
    return null;
}

function salvarJsonSeguro(caminho, dados, raiseOnError = false) {
    const pasta = path.dirname(caminho);
    if (pasta) fs.mkdirSync(pasta, { recursive: true });

    let conteudo;
    try {
        conteudo = JSON.stringify(dados, null, 2);
    } catch (e) {
        if (raiseOnError) throw e;
        return false;
    }

    let tmpPath = null;
    try {
        if (fs.existsSync(caminho)) {
            try { fs.copyFileSync(caminho, caminho + '.bak'); } catch (e) { /* ignore */ }
        }
        tmpPath = path.join(pasta, `.tmp_${crypto.randomBytes(8).toString('hex')}`);
        fs.writeFileSync(tmpPath, conteudo, 'utf-8');
        fs.renameSync(tmpPath, caminho);
        _jsonCache.delete(caminho);
        return true;
    } catch (e) {
        if (tmpPath && fs.existsSync(tmpPath)) {
            try { fs.unlinkSync(tmpPath); } catch (e2) { /* ignore */ }
        }
        if (raiseOnError) throw e;
        return false;
    }
}

/**
 * FileLock - Lock baseado em arquivo usando fs.open com flag 'wx' (exclusivo).
 * Nota: Node.js nao tem fcntl nativo. Usamos mkdir atomico como lock.
 */
class FileLock {
    constructor(nome) {
        this._path = path.join(LOCK_DIR, nome + '.lock');
        this._acquired = false;
    }

    acquire(timeout = 10) {
        const inicio = Date.now();
        while (true) {
            try {
                fs.mkdirSync(this._path);
                this._acquired = true;
                return true;
            } catch (e) {
                if (Date.now() - inicio >= timeout * 1000) {
                    return false;
                }
                // busy wait 100ms
                const start = Date.now();
                while (Date.now() - start < 100) { /* spin */ }
            }
        }
    }

    release() {
        if (this._acquired) {
            try { fs.rmdirSync(this._path); } catch (e) { /* ignore */ }
            this._acquired = false;
        }
    }
}

function _coletarJsons(baseDir) {
    const arquivos = [];
    const ignorar = new Set(['.locks', 'backups', '.cache', '__pycache__', 'node_modules', '.git']);

    function walk(dir) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (!ignorar.has(entry.name)) {
                    walk(path.join(dir, entry.name));
                }
            } else if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.tmp') && !entry.name.endsWith('.bak')) {
                arquivos.push(path.join(dir, entry.name));
            }
        }
    }
    walk(baseDir);
    return arquivos;
}

function executarBackup(baseDir = null, dryRun = false) {
    if (!baseDir) baseDir = _BASE_DIR;

    const agora = new Date();
    const offset = -3 * 60;
    const local = new Date(agora.getTime() + offset * 60 * 1000);
    const y = local.getUTCFullYear();
    const m = String(local.getUTCMonth() + 1).padStart(2, '0');
    const d = String(local.getUTCDate()).padStart(2, '0');
    const h = String(local.getUTCHours()).padStart(2, '0');
    const min = String(local.getUTCMinutes()).padStart(2, '0');
    const s = String(local.getUTCSeconds()).padStart(2, '0');
    const nomeBackup = `backup_${y}${m}${d}_${h}${min}${s}`;
    const destino = path.join(BACKUP_DIR, nomeBackup);

    const arquivos = _coletarJsons(baseDir);
    if (!arquivos.length) return { status: 'vazio', arquivos: 0 };
    if (dryRun) return { status: 'dry_run', arquivos: arquivos.length, destino };

    const lock = new FileLock('backup_global');
    if (!lock.acquire(30)) return { status: 'lock_falhou' };

    const tmpDir = destino + '_tmp';
    try {
        fs.mkdirSync(tmpDir, { recursive: true });
        let copiados = 0;

        for (const arq of arquivos) {
            const rel = path.relative(baseDir, arq);
            const partes = rel.split(path.sep);
            if (partes.some(p => p.startsWith('.'))) continue;

            const destArq = path.join(tmpDir, rel);
            fs.mkdirSync(path.dirname(destArq), { recursive: true });

            try {
                JSON.parse(fs.readFileSync(arq, 'utf-8'));
                fs.copyFileSync(arq, destArq);
                copiados++;
            } catch (e) { /* skip invalid */ }
        }

        if (copiados > 0) {
            fs.renameSync(tmpDir, destino);
        } else {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* */ }
            return { status: 'nenhum_valido', arquivos: 0 };
        }

        _limparBackupsAntigos();
        return { status: 'ok', arquivos: copiados, destino };
    } catch (e) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e2) { /* */ }
        return { status: 'erro', msg: e.message };
    } finally {
        lock.release();
    }
}

function _limparBackupsAntigos(manter = 5) {
    try {
        const backups = fs.readdirSync(BACKUP_DIR)
            .filter(d => {
                const fullPath = path.join(BACKUP_DIR, d);
                return fs.statSync(fullPath).isDirectory() && d.startsWith('backup_');
            })
            .sort();
        while (backups.length > manter) {
            const antigo = backups.shift();
            try { fs.rmSync(path.join(BACKUP_DIR, antigo), { recursive: true, force: true }); } catch (e) { /* */ }
        }
    } catch (e) { /* ignore */ }
}

function iniciarBackupAutomatico() {
    if (_backupTimer) return;
    _backupRodando = true;
    _backupTimer = setInterval(() => {
        if (!_backupRodando) return;
        try { executarBackup(); } catch (e) { /* ignore */ }
    }, 21600 * 1000); // 6 horas
}

function pararBackupAutomatico() {
    _backupRodando = false;
    if (_backupTimer) {
        clearInterval(_backupTimer);
        _backupTimer = null;
    }
}

function carregarOuGerarSecretKey() {
    const chaveEnv = process.env.FLASK_SECRET_KEY;
    if (chaveEnv && chaveEnv.length >= 32) return chaveEnv;

    if (fs.existsSync(ENV_FILE)) {
        try {
            const linhas = fs.readFileSync(ENV_FILE, 'utf-8').split('\n');
            for (const linha of linhas) {
                const trimmed = linha.trim();
                if (trimmed.startsWith('FLASK_SECRET_KEY=')) {
                    let valor = trimmed.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
                    if (valor.length >= 32) {
                        process.env.FLASK_SECRET_KEY = valor;
                        return valor;
                    }
                }
            }
        } catch (e) { /* ignore */ }
    }

    const nova = crypto.randomBytes(48).toString('base64url');

    try {
        let existentes = [];
        if (fs.existsSync(ENV_FILE)) {
            existentes = fs.readFileSync(ENV_FILE, 'utf-8').split('\n')
                .filter(l => !l.trim().startsWith('FLASK_SECRET_KEY='));
        }
        existentes.push(`FLASK_SECRET_KEY="${nova}"`);
        const tmpPath = ENV_FILE + '.tmp';
        fs.writeFileSync(tmpPath, existentes.join('\n') + '\n', 'utf-8');
        fs.renameSync(tmpPath, ENV_FILE);
        fs.chmodSync(ENV_FILE, 0o600);
    } catch (e) { /* ignore */ }

    process.env.FLASK_SECRET_KEY = nova;
    return nova;
}

function verificarDisco(caminho = '/', minimoMb = 50) {
    try {
        // Node.js nao tem statvfs nativo, usamos child_process
        const { execSync } = require('child_process');
        const result = execSync(`df -m "${caminho}" | tail -1 | awk '{print $4}'`, { encoding: 'utf-8' });
        const livreMb = parseInt(result.trim());
        return livreMb >= minimoMb;
    } catch (e) {
        return true;
    }
}

function caminhoSeguro(base, relativo) {
    const realBase = fs.realpathSync(base);
    const realAlvo = fs.realpathSync(path.join(base, relativo));
    if (!realAlvo.startsWith(realBase + path.sep) && realAlvo !== realBase) {
        return null;
    }
    return realAlvo;
}

function limparTmpOrfaos(baseDir = null) {
    if (!baseDir) baseDir = _BASE_DIR;
    let removidos = 0;
    const ignorar = new Set(['.local', '.cache', 'node_modules', '.git']);

    function walk(dir) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!ignorar.has(entry.name)) walk(fullPath);
            } else if (entry.isFile() && entry.name.endsWith('.tmp')) {
                try {
                    const idade = (Date.now() - fs.statSync(fullPath).mtimeMs) / 1000;
                    if (idade > 300) {
                        fs.unlinkSync(fullPath);
                        removidos++;
                    }
                } catch (e) { /* ignore */ }
            }
        }
    }
    walk(baseDir);
    return removidos;
}

module.exports = {
    LOCK_DIR,
    BACKUP_DIR,
    ENV_FILE,
    carregarJsonSeguro,
    salvarJsonSeguro,
    FileLock,
    executarBackup,
    iniciarBackupAutomatico,
    pararBackupAutomatico,
    carregarOuGerarSecretKey,
    verificarDisco,
    caminhoSeguro,
    limparTmpOrfaos,
};
