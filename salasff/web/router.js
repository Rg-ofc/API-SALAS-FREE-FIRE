'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const api = require('./handlers/api_handlers');
const admin = require('./handlers/admin_handlers');
const dash = require('./handlers/dashboard_handlers');
const oauth2 = require('./handlers/oauth2_handlers');
const pag = require('./handlers/pagamento_handlers');
const tg = require('./handlers/telegram_handlers');
const partner = require('./handlers/parceria_handlers');

function serveStaticDir(basePath, prefix, res, req, maxAge) {
    const relPath = req.url.replace(prefix, '').split('?')[0];
    const filePath = path.join(basePath, relPath);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.writeHead(404); res.end('Not Found'); return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
        '.css': 'text/css', '.js': 'application/javascript',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
        '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
        '.eot': 'application/vnd.ms-fontobject', '.webp': 'image/webp',
        '.json': 'application/json', '.html': 'text/html',
    };
    const headers = { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' };
    if (maxAge) headers['Cache-Control'] = `public, max-age=${maxAge}, immutable`;
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
}

function setup() {

    if (typeof admin.initAdminAPIToken === 'function') admin.initAdminAPIToken();

    const exactRoutes = {
        // Health / Ping
        '/ping': api.APIPing,
        '/health': api.APIHealth,

        // API Pública — Salas / Keys
        '/api/injeta-key': async (req, res) => {
            try {
                const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
                const key = url.searchParams.get('key');
                const limite = parseInt(url.searchParams.get('limite') || '0');
                if (!key) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'erro', msg: 'Parametro "key" e obrigatorio na URL! Ex: /api/injeta-key?key=CHAVE123&limite=100' }));
                    return;
                }
                const db = require('../db_postgres');
                await db.salvarKeyInfo({
                    key: key,
                    limite_usos: limite,
                    ilimitada: limite <= 0,
                    ativa: true,
                    nome: 'Key Criada via API',
                    total_usos: 0,
                    usos_totais: 0
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ok', msg: `Key "${key}" criada/atualizada com limite de ${limite} salas com sucesso!` }));
            } catch (e) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: e.message }));
            }
        },
        '/api/verificar-key': api.APIVerificarKey,
        '/api/v1/status': api.APIStatus,
        '/api/v1/info-system': api.APIInfoSystem,
        '/api/v1/me': api.APIMe,
        '/api/v1/verify/me': api.APIVerifyMe,
        // '/api/v1/create:room': api.APICriarSala,
        // '/api/v2/info:room': api.APIInfoSala,
        // '/api/v2/start:room': api.APIIniciarSala,
        '/api/v2/check:room': api.APICheckSala,
        // '/api/v2/expulsar-player': api.APIExpulsarPlayer,
        '/api/v2/cancel:room': api.APICancelarSala,
        '/api/v2/result:room': api.APIResultadoSala,
        '/api/v1/imagem': tg.APIImagem,

        // API SalasBot
        '/api/bot/partner/generate-payment': partner.GeneratePayment,
        '/api/bot/partner/order-status': partner.OrderStatus,
        '/api/bot/partner/saldo': partner.Saldo,
        '/api/bot/partner/create-room': partner.CreateRoom,
        '/api/bot/partner/start-room': partner.StartRoom,
        '/api/bot/partner/stop-room': partner.StopRoom,
        '/api/bot/partner/players': partner.Players,
        '/api/bot/partner/kick-player': partner.KickPlayer,
        '/api/bot/partner/result-room': partner.ResultRoom,
        '/api/bot/partner/match-scoreboard': partner.ResultRoom,
        '/api/bot/partner/room-card': partner.RoomCard,
        '/api/bot/partner/preview-card': partner.PreviewCard,
        '/api/bot/partner/transfer': partner.Transfer,
        '/api/bot/partner/lucro-afiliado': partner.LucroAfiliado,
        '/api/bot/partner/lucro-sistema': partner.LucroSistema,
        '/api/bot/partner/reset-lucro': partner.ResetLucro,
        '/api/bot/partner/compras': partner.Compras,
        '/api/bot/partner/faturamento': partner.Faturamento,
        '/api/bot/partner/comissao': partner.Comissao,
        '/api/bot/partner/saque': partner.Saque,
        '/api/bot/partner/sacar': partner.Saque,
        '/api/bot/partner/payout': partner.Saque,

        // Admin Panel — OAuth + API
        '/admin/oauth': admin.AdminRedirecionarOAuth,
        '/admin/oauth/callback': admin.AdminOAuthCallback,
        '/dashadmin': admin.AdminPagina,
        '/serveradmin': admin.AdminPagina,
        '/erro-acesso': admin.AdminErroAcesso,
        '/admin/api/verificar-sessao': admin.AdminAPIVerificarSessao,
        '/admin/api/me': admin.AdminAPIMe,
        '/admin/api/logout': admin.AdminAPILogout,
        '/admin/api/backup': admin.AdminAPIBackup,
        '/admin/api/gerenciar-admins': admin.AdminAPIGerenciarAdmins,
        '/admin/api/salvar-config-geral': admin.AdminAPISalvarConfigGeral,
        '/admin/api/carregar-config': admin.AdminAPICarregarConfig,

        // Admin — Keys
        '/admin/api/listar-keys': admin.AdminAPIListarKeys,
        '/admin/api/criar-key': admin.AdminAPICriarKey,
        '/admin/api/toggle-key': admin.AdminAPIToggleKey,
        '/admin/api/deletar-key': admin.AdminAPIDeletarKey,
        '/admin/api/adicionar-limite': admin.AdminAPIAdicionarLimite,
        '/admin/api/editar-key': admin.AdminAPIEditarKey,
        '/admin/api/transferir-key': admin.AdminAPITransferirKey,
        '/admin/api/resetar-usos': admin.AdminAPIResetarUsos,
        '/admin/api/operacao-massa': admin.AdminAPIOperacaoMassa,

        // Admin — Salas
        '/admin/api/listar-salas': admin.AdminAPIListarSalas,
        '/admin/api/status-bot': admin.AdminAPIStatusBot,

        // Admin — Pagamentos
        '/admin/api/listar-pagamentos': admin.AdminAPIListarPagamentos,
        '/admin/api/salvar-config-pagamento': admin.AdminAPISalvarConfigPagamento,
        '/admin/api/carregar-config-pagamento': admin.AdminAPICarregarConfigPagamento,
        '/admin/api/estornar-pagamento': admin.AdminAPIEstornarPagamento,
        '/admin/api/partner-keys/list': admin.AdminAPIPartnerKeysList,
        '/admin/api/partner-keys/add': admin.AdminAPIPartnerKeysAdd,
        '/admin/api/partner-keys/delete': admin.AdminAPIPartnerKeysDelete,
        '/admin/api/partner-keys/stats': admin.AdminAPIPartnerKeysStats,
        '/admin/api/partner-keys/save-config': admin.AdminAPIPartnerKeysSaveConfig,
        '/admin/api/partner-keys/reset-lucro': admin.AdminAPIPartnerKeysResetLucro,
        '/admin/api/partner-keys/saque': admin.AdminAPIPartnerKeysSaque,
        '/admin/api/partner-keys/toggle-pin': admin.AdminAPIPartnerKeysTogglePin,
        '/admin/api/turbofy/info': admin.AdminAPITurbofyGetInfo,
        '/admin/api/turbofy/depositar': admin.AdminAPITurbofyDepositar,
        '/admin/api/turbofy/consultar-pix': admin.AdminAPITurbofyConsultarPix,

        // Admin — Fornecedores / Avisos / Telegram VIPs
        '/admin/api/fornecedores': admin.AdminAPIFornecedores,
        '/admin/api/avisos': admin.AdminAPIAvisos,
        '/admin/api/telegram-vips': admin.AdminAPITelegramVips,

        // Dashboard API — Rotas de Integração
        '/api/v1/dashboard/minhas-keys': dash.DashboardAPIMinhasKeys,
        '/api/v1/dashboard/minhas-salas': dash.DashboardAPIMinhasSalas,
        '/api/v1/dashboard/criar-sala': dash.DashboardAPICriarSala,
        '/api/v1/dashboard/info-sala': dash.DashboardAPIInfoSala,
        '/api/v1/dashboard/iniciar-sala': dash.DashboardAPIIniciarSala,
        '/api/v1/dashboard/status-api': dash.DashboardAPIStatusAPI,

        // Pagamentos — Pix / Saldo / Webhook
        '/api/v1/pagamento/config': pag.PagamentoConfig,
        '/api/v1/pagamento/saldo': pag.PagamentoSaldo,
        '/api/v1/criar-pagamento': pag.CriarPagamento,
        '/api/v1/pagamento/verificar': pag.VerificarPagamento,
        '/api/v1/pagamento/verificar-auto': pag.VerificarPagamentoAuto,
        '/api/v1/pagamento/comprar-com-saldo': pag.ComprarComSaldo,
        '/api/v1/pagamento/minhas-keys': pag.PagamentoMinhasKeys,
        '/api/v1/pagamento/meus-pagamentos': pag.PagamentoMeusPagamentos,
        '/api/v1/pagamento/verificar-tipo-usuario': pag.PagamentoVerificarTipoUsuario,
        '/api/v1/pagamento/buscar-usuario-destino': pag.PagamentoBuscarUsuarioDestino,
        '/api/v1/pagamento/buscar-usuario': pag.PagamentoBuscarUsuario,
        '/api/v1/pagamento/avisos': pag.PagamentoAvisos,
        '/api/pagamento/config': admin.APIPagamentoConfigGet,
        '/api/callback-mp/webhook': pag.CallbackMPWebhook,
        '/api/callback-efi/webhook': pag.CallbackEfiWebhook,

        // Admin — Pagamentos / Usuários / Fornecedores (v1)
        '/api/v1/admin/pagamento/config': pag.AdminPagamentoConfig,
        '/api/v1/admin/pagamento/todos': pag.AdminPagamentoTodos,
        '/api/v1/admin/usuarios': pag.AdminUsuarios,
        '/api/v1/admin/add-saldo': pag.AdminAddSaldo,
        '/api/v1/admin/add-key': pag.AdminAddKey,
        '/api/v1/admin/buscar-usuarios': pag.AdminBuscarUsuarios,
        '/api/v1/admin/adicionar-fornecedor': pag.AdminAdicionarFornecedor,
        '/api/v1/admin/remover-fornecedor': pag.AdminRemoverFornecedor,
        '/api/v1/admin/listar-fornecedores': pag.AdminListarFornecedores,
        '/api/v1/admin/salvar-precos-fornecedor': pag.AdminSalvarPrecosFornecedor,
        '/api/v1/admin/avisos/listar': pag.AdminAvisosListar,
        '/api/v1/admin/avisos/criar': pag.AdminAvisosCriar,
        '/api/v1/admin/avisos/deletar': pag.AdminAvisosDeletar,
        '/api/v1/admin/dashboard/adicionar-admin': pag.AdminDashboardAdicionarAdmin,
        '/api/v1/admin/dashboard/remover-admin': pag.AdminDashboardRemoverAdmin,
        '/api/v1/admin/dashboard/listar-admins': pag.AdminDashboardListarAdmins,

        // Telegram — Bot / Admin / API
        '/api/v1/admin/telegram/adicionar-vip': pag.AdminTelegramAdicionarVip,
        '/api/v1/admin/telegram/remover-vip': pag.AdminTelegramRemoverVip,
        '/api/v1/admin/telegram/adicionar-admin': pag.AdminTelegramAdicionarAdmin,
        '/api/v1/admin/telegram/remover-admin': pag.AdminTelegramRemoverAdmin,
        '/api/v1/admin/telegram/definir-dono': pag.AdminTelegramDefinirDono,
        '/api/v1/admin/telegram/listar-permissoes': pag.AdminTelegramListarPermissoes,
        '/api/v1/admin/telegram/salvar-config': pag.AdminTelegramSalvarConfig,
        '/api/v1/telegram/verificar-permissao': pag.TelegramVerificarPermissao,
        '/api/v1/telegram/obter-keys-usuario': pag.TelegramObterKeysUsuario,
        '/api/v1/telegram/usar-key': pag.TelegramUsarKey,
        '/api/v1/telegram/obter-config': pag.TelegramObterConfig,
        '/api/v1/telegram/atualizar-auto-start': pag.TelegramAtualizarAutoStart,
        '/api/v1/telegram/registrar-key': tg.TelegramRegistrarKey,
        '/api/v1/telegram/remover-key': tg.TelegramRemoverKey,
        '/api/v1/telegram/listar-keys': tg.TelegramListarKeys,

        '/telegram/api/verificar-sessao': tg.TelegramAPIVerificarSessao,
        '/telegramadmin': tg.TelegramAdminPagina,
        '/telegram/api/usuarios': tg.TelegramAPIUsuarios,
        '/telegram/api/estatisticas': tg.TelegramAPIEstatisticas,
        '/telegram/api/transmitir': tg.TelegramAPITransmitir,
        '/telegram/api/transmissoes': tg.TelegramAPITransmissoes,
        '/telegram/api/upload-imagem': tg.TelegramAPIUploadImagem,

        // Admin REST API — Token Auth
        '/api/v1/admin/stats': admin.AdminAPIRESTStats,
        '/api/v1/admin/keys': admin.AdminAPIRESTListarKeys,
        '/api/v1/admin/keys/info': admin.AdminAPIRESTInfoKey,
        '/api/v1/admin/keys/criar': admin.AdminAPIRESTCriarKey,
        '/api/v1/admin/keys/editar': admin.AdminAPIRESTEditarKey,
        '/api/v1/admin/keys/deletar': admin.AdminAPIRESTDeletarKey,
        '/api/v1/admin/keys/toggle': admin.AdminAPIRESTToggleKey,
        '/api/v1/admin/keys/add-limite': admin.AdminAPIRESTAdicionarLimite,
        '/api/v1/admin/keys/resetar-usos': admin.AdminAPIRESTResetarUsos,
        '/api/v1/admin/keys/massa': admin.AdminAPIRESTOperacaoMassa,
        '/api/v1/admin/salas': admin.AdminAPIRESTListarSalas,
        '/api/v1/admin/regenerar-token': admin.AdminAPIRESTRegenerarToken,
    };

    // Rotas com prefixo (path params)
    const prefixRoutes = [
        { prefix: '/telegram/api/transmissao/', handler: tg.TelegramAPITransmissao },
        { prefix: '/telegram/api/usuario/', handler: tg.TelegramAPIUsuario },
    ];

    // Handler principal
    return function routeHandler(req, res) {
        const urlObj = new URL(req.url, 'http://localhost');
        const pathname = urlObj.pathname;

        // Rotas exatas
        if (exactRoutes[pathname]) {
            return exactRoutes[pathname](req, res);
        }

        // Rotas com prefixo
        for (const { prefix, handler } of prefixRoutes) {
            if (pathname.startsWith(prefix)) {
                return handler(req, res);
            }
        }

        // Arquivos estáticos — Admin
        if (pathname.startsWith('/static/css/')) return admin.AdminServirCSS(req, res);
        if (pathname.startsWith('/static/js/')) return admin.AdminServirJS(req, res);
        if (pathname.startsWith('/static/images/')) return serveStaticDir(path.join(config.SrcWebDir(), 'images'), '/static/images/', res, req, 3600);
        if (pathname.startsWith('/static/fonts/')) return serveStaticDir(path.join(config.SrcWebDir(), 'fonts'), '/static/fonts/', res, req, 86400);



        // Arquivos estáticos — Telegram
        if (pathname.startsWith('/telegram/static/css/')) return tg.TelegramServirCSS(req, res);
        if (pathname.startsWith('/telegram/static/js/')) return tg.TelegramServirJS(req, res);

        // Uploads
        if (pathname.startsWith('/uploads/')) return serveStaticDir(config.UploadsDir(), '/uploads/', res, req, 0);

        // Raiz
        if (pathname === '/') { res.writeHead(302, { Location: '/serveradmin' }); res.end(); return; }

        // 404
        api.APINotFound(req, res);
    };
}

module.exports = { setup };
