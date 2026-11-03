/**
 * thread_pool.js - Pool de workers (conversao de thread_pool.py)
 *
 * Em Node.js, nao temos ThreadPoolExecutor como em Python.
 * Usamos worker_threads ou simplesmente setImmediate/Promises para tarefas async.
 * Para manter compatibilidade, criamos uma abstração simples.
 */

const os = require('os');

const _maxWorkers = Math.min(32, Math.max(8, (os.cpus().length || 4) * 4));
let _activeCount = 0;

function submitTask(fn, ...args) {
    /**
     * Submete uma tarefa para execucao assincrona sem bloquear.
     * Em Node.js, usamos setImmediate para agendar a execucao.
     */
    try {
        _activeCount++;
        setImmediate(async () => {
            try {
                await fn(...args);
            } catch (e) {
                // Silencia erros como o Python original
            } finally {
                _activeCount--;
            }
        });
        return true;
    } catch (e) {
        return null;
    }
}

function getPoolInfo() {
    return {
        max_workers: _maxWorkers,
        threads_ativas: _activeCount,
    };
}

module.exports = {
    submitTask,
    getPoolInfo,
};
