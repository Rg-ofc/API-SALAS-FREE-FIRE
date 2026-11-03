const fs = require('fs');
const path = require('path');
const { Logger } = require('./utils');

const CONFIG_FILE = path.join(__dirname, 'config.json');


// VALORES PADRÃO

const DEFAULTS = {
    // Rotação de contas
    max_concurrent: 600,
    rotation_active: true,

    // Gerador de contas
    gerador_ativo: false,
    gerador_api_url: 'https://contasbooyah.squareweb.app',
    gerador_region: 'BR',
    gerador_workers: 600,
    gerador_check_interval: 10,       // segundos entre checks
    gerador_min_blacklist: 1,          // mínimo de mortas pra acionar

    // Tolerância de falhas
    max_falhas_desativar: 3,           // falhas antes de blacklist
    max_restart_rapido: 5,

    // Watchdog
    watchdog_timeout_contas: 300,      // segundos
    watchdog_timeout_pool: 600,        // segundos
    watchdog_check_interval: 30,       // segundos
    max_go_restarts: 10,

    // Anti-loop de substituição
    gerador_pause_tempo: 300,          // segundos de pausa se loop detectado
    substituicoes_janela: 120,         // segundos da janela
    substituicoes_limite: 40,          // máximo de substituições na janela

    // Token renewal
    token_renewal_interval_h: 1,       // horas entre renovações
    token_renewal_threshold_h: 2,      // renovar se expira em menos de X horas

    // Health check
    health_check_interval_min: 5,      // minutos entre health checks

    // Heartbeat
    heartbeat_timeout_active: 90,      // segundos (bot com sala ativa)
    heartbeat_timeout_idle: 300,       // segundos (bot idle)
};

// ESTADO ATUAL DA CONFIG

let _config = { ...DEFAULTS };
let _callbacks = [];  // funções chamadas quando a config muda
let _watcherActive = false;

// CARREGAR CONFIG DO ARQUIVO

function carregarConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
            const parsed = JSON.parse(raw);

            // Merge com defaults (só aceita keys conhecidas)
            const novaConfig = { ...DEFAULTS };
            for (const key of Object.keys(DEFAULTS)) {
                if (parsed[key] !== undefined) {
                    const tipo = typeof DEFAULTS[key];
                    if (tipo === 'number') {
                        const val = Number(parsed[key]);
                        if (!isNaN(val)) novaConfig[key] = val;
                    } else if (tipo === 'boolean') {
                        novaConfig[key] = !!parsed[key];
                    } else if (tipo === 'string') {
                        novaConfig[key] = String(parsed[key]);
                    }
                }
            }

            const mudancas = [];
            for (const key of Object.keys(DEFAULTS)) {
                if (_config[key] !== novaConfig[key]) {
                    mudancas.push(`${key}: ${_config[key]} → ${novaConfig[key]}`);
                }
            }

            _config = novaConfig;

            if (mudancas.length > 0) {
                Logger.sistema(`[CONFIG] Configuração atualizada (${mudancas.length} mudanças):`);
                for (const m of mudancas) {
                    Logger.sistema(`[CONFIG]   ${m}`);
                }
                _notificarCallbacks(mudancas);
            }

            return true;
        } else {
            // Criar arquivo com defaults
            salvarConfig();
            Logger.sistema("[CONFIG] Arquivo config.json criado com valores padrão.");
            return true;
        }
    } catch (e) {
        Logger.erro("CONFIG", `Erro ao carregar config.json: ${e.message}`);
        return false;
    }
}

// SALVAR CONFIG NO ARQUIVO

function salvarConfig() {
    try {
        const configOrdenada = {};
        // Agrupar por categoria para facilitar leitura
        const categorias = {
            "// Rotação de contas": ["max_concurrent", "rotation_active"],
            "// Gerador de contas": ["gerador_ativo", "gerador_api_url", "gerador_region", "gerador_workers", "gerador_check_interval", "gerador_min_blacklist"],
            "// Tolerância de falhas": ["max_falhas_desativar", "max_restart_rapido"],
            "// Watchdog": ["watchdog_timeout_contas", "watchdog_timeout_pool", "watchdog_check_interval", "max_go_restarts"],
            "// Anti-loop de substituição": ["gerador_pause_tempo", "substituicoes_janela", "substituicoes_limite"],
            "// Token renewal": ["token_renewal_interval_h", "token_renewal_threshold_h"],
            "// Health check": ["health_check_interval_min"],
            "// Heartbeat": ["heartbeat_timeout_active", "heartbeat_timeout_idle"],
        };

        for (const key of Object.keys(DEFAULTS)) {
            configOrdenada[key] = _config[key];
        }

        fs.writeFileSync(CONFIG_FILE, JSON.stringify(configOrdenada, null, 2) + '\n', 'utf-8');
        return true;
    } catch (e) {
        Logger.erro("CONFIG", `Erro ao salvar config.json: ${e.message}`);
        return false;
    }
}

// WATCH FILE CHANGES (HOT RELOAD)

function iniciarWatcher() {
    if (_watcherActive) return;

    try {
        let debounceTimer = null;
        fs.watch(CONFIG_FILE, (eventType) => {
            if (eventType === 'change') {
                // Debounce para evitar múltiplas leituras
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    Logger.sistema("[CONFIG] Detectada alteração em config.json, recarregando...");
                    carregarConfig();
                }, 500);
            }
        });
        _watcherActive = true;
        Logger.sistema("[CONFIG] File watcher ativo - edite config.json para alterar configurações em tempo real.");
    } catch (e) {
        Logger.erro("CONFIG", `Erro ao iniciar watcher: ${e.message}`);
    }
}

// CALLBACKS DE MUDANÇA

function onConfigChange(callback) {
    _callbacks.push(callback);
}

function _notificarCallbacks(mudancas) {
    for (const cb of _callbacks) {
        try {
            cb(_config, mudancas);
        } catch (e) {
            Logger.erro("CONFIG", `Erro em callback de mudança: ${e.message}`);
        }
    }
}

// GETTERS (acesso rápido)

function get(key) {
    return _config[key] !== undefined ? _config[key] : DEFAULTS[key];
}

function getAll() {
    return { ..._config };
}

// SETTER VIA API

function setValues(novasConfigs) {
    const mudancas = [];
    const erros = [];

    for (const [key, value] of Object.entries(novasConfigs)) {
        if (DEFAULTS[key] === undefined) {
            erros.push(`Chave desconhecida: ${key}`);
            continue;
        }

        const tipo = typeof DEFAULTS[key];
        let valorFinal;

        if (tipo === 'number') {
            valorFinal = Number(value);
            if (isNaN(valorFinal)) {
                erros.push(`${key}: valor deve ser numérico`);
                continue;
            }
        } else if (tipo === 'boolean') {
            valorFinal = value === true || value === 'true' || value === 1;
        } else {
            valorFinal = String(value);
        }

        if (_config[key] !== valorFinal) {
            mudancas.push(`${key}: ${_config[key]} → ${valorFinal}`);
            _config[key] = valorFinal;
        }
    }

    if (mudancas.length > 0) {
        Logger.sistema(`[CONFIG-API] Configuração alterada (${mudancas.length} mudanças):`);
        for (const m of mudancas) {
            Logger.sistema(`[CONFIG-API]   ${m}`);
        }
        salvarConfig();
        _notificarCallbacks(mudancas);
    }

    return { mudancas, erros };
}

// INICIALIZAR

function inicializar() {
    carregarConfig();
    iniciarWatcher();
}

module.exports = {
    inicializar,
    carregarConfig,
    salvarConfig,
    get,
    getAll,
    setValues,
    onConfigChange,
    DEFAULTS,
};
