var keySelecionada = null
var csrfToken = null
var adminUserId = null
var chaveMestra = 'dab7c61db62a72a357fb053e648ea8016a9d20db85ecaa64a6518dcd76e269e7'
var saltFixo = 'x9Kp2mNv8qRs4tWz'

var allKeysCache = []
var partnerKeysCache = []
var allUsuariosCache = []
var keysPagina = 1
var keysPerPage = 20
var usuariosPagina = 1
var usuariosPerPage = 20
var keysFiltro = ''
var usuariosFiltro = ''

function gerarChaveAES() {
    var chaveCombinada = chaveMestra + saltFixo
    return CryptoJS.SHA256(chaveCombinada).toString()
}

function criptografarDados(dados) {
    try {
        var dadosStr = JSON.stringify(dados)
        var chave = CryptoJS.enc.Hex.parse(gerarChaveAES())
        var iv = CryptoJS.lib.WordArray.random(16)

        var encrypted = CryptoJS.AES.encrypt(dadosStr, chave, {
            iv: iv,
            mode: CryptoJS.mode.CFB,
            padding: CryptoJS.pad.NoPadding
        })

        var resultado = iv.concat(encrypted.ciphertext)
        return CryptoJS.enc.Base64.stringify(resultado)
    } catch (e) {
        return null
    }
}

function descriptografarDados(dadosCriptografados) {
    try {
        var dadosBytes = CryptoJS.enc.Base64.parse(dadosCriptografados)
        var iv = CryptoJS.lib.WordArray.create(dadosBytes.words.slice(0, 4), 16)
        var ciphertext = CryptoJS.lib.WordArray.create(dadosBytes.words.slice(4), dadosBytes.sigBytes - 16)

        var chave = CryptoJS.enc.Hex.parse(gerarChaveAES())

        var decrypted = CryptoJS.AES.decrypt(
            { ciphertext: ciphertext },
            chave,
            {
                iv: iv,
                mode: CryptoJS.mode.CFB,
                padding: CryptoJS.pad.NoPadding
            }
        )

        var dadosStr = decrypted.toString(CryptoJS.enc.Utf8)
        return JSON.parse(dadosStr)
    } catch (e) {
        return null
    }
}

function copiarParaClipboard(texto) {
    try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(texto).catch(function () {
                copiarFallback(texto)
            })
            return true
        }
    } catch (e) { }
    copiarFallback(texto)
    return true
}

function copiarFallback(texto) {
    try {
        var tempInput = document.createElement('input')
        tempInput.value = texto
        document.body.appendChild(tempInput)
        tempInput.select()
        document.execCommand('copy')
        document.body.removeChild(tempInput)
    } catch (e) { }
}

function fazerRequestSegura(url, dados, callback) {
    var dadosCriptografados = dados ? criptografarDados(dados) : null

    var body = {
        _csrf: csrfToken
    }

    if (dadosCriptografados) {
        body.data = dadosCriptografados
    }

    var callbackChamado = false
    function chamarCallback(erro, data) {
        if (callbackChamado) return
        callbackChamado = true
        try {
            callback(erro, data)
        } catch (e) {
            console.error('Erro no callback:', e)
        }
    }

    fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    })
        .then(function (response) {
            return response.json()
        })
        .then(function (data) {
            if (data.data) {
                var dadosDescriptografados = descriptografarDados(data.data)
                data.dados = dadosDescriptografados
            }
            chamarCallback(null, data)
        })
        .catch(function (error) {
            chamarCallback(error, null)
        })
}

function mostrarToast(mensagem, tipo) {
    var container = document.getElementById('toast-container')
    if (!container) {
        container = document.createElement('div')
        container.id = 'toast-container'
        container.className = 'toast-container'
        document.body.appendChild(container)
    }

    var toast = document.createElement('div')
    toast.className = 'toast toast-' + (tipo || 'info')
    toast.textContent = mensagem

    container.appendChild(toast)

    setTimeout(function () {
        toast.style.opacity = '0'
        toast.style.transform = 'translateX(40px)'
        toast.style.transition = 'all 0.3s ease'
        setTimeout(function () {
            if (toast.parentNode) toast.parentNode.removeChild(toast)
        }, 300)
    }, 3500)
}

document.addEventListener('DOMContentLoaded', function () {
    verificarSessaoAdmin()

    document.getElementById('formato-key').addEventListener('change', function () {
        var customGroup = document.getElementById('custom-key-group')
        if (this.value === 'custom') {
            customGroup.style.display = 'block'
        } else {
            customGroup.style.display = 'none'
        }
    })
})

function verificarSessaoAdmin() {
    fetch('/admin/api/verificar-sessao', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        }
    })
        .then(function (response) {
            return response.json()
        })
        .then(function (data) {
            if (data.autenticado) {
                document.getElementById('admin-name').textContent = data.username
                if (data.avatar) {
                    document.getElementById('admin-avatar').src = data.avatar
                }
                csrfToken = data.csrf
                adminUserId = data.user_id
                var secaoMassa = document.getElementById('secao-operacao-massa')
                if (secaoMassa) secaoMassa.style.display = 'block'
                carregarKeys()
            } else {
                window.location.href = '/admin/oauth'
            }
        })
        .catch(function (error) {
            window.location.href = '/admin/oauth'
        })
}

function trocarAba(aba) {
    // Limpar o intervalo de status do bot se estiver trocando de aba
    if (_statusBotUpdateInterval) {
        clearInterval(_statusBotUpdateInterval);
        _statusBotUpdateInterval = null;
    }

    document.querySelectorAll('.tab-btn, .nav-item').forEach(function (btn) {
        btn.classList.remove('active')
        btn.classList.remove('ativo')
    })
    document.querySelectorAll('.tab-content').forEach(function (content) {
        content.classList.remove('active')
        content.classList.remove('ativo')
    })

    var btnAtivo = document.querySelector('.tab-btn[onclick*="' + aba + '"]')
    if (btnAtivo) btnAtivo.classList.add('active')
    var navAtivo = document.querySelector('.nav-item[data-aba="' + aba + '"]')
    if (navAtivo) navAtivo.classList.add('ativo')

    var abaAtiva = document.getElementById('aba-' + aba)
    if (abaAtiva) { abaAtiva.classList.add('active'); abaAtiva.classList.add('ativo'); }

    if (aba === 'keys') {
        carregarKeys()
    } else if (aba === 'usuarios') {
        carregarUsuarios()
    } else if (aba === 'salas') {
        carregarSalas()
    } else if (aba === 'pagamentos') {
        carregarPagamentos()
    } else if (aba === 'fornecedores') {
        carregarFornecedores()
    } else if (aba === 'telegram') {
        carregarTelegramVips()
    } else if (aba === 'admins') {
        carregarAdminsDashboard()
    } else if (aba === 'config') {
        carregarConfiguracoes()
        carregarStatusPagamentos()
        carregarTurbofyInfo()
    } else if (aba === 'avisos') {
        carregarAvisos()
    } else if (aba === 'partner-keys') {
        carregarPartnerKeys()
    } else if (aba === 'status-bot') {
        carregarStatusBot();
        _statusBotUpdateInterval = setInterval(carregarStatusBot, 2000);
    }
}

function gerarSkeleton(cols, rows) {
    var html = ''
    for (var i = 0; i < rows; i++) {
        html += '<tr class="skeleton-row">'
        for (var j = 0; j < cols; j++) {
            var w = [120, 160, 60, 80, 110, 140][j % 6]
            html += '<td><div class="skeleton-cell" style="width:' + w + 'px;height:14px;"></div></td>'
        }
        html += '</tr>'
    }
    return html
}

function carregarKeys() {
    var tbody = document.getElementById('keys-tbody')
    if (tbody) tbody.innerHTML = gerarSkeleton(6, 8)

    fazerRequestSegura('/admin/api/listar-keys', {}, function (erro, data) {
        if (erro) {
            mostrarToast('Erro ao carregar keys', 'erro')
            return
        }

        if (data.sucesso && data.dados && data.dados.keys) {
            allKeysCache = data.dados.keys
            keysPagina = 1
            renderizarKeys()
            atualizarEstatisticas(data.dados.keys, data.dados.total_salas_criadas, data.dados.total_salas_iniciadas)
            atualizarFiltroKeys(data.dados.keys)
            
            // Auto preencher oauth_key para testes da API
            if (data.dados.keys.length > 0) {
                window.firstOauthKey = data.dados.keys[0].key;
                document.querySelectorAll('.api-test-input[data-param="oauth_key"]').forEach(function(input) {
                    if (!input.value) input.value = window.firstOauthKey;
                });
            }
        }
    })
}

function renderizarKeys() {
    var filtro = keysFiltro.toLowerCase()
    var filtered = allKeysCache.filter(function (key) {
        if (!filtro) return true
        var nome = (key.nome || '').toLowerCase()
        var keyStr = (key.key || '').toLowerCase()
        return nome.indexOf(filtro) !== -1 || keyStr.indexOf(filtro) !== -1
    })

    var totalPages = Math.max(1, Math.ceil(filtered.length / keysPerPage))
    if (keysPagina > totalPages) keysPagina = totalPages

    var start = (keysPagina - 1) * keysPerPage
    var pageKeys = filtered.slice(start, start + keysPerPage)

    var tbody = document.getElementById('keys-tbody')
    tbody.innerHTML = ''

    var countEl = document.getElementById('keys-search-count')
    if (countEl) {
        countEl.textContent = filtered.length + ' key' + (filtered.length !== 1 ? 's' : '')
    }

    if (pageKeys.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#666;padding:30px;">Nenhuma key encontrada</td></tr>'
        renderizarPaginacao('keys-pagination', 0, 1, function () { })
        return
    }

    pageKeys.forEach(function (key) {
        var tr = document.createElement('tr')

        var statusClass = key.ativa ? 'status-ativa' : 'status-inativa'
        var statusTexto = key.ativa ? 'Ativa' : 'Inativa'
        var toggleTexto = key.ativa ? 'Desativar' : 'Ativar'

        var limiteTexto = key.ilimitada ? 'Ilimitado' : (key.limite_usos > 0 ? key.limite_usos : '0')
        var usosAtuais = key.usos_totais || key.total_usos || 0
        var usosTexto = usosAtuais + ' / ' + limiteTexto

        if (key.limite_usos > 0 && usosAtuais >= key.limite_usos) {
            usosTexto = '<span class="status-inativa">' + usosTexto + ' (esgotado)</span>'
        }

        var keyEscapada = key.key.replace(/'/g, "\\'")

        tr.innerHTML = '<td>' + (key.nome || 'Sem nome') + '</td>' +
            '<td><span class="key-value" onclick="copiarKey(\'' + keyEscapada + '\')" title="Click to copy">' + key.key + '</span></td>' +
            '<td><span class="' + statusClass + '">' + statusTexto + '</span></td>' +
            '<td>' + usosTexto + '</td>' +
            '<td>' + (key.ultima_request || 'Nunca') + '</td>' +
            '<td class="acoes-cell">' +
            '<button class="btn-acao btn-copiar" onclick="copiarKey(\'' + keyEscapada + '\')">Copiar</button>' +
            '<button class="btn-acao btn-adicionar" onclick="abrirModalAdicionar(\'' + keyEscapada + '\', ' + (key.limite_usos || 0) + ', ' + (key.ilimitada ? 'true' : 'false') + ')">+Limite</button>' +
            '<button class="btn-acao btn-toggle" onclick="toggleKey(\'' + keyEscapada + '\')">' + toggleTexto + '</button>' +
            '<button class="btn-acao btn-deletar" onclick="deletarKey(\'' + keyEscapada + '\')">Deletar</button>' +
            '</td>'

        tbody.appendChild(tr)
    })

    renderizarPaginacao('keys-pagination', totalPages, keysPagina, function (p) {
        keysPagina = p
        renderizarKeys()
    })
}

function filtrarKeys(valor) {
    keysFiltro = valor
    keysPagina = 1
    renderizarKeys()
}

function atualizarFiltroKeys(keys) {
    var select = document.getElementById('filtro-key-salas')
    if (!select) return
    select.innerHTML = '<option value="">Todas as Keys</option>'

    keys.forEach(function (key) {
        var option = document.createElement('option')
        option.value = key.key
        option.textContent = key.nome + ' (' + key.key.substring(0, 15) + '...)'
        select.appendChild(option)
    })
}

function atualizarEstatisticas(keys, totalSalasCriadas, totalSalasIniciadas) {
    var totalKeys = keys.length
    var keysAtivas = keys.filter(function (k) { return k.ativa }).length

    document.getElementById('total-keys').textContent = totalKeys
    document.getElementById('keys-ativas').textContent = keysAtivas

    if (totalSalasCriadas !== undefined) {
        document.getElementById('total-salas-criadas').textContent = totalSalasCriadas
    } else {
        var total = 0
        keys.forEach(function (k) {
            total += (k.usos_totais || k.total_usos || 0)
        })
        document.getElementById('total-salas-criadas').textContent = total
    }

    if (totalSalasIniciadas !== undefined) {
        document.getElementById('total-salas-iniciadas').textContent = totalSalasIniciadas
    }
}

function carregarSalas() {
    var filtroKey = document.getElementById('filtro-key-salas').value

    fazerRequestSegura('/admin/api/listar-salas', { key_filtro: filtroKey || null }, function (erro, data) {
        if (erro) {
            mostrarToast('Erro ao carregar salas', 'erro')
            return
        }

        if (data.sucesso && data.dados) {
            atualizarTabelaSalas(data.dados.salas || [])
            atualizarEstatisticasSalas(data.dados.salas || [])
        }
    })
}

function atualizarTabelaSalas(salas) {
    var tbody = document.getElementById('salas-tbody')
    tbody.innerHTML = ''

    if (salas.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#666;padding:30px;">Nenhuma sala ativa no momento</td></tr>'
        return
    }

    salas.forEach(function (sala) {
        var tr = document.createElement('tr')

        var estadoClass = 'status-ativa'
        var estadoTexto = sala.estado
        if (sala.estado === 'ESPERANDO_COMECAR') {
            estadoClass = 'status-esperando'
            if (sala.aguardando_reconexao) {
                estadoTexto = 'BOT RECONECTANDO'
            }
        } else if (sala.estado === 'SALA_INICIADA') {
            estadoClass = 'status-ativa'
        } else if (sala.estado.indexOf('FALHA') !== -1 || sala.estado.indexOf('ERRO') !== -1) {
            estadoClass = 'status-inativa'
        }

        var botStatus = sala.bot_conectado ? '<span class="status-ativa">Online</span>' : '<span class="status-inativa">Offline</span>'

        tr.innerHTML = '<td>' + (sala.nome || 'Sem nome') + '</td>' +
            '<td>' + (sala.room_id || '-') + '</td>' +
            '<td><span class="' + estadoClass + '">' + estadoTexto + '</span></td>' +
            '<td>' + sala.total_players + '</td>' +
            '<td>' + botStatus + '</td>' +
            '<td><span class="key-value-small">' + (sala.oauth_key || '-') + '</span></td>' +
            '<td>' + (sala.created_at || '-') + '</td>'

        tbody.appendChild(tr)
    })
}

function atualizarEstatisticasSalas(salas) {
    var totalSalas = salas.length
    var salasEsperando = salas.filter(function (s) { return s.estado === 'ESPERANDO_COMECAR' }).length
    var salasIniciadas = salas.filter(function (s) { return s.estado === 'SALA_INICIADA' }).length

    document.getElementById('total-salas').textContent = totalSalas
    document.getElementById('salas-esperando').textContent = salasEsperando
    document.getElementById('salas-iniciadas').textContent = salasIniciadas
}

function criarNovaKey() {
    var nome = document.getElementById('nome-key').value
    var formato = document.getElementById('formato-key').value
    var customKey = document.getElementById('custom-key').value
    var limiteUsos = document.getElementById('limite-usos').value

    var dados = {
        nome: nome,
        formato: formato,
        custom_key: customKey,
        limite_usos: parseInt(limiteUsos) || 10
    }

    fazerRequestSegura('/admin/api/criar-key', dados, function (erro, data) {
        if (erro) {
            mostrarToast('Erro ao criar key', 'erro')
            return
        }

        if (data.sucesso) {
            var keyString = data.key || ''
            if (!keyString && data.dados) {
                var keyObj = data.dados.key
                if (typeof keyObj === 'object' && keyObj !== null) {
                    keyString = keyObj.key || JSON.stringify(keyObj)
                } else {
                    keyString = String(keyObj)
                }
            }

            copiarParaClipboard(keyString)
            mostrarToast('Key criada e copiada: ' + keyString, 'sucesso')

            carregarKeys()
            document.getElementById('nome-key').value = ''
            document.getElementById('custom-key').value = ''
            document.getElementById('limite-usos').value = '10'
        } else {
            mostrarToast('Erro ao criar key: ' + (data.erro || 'erro desconhecido'), 'erro')
        }
    })
}

function copiarKey(key) {
    copiarParaClipboard(key)
    mostrarToast('Key copiada!', 'sucesso')
}

function toggleKey(key) {
    fazerRequestSegura('/admin/api/toggle-key', { key: key }, function (erro, data) {
        if (erro) {
            mostrarToast('Erro ao alterar status', 'erro')
            return
        }

        if (data.sucesso) {
            mostrarToast('Status da key alterado', 'sucesso')
            carregarKeys()
        } else {
            mostrarToast('Erro ao alterar status da key', 'erro')
        }
    })
}

function abrirModalAdicionar(key, limiteAtual, ilimitada) {
    keySelecionada = key
    document.getElementById('modal-key-nome').textContent = key
    document.getElementById('modal-limite-atual').textContent = ilimitada ? 'Ilimitado' : (limiteAtual > 0 ? limiteAtual : '0')
    document.getElementById('quantidade-adicionar').value = '10'
    document.getElementById('modal-adicionar').style.display = 'flex'
}

function fecharModal() {
    document.getElementById('modal-adicionar').style.display = 'none'
    keySelecionada = null
}

function confirmarAdicionarLimite() {
    if (!keySelecionada) {
        fecharModal()
        return
    }

    var quantidade = parseInt(document.getElementById('quantidade-adicionar').value) || 0

    if (quantidade <= 0) {
        mostrarToast('A quantidade deve ser maior que zero', 'aviso')
        return
    }

    fazerRequestSegura('/admin/api/adicionar-limite', { key: keySelecionada, quantidade: quantidade }, function (erro, data) {
        if (erro) {
            mostrarToast('Erro ao adicionar limite', 'erro')
            return
        }

        if (data.sucesso && data.dados) {
            mostrarToast('Limite adicionado! ' + data.dados.limite_anterior + ' -> ' + data.dados.limite_novo, 'sucesso')
            fecharModal()
            carregarKeys()
        } else {
            mostrarToast('Erro ao adicionar limite: ' + (data.erro || 'erro desconhecido'), 'erro')
        }
    })
}

function deletarKey(key) {
    if (!confirm('Tem certeza que deseja deletar esta key?')) {
        return
    }

    fazerRequestSegura('/admin/api/deletar-key', { key: key }, function (erro, data) {
        if (erro) {
            mostrarToast('Erro ao deletar key', 'erro')
            return
        }

        if (data.sucesso) {
            mostrarToast('Key deletada', 'sucesso')
            carregarKeys()
        } else {
            mostrarToast('Erro ao deletar key', 'erro')
        }
    })
}

function fazerLogout() {
    fetch('/admin/api/logout', {
        method: 'POST'
    })
        .then(function () {
            window.location.href = '/admin/oauth'
        })
        .catch(function () {
            window.location.href = '/admin/oauth'
        })
}

function carregarUsuarios() {
    var tbody = document.getElementById('usuarios-tbody')
    tbody.innerHTML = gerarSkeleton(8, 8)

    fetch('/api/v1/admin/usuarios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _csrf: csrfToken, dados: {} })
    })
        .then(function (r) { return r.json() })
        .then(function (dados) {
            if (dados.erro) {
                tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#f87171">Erro ao carregar usuarios</td></tr>'
                return
            }

            if (!dados.usuarios || dados.usuarios.length === 0) {
                tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#666">Nenhum usuario encontrado</td></tr>'
                return
            }

            document.getElementById('total-usuarios').textContent = dados.total || dados.usuarios.length
            document.getElementById('usuarios-com-keys').textContent = dados.com_keys || 0
            document.getElementById('total-compras').textContent = dados.total_compras || 0
            document.getElementById('receita-total').textContent = 'R$ ' + (dados.receita_total || 0).toFixed(2).replace('.', ',')

            allUsuariosCache = dados.usuarios
            usuariosPagina = 1
            renderizarUsuarios()
        })
        .catch(function (erro) {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#f87171">Erro ao carregar usuarios</td></tr>'
        })
}

function renderizarUsuarios() {
    var filtro = usuariosFiltro.toLowerCase()
    var filtered = allUsuariosCache.filter(function (u) {
        if (!filtro) return true
        var nome = (u.nome || u.username || '').toLowerCase()
        var id = (u.user_id || '').toLowerCase()
        return nome.indexOf(filtro) !== -1 || id.indexOf(filtro) !== -1
    })

    var totalPages = Math.max(1, Math.ceil(filtered.length / usuariosPerPage))
    if (usuariosPagina > totalPages) usuariosPagina = totalPages

    var start = (usuariosPagina - 1) * usuariosPerPage
    var pageUsers = filtered.slice(start, start + usuariosPerPage)

    var tbody = document.getElementById('usuarios-tbody')
    tbody.innerHTML = ''

    var countEl = document.getElementById('usuarios-search-count')
    if (countEl) {
        countEl.textContent = filtered.length + ' usuario' + (filtered.length !== 1 ? 's' : '')
    }

    if (pageUsers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#666;padding:30px;">Nenhum usuario encontrado</td></tr>'
        renderizarPaginacao('usuarios-pagination', 0, 1, function () { })
        return
    }

    pageUsers.forEach(function (u) {
        var tr = document.createElement('tr')
        var avatarUrl = u.avatar ? '/static/images/avatar-default.png' : '/static/images/avatar-default.png'
        var userIdEscapado = u.user_id.replace(/'/g, "\\'")
        var nomeEscapado = (u.nome || u.username || 'N/A').replace(/'/g, "\\'")

        var cargoClass = 'cargo-usuario'
        var cargoTexto = 'User'
        if (u.is_fornecedor) {
            cargoClass = 'cargo-fornecedor'
            cargoTexto = 'Fornecedor'
        }

        tr.innerHTML = '<td><img src="' + avatarUrl + '" class="user-avatar-small" loading="lazy"></td>' +
            '<td>' + (u.nome || u.username || 'N/A') + '</td>' +
            '<td><span class="key-value-small" style="cursor:pointer" onclick="copiarKey(\'' + userIdEscapado + '\')">' + u.user_id + '</span></td>' +
            '<td><span class="' + cargoClass + '">' + cargoTexto + '</span></td>' +
            '<td>' + (u.total_keys || 0) + '</td>' +
            '<td style="color:#2dd4bf">' + (u.saldo || 0) + '</td>' +
            '<td>' + (u.ultimo_acesso || 'N/A') + '</td>' +
            '<td class="acoes-cell">' +
            '<button class="btn-acao btn-adicionar" onclick="abrirModalAddSaldo(\'' + userIdEscapado + '\', \'' + nomeEscapado + '\', ' + (u.saldo || 0) + ')">+Saldo</button>' +
            '<button class="btn-acao btn-criar" onclick="abrirModalAddKey(\'' + userIdEscapado + '\', \'' + nomeEscapado + '\')">+Key</button>' +
            (u.is_fornecedor ?
                '<button class="btn-acao btn-deletar" onclick="removerFornecedor(\'' + userIdEscapado + '\', \'' + nomeEscapado + '\')">-Forn</button>' :
                '<button class="btn-acao btn-fornecedor" onclick="adicionarFornecedor(\'' + userIdEscapado + '\', \'' + nomeEscapado + '\')">+Forn</button>') +
            '</td>'

        tbody.appendChild(tr)
    })

    renderizarPaginacao('usuarios-pagination', totalPages, usuariosPagina, function (p) {
        usuariosPagina = p
        renderizarUsuarios()
    })
}

function filtrarUsuarios(valor) {
    usuariosFiltro = valor
    usuariosPagina = 1
    renderizarUsuarios()
}

function renderizarPaginacao(containerId, totalPages, currentPage, onPageChange) {
    var container = document.getElementById(containerId)
    if (!container) return
    container.innerHTML = ''

    if (totalPages <= 1) return

    var prevBtn = document.createElement('button')
    prevBtn.textContent = 'Anterior'
    prevBtn.disabled = currentPage <= 1
    prevBtn.onclick = function () { onPageChange(currentPage - 1) }
    container.appendChild(prevBtn)

    var maxVisible = 5
    var startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2))
    var endPage = Math.min(totalPages, startPage + maxVisible - 1)
    if (endPage - startPage < maxVisible - 1) {
        startPage = Math.max(1, endPage - maxVisible + 1)
    }

    if (startPage > 1) {
        var firstBtn = document.createElement('button')
        firstBtn.textContent = '1'
        firstBtn.onclick = function () { onPageChange(1) }
        container.appendChild(firstBtn)
        if (startPage > 2) {
            var dots = document.createElement('span')
            dots.className = 'pagination-info'
            dots.textContent = '...'
            container.appendChild(dots)
        }
    }

    for (var i = startPage; i <= endPage; i++) {
        var btn = document.createElement('button')
        btn.textContent = i
        if (i === currentPage) btn.className = 'active'
        btn.onclick = (function (page) {
            return function () { onPageChange(page) }
        })(i)
        container.appendChild(btn)
    }

    if (endPage < totalPages) {
        if (endPage < totalPages - 1) {
            var dots2 = document.createElement('span')
            dots2.className = 'pagination-info'
            dots2.textContent = '...'
            container.appendChild(dots2)
        }
        var lastBtn = document.createElement('button')
        lastBtn.textContent = totalPages
        lastBtn.onclick = function () { onPageChange(totalPages) }
        container.appendChild(lastBtn)
    }

    var nextBtn = document.createElement('button')
    nextBtn.textContent = 'Proximo'
    nextBtn.disabled = currentPage >= totalPages
    nextBtn.onclick = function () { onPageChange(currentPage + 1) }
    container.appendChild(nextBtn)
}

function abrirModalAddSaldo(userId, nome, saldoAtual) {
    document.getElementById('modal-saldo-usuario').textContent = nome
    document.getElementById('modal-saldo-atual').textContent = saldoAtual
    document.getElementById('modal-saldo-user-id').value = userId
    document.getElementById('quantidade-saldo').value = 10
    document.getElementById('modal-add-saldo').style.display = 'flex'
}

function fecharModalSaldo() {
    document.getElementById('modal-add-saldo').style.display = 'none'
}

function confirmarAddSaldo() {
    var userId = document.getElementById('modal-saldo-user-id').value
    var quantidade = parseInt(document.getElementById('quantidade-saldo').value) || 0

    if (quantidade < 1) {
        mostrarToast('Quantidade deve ser maior que 0', 'aviso')
        return
    }

    fetch('/api/v1/admin/add-saldo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _csrf: csrfToken, user_id: userId, quantidade: quantidade })
    })
        .then(function (r) { return r.json() })
        .then(function (dados) {
            if (dados.sucesso) {
                mostrarToast('Saldo adicionado! Novo saldo: ' + dados.novo_saldo + ' creditos', 'sucesso')
                fecharModalSaldo()
                carregarUsuarios()
            } else {
                mostrarToast('Erro: ' + (dados.msg || 'Erro desconhecido'), 'erro')
            }
        })
        .catch(function (erro) {
            mostrarToast('Erro ao adicionar saldo', 'erro')
        })
}

function abrirModalAddKey(userId, nome) {
    document.getElementById('modal-key-usuario').textContent = nome
    document.getElementById('modal-key-user-id').value = userId
    document.getElementById('key-nome-usuario').value = ''
    document.getElementById('key-limite-usuario').value = 10
    document.getElementById('modal-add-key').style.display = 'flex'
}

function fecharModalKey() {
    document.getElementById('modal-add-key').style.display = 'none'
}

function confirmarAddKey() {
    var userId = document.getElementById('modal-key-user-id').value
    var nome = document.getElementById('key-nome-usuario').value || 'Key Admin'
    var limite = parseInt(document.getElementById('key-limite-usuario').value) || 10

    if (limite < 1) {
        mostrarToast('Limite deve ser maior que 0', 'aviso')
        return
    }

    fetch('/api/v1/admin/add-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _csrf: csrfToken, user_id: userId, nome: nome, limite_usos: limite })
    })
        .then(function (r) { return r.json() })
        .then(function (dados) {
            if (dados.sucesso) {
                var keyStr = dados.key || ''
                copiarParaClipboard(keyStr)
                mostrarToast('Key criada e copiada: ' + keyStr, 'sucesso')
                fecharModalKey()
                carregarUsuarios()
                carregarKeys()
            } else {
                mostrarToast('Erro: ' + (dados.msg || 'Erro desconhecido'), 'erro')
            }
        })
        .catch(function (erro) {
            mostrarToast('Erro ao criar key', 'erro')
        })
}

function adicionarFornecedor(userId, nome) {
    if (!confirm('Adicionar ' + nome + ' como fornecedor?')) return

    fetch('/api/v1/admin/adicionar-fornecedor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _csrf: csrfToken, user_id: userId })
    })
        .then(function (r) { return r.json() })
        .then(function (dados) {
            if (dados.sucesso) {
                mostrarToast(nome + ' agora e um fornecedor!', 'sucesso')
                carregarUsuarios()
                if (typeof carregarFornecedores === 'function') carregarFornecedores()
            } else {
                mostrarToast('Erro: ' + (dados.msg || 'Erro desconhecido'), 'erro')
            }
        })
        .catch(function (erro) {
            mostrarToast('Erro ao adicionar fornecedor', 'erro')
        })
}

function removerFornecedor(userId, nome) {
    if (!confirm('Remover ' + nome + ' dos fornecedores?')) return

    fetch('/api/v1/admin/remover-fornecedor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _csrf: csrfToken, user_id: userId })
    })
        .then(function (r) { return r.json() })
        .then(function (dados) {
            if (dados.sucesso) {
                mostrarToast(nome + ' removido dos fornecedores!', 'sucesso')
                carregarUsuarios()
                if (typeof carregarFornecedores === 'function') carregarFornecedores()
            } else {
                mostrarToast('Erro: ' + (dados.msg || 'Erro desconhecido'), 'erro')
            }
        })
        .catch(function (erro) {
            mostrarToast('Erro ao remover fornecedor', 'erro')
        })
}

var timeoutBuscaFornecedor = null

function buscarUsuarioFornecedor() {
    var termo = document.getElementById('busca-fornecedor').value.trim()
    var container = document.getElementById('resultado-busca-fornecedor')

    if (termo.length < 2) {
        container.innerHTML = ''
        return
    }

    clearTimeout(timeoutBuscaFornecedor)
    timeoutBuscaFornecedor = setTimeout(function () {
        fetch('/api/v1/admin/buscar-usuarios', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ _csrf: csrfToken, termo: termo })
        })
            .then(function (r) { return r.json() })
            .then(function (dados) {
                if (dados.erro) {
                    container.innerHTML = '<div class="busca-erro">Erro na busca</div>'
                    return
                }

                if (!dados.usuarios || dados.usuarios.length === 0) {
                    container.innerHTML = '<div class="busca-vazio">Nenhum usuario encontrado</div>'
                    return
                }

                var html = ''
                dados.usuarios.forEach(function (u) {
                    var avatarUrl = u.avatar ? '/static/images/avatar-default.png' : '/static/images/avatar-default.png'
                    var jeFornecedor = u.is_fornecedor ? ' (Ja e fornecedor)' : ''
                    var btnClass = u.is_fornecedor ? 'btn-toggle' : 'btn-criar'
                    var btnText = u.is_fornecedor ? 'Remover' : 'Adicionar'
                    var btnAction = u.is_fornecedor ? 'removerFornecedor' : 'adicionarFornecedor'
                    html += '<div class="busca-item">' +
                        '<img src="' + avatarUrl + '" class="busca-avatar">' +
                        '<div class="busca-info">' +
                        '<span class="busca-nome">' + (u.username || 'N/A') + jeFornecedor + '</span>' +
                        '<span class="busca-id">' + u.user_id + '</span>' +
                        '</div>' +
                        '<button class="btn-acao ' + btnClass + '" onclick="' + btnAction + '(\'' + u.user_id + '\', \'' + (u.username || 'N/A') + '\')">' + btnText + '</button>' +
                        '</div>'
                })
                container.innerHTML = html
            })
            .catch(function (erro) {
                container.innerHTML = '<div class="busca-erro">Erro ao buscar</div>'
            })
    }, 300)
}

function carregarFornecedores() {
    var tbody = document.getElementById('fornecedores-tbody')
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;">Carregando...</td></tr>'

    fetch('/api/v1/admin/listar-fornecedores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _csrf: csrfToken })
    })
        .then(function (r) { return r.json() })
        .then(function (dados) {
            if (dados.erro) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#f87171">Erro ao carregar</td></tr>'
                return
            }

            document.getElementById('total-fornecedores').textContent = dados.total || 0
            document.getElementById('preco-fornecedor-sala').textContent = 'R$ ' + (dados.preco_sala || 0.10).toFixed(2).replace('.', ',')
            document.getElementById('preco-fornecedor-credito').textContent = 'R$ ' + (dados.preco_credito || 0.10).toFixed(2).replace('.', ',')
            document.getElementById('fornecedor-preco-sala').value = dados.preco_sala || 0.10
            document.getElementById('fornecedor-preco-credito').value = dados.preco_credito || 0.10

            if (!dados.fornecedores || dados.fornecedores.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#666">Nenhum fornecedor cadastrado</td></tr>'
                return
            }

            var html = ''
            dados.fornecedores.forEach(function (f) {
                var avatarUrl = f.avatar ? '/static/images/avatar-default.png' : '/static/images/avatar-default.png'
                html += '<tr>' +
                    '<td><img src="' + avatarUrl + '" class="user-avatar-small" loading="lazy"></td>' +
                    '<td>' + (f.username || 'N/A') + '</td>' +
                    '<td><span class="key-value-small">' + f.user_id + '</span></td>' +
                    '<td>' + (f.adicionado_em || 'N/A') + '</td>' +
                    '<td><button class="btn-acao btn-deletar" onclick="removerFornecedor(\'' + f.user_id + '\', \'' + (f.username || 'N/A') + '\')">Remover</button></td>' +
                    '</tr>'
            })
            tbody.innerHTML = html
        })
        .catch(function (erro) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#f87171">Erro ao carregar</td></tr>'
        })
}

function salvarPrecosFornecedor() {
    var precoSala = parseFloat(document.getElementById('fornecedor-preco-sala').value) || 0.10
    var precoCredito = parseFloat(document.getElementById('fornecedor-preco-credito').value) || 0.10

    fetch('/api/v1/admin/salvar-precos-fornecedor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _csrf: csrfToken, preco_sala: precoSala, preco_credito: precoCredito })
    })
        .then(function (r) { return r.json() })
        .then(function (dados) {
            if (dados.sucesso) {
                mostrarToast('Precos atualizados!', 'sucesso')
                carregarFornecedores()
            } else {
                mostrarToast('Erro: ' + (dados.msg || 'Erro desconhecido'), 'erro')
            }
        })
        .catch(function (erro) {
            mostrarToast('Erro ao salvar precos', 'erro')
        })
}

function carregarPagamentos() {
    fetch('/admin/api/listar-pagamentos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _csrf: csrfToken, data: criptografarDados({}) })
    })
        .then(function (r) { return r.json() })
        .then(function (dados) {
            if (dados.erro) return

            document.getElementById('pagamentos-hoje').textContent = dados.pagamentos_hoje || 0
            document.getElementById('total-arrecadado').textContent = 'R$ ' + (dados.total_arrecadado || 0).toFixed(2).replace('.', ',')
            document.getElementById('pagamentos-pendentes').textContent = dados.pagamentos_pendentes || 0

            document.getElementById('lucro-diario').textContent = 'R$ ' + (dados.lucro_diario || 0).toFixed(2).replace('.', ',')
            document.getElementById('lucro-semanal').textContent = 'R$ ' + (dados.lucro_semanal || 0).toFixed(2).replace('.', ',')
            document.getElementById('lucro-mensal').textContent = 'R$ ' + (dados.lucro_mensal || 0).toFixed(2).replace('.', ',')
            document.getElementById('lucro-total').textContent = 'R$ ' + (dados.lucro_total || 0).toFixed(2).replace('.', ',')

            var tbody = document.getElementById('pagamentos-tbody')
            tbody.innerHTML = ''

            if (dados.pagamentos && dados.pagamentos.length > 0) {
                dados.pagamentos.forEach(function (pag) {
                    var tr = document.createElement('tr')
                    var statusClass = pag.status === 'PAGO' ? 'status-ativo' : 'status-inativo'
                    tr.innerHTML = '<td>' + (pag.nome || 'N/A') + '</td>' +
                        '<td>' + (pag.tipo === 'salas' ? 'Salas' : 'Creditos') + '</td>' +
                        '<td>' + pag.quantidade + '</td>' +
                        '<td>R$ ' + pag.valor.toFixed(2).replace('.', ',') + '</td>' +
                        '<td><span class="' + statusClass + '">' + pag.status + '</span></td>' +
                        '<td>' + pag.criado_em + '</td>'
                    tbody.appendChild(tr)
                })
            } else {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#666">Nenhum pagamento encontrado</td></tr>'
            }
        })
}

function carregarConfiguracoes() {
    fetch('/api/pagamento/config')
        .then(function (r) { return r.json() })
        .then(function (dados) {
            document.getElementById('valor-por-sala').value = dados.valor_por_sala || 0.10
            document.getElementById('valor-por-credito').value = dados.valor_por_credito || 0.10
            document.getElementById('minimo-salas').value = dados.minimo_salas || 20
            document.getElementById('minimo-creditos').value = dados.minimo_creditos || 1
            document.getElementById('pix-expiracao').value = dados.expiracao_pix || 3600
        })
}

function salvarConfiguracoes() {
    var config = {
        valor_por_sala: parseFloat(document.getElementById('valor-por-sala').value) || 0.10,
        valor_por_credito: parseFloat(document.getElementById('valor-por-credito').value) || 0.10,
        minimo_salas: parseInt(document.getElementById('minimo-salas').value) || 20,
        minimo_creditos: parseInt(document.getElementById('minimo-creditos').value) || 1,
        expiracao_pix: parseInt(document.getElementById('pix-expiracao').value) || 3600
    }

    fetch('/admin/api/salvar-config-pagamento', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _csrf: csrfToken, data: criptografarDados(config) })
    })
        .then(function (r) { return r.json() })
        .then(function (dados) {
            if (dados.sucesso) {
                mostrarToast('Configuracoes salvas!', 'sucesso')
            } else {
                mostrarToast('Erro ao salvar: ' + (dados.msg || 'Erro desconhecido'), 'erro')
            }
        })
}

function carregarTelegramVips() {
    fetch('/api/v1/admin/telegram/listar-permissoes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    })
        .then(function (r) { return r.json() })
        .then(function (dados) {
            if (dados.erro) return

            document.getElementById('total-telegram-vips').textContent = (dados.vips || []).length

            var config = dados.config || {}
            var updateIntervalEl = document.getElementById('telegram-update-interval')
            if (updateIntervalEl && config.update_interval) {
                updateIntervalEl.value = config.update_interval
            }

            renderizarTabelaTelegram('telegram-vips-tbody', dados.vips || [], 'vip')
        })
        .catch(function (erro) {
            console.error('Erro ao carregar VIPs Telegram:', erro)
        })
}

function renderizarTabelaTelegram(tbodyId, lista, tipo) {
    var tbody = document.getElementById(tbodyId)

    if (!lista || lista.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#666">Nenhum ' + tipo + ' cadastrado</td></tr>'
        return
    }

    var html = ''
    lista.forEach(function (item) {
        var avatarUrl = item.avatar || '/static/images/avatar-default.png'
        var expiraTexto = item.tipo === 'permanente' ? 'Permanente' : (item.expira_em ? item.expira_em.split(' ')[0] : 'N/A')
        var statusClass = item.expirado ? 'status-expirado' : 'status-ativo'
        var statusTexto = item.expirado ? 'Expirado' : 'Ativo'
        var tipoTexto = (item.tipo || 'permanente').charAt(0).toUpperCase() + (item.tipo || 'permanente').slice(1)

        html += '<tr>' +
            '<td><img src="' + avatarUrl + '" class="user-avatar-small" loading="lazy"></td>' +
            '<td>' + (item.username || 'N/A') + '</td>' +
            '<td><span class="key-value-small">' + (item.user_id || 'N/A') + '</span></td>' +
            '<td>' + tipoTexto + '</td>' +
            '<td>' + expiraTexto + ' <span class="' + statusClass + '">' + statusTexto + '</span></td>' +
            '<td><button class="btn-danger" onclick="removerTelegramPermissao(\'' + item.user_id + '\', \'' + tipo + '\')">Remover</button></td>' +
            '</tr>'
    })
    tbody.innerHTML = html
}

function adicionarVipTelegram() {
    var userId = document.getElementById('telegram-vip-userid').value.trim()
    var duracao = document.getElementById('telegram-vip-duracao').value

    if (!userId) {
        mostrarToast('User ID e obrigatorio!', 'aviso')
        return
    }

    fetch('/api/v1/admin/telegram/adicionar-vip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            user_id: userId,
            tipo_duracao: duracao
        })
    })
        .then(function (r) { return r.json() })
        .then(function (dados) {
            if (dados.sucesso) {
                mostrarToast('VIP adicionado!', 'sucesso')
                document.getElementById('telegram-vip-userid').value = ''
                carregarTelegramVips()
            } else {
                mostrarToast('Erro: ' + (dados.msg || dados.erro || 'Erro desconhecido'), 'erro')
            }
        })
        .catch(function (erro) {
            mostrarToast('Erro ao adicionar', 'erro')
        })
}

function removerTelegramPermissao(userId, tipo) {
    if (!confirm('Remover este ' + tipo + '?')) return

    var endpoint = ''
    if (tipo === 'vip') {
        endpoint = '/api/v1/admin/telegram/remover-vip'
    } else if (tipo === 'admin') {
        endpoint = '/api/v1/admin/telegram/remover-admin'
    } else {
        mostrarToast('Nao e possivel remover donos diretamente', 'aviso')
        return
    }

    fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            _csrf: csrfToken,
            user_id: userId
        })
    })
        .then(function (r) { return r.json() })
        .then(function (dados) {
            if (dados.sucesso) {
                mostrarToast(tipo.charAt(0).toUpperCase() + tipo.slice(1) + ' removido!', 'sucesso')
                carregarTelegramVips()
            } else {
                mostrarToast('Erro: ' + (dados.msg || 'Erro desconhecido'), 'erro')
            }
        })
        .catch(function (erro) {
            mostrarToast('Erro ao remover', 'erro')
        })
}

function salvarConfigTelegram() {
    var updateInterval = parseInt(document.getElementById('telegram-update-interval').value) || 10

    fetch('/api/v1/admin/telegram/salvar-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            _csrf: csrfToken,
            update_interval: updateInterval
        })
    })
        .then(function (r) { return r.json() })
        .then(function (dados) {
            if (dados.sucesso) {
                mostrarToast('Configuracoes salvas!', 'sucesso')
            } else {
                mostrarToast('Erro: ' + (dados.msg || 'Erro desconhecido'), 'erro')
            }
        })
        .catch(function (erro) {
            mostrarToast('Erro ao salvar configuracoes', 'erro')
        })
}

var DONO_ID = 'admin_local'

function adicionarAdminDashboard() {
    var userId = document.getElementById('admin-user-id').value.trim()

    if (!userId) {
        mostrarToast('Preencha o User ID', 'aviso')
        return
    }

    fetch('/api/v1/admin/dashboard/adicionar-admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId })
    })
        .then(function (r) { return r.json() })
        .then(function (data) {
            if (data.sucesso) {
                mostrarToast('Admin adicionado!', 'sucesso')
                document.getElementById('admin-user-id').value = ''
                carregarAdminsDashboard()
            } else {
                mostrarToast('Erro: ' + (data.erro || data.msg || 'Falha'), 'erro')
            }
        })
}

function removerAdminDashboard(userId) {
    if (!confirm('Remover admin?')) return

    fetch('/api/v1/admin/dashboard/remover-admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId })
    })
        .then(function (r) { return r.json() })
        .then(function (data) {
            if (data.sucesso) {
                mostrarToast('Admin removido!', 'sucesso')
                carregarAdminsDashboard()
            } else {
                mostrarToast('Erro ao remover', 'erro')
            }
        })
}

function carregarAdminsDashboard() {
    fetch('/api/v1/admin/dashboard/listar-admins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    })
        .then(function (r) { return r.json() })
        .then(function (data) {
            if (data.sucesso) {
                var admins = data.admins || []
                document.getElementById('total-admins-dashboard').textContent = admins.length

                var tbody = document.getElementById('admins-dashboard-tbody')
                tbody.innerHTML = ''

                if (admins.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#666">Nenhum admin cadastrado</td></tr>'
                    return
                }

                admins.forEach(function (a) {
                    var tr = document.createElement('tr')
                    var avatar = a.avatar || '/static/images/avatar-default.png'
                    var isDono = a.cargo === 'dono'
                    var cargoClass = isDono ? 'cargo-dono' : 'cargo-admin'
                    var cargoTexto = isDono ? 'Dono' : 'Admin'
                    var acoes = isDono ? '<span style="color:#666">-</span>' : '<button onclick="removerAdminDashboard(\'' + a.user_id + '\')" class="btn-danger">Remover</button>'

                    tr.innerHTML = '<td><img src="' + avatar + '" class="user-avatar-small" loading="lazy"></td>' +
                        '<td>' + (a.username || 'N/A') + '</td>' +
                        '<td><span class="key-value-small">' + a.user_id + '</span></td>' +
                        '<td><span class="' + cargoClass + '">' + cargoTexto + '</span></td>' +
                        '<td>' + (a.adicionado_em || 'N/A') + '</td>' +
                        '<td>' + acoes + '</td>'

                    tbody.appendChild(tr)
                })
            }
        })
}

var pagamentosOnline = true

function carregarStatusPagamentos() {
    fetch('/api/pagamento/config')
        .then(function (r) { return r.json() })
        .then(function (dados) {
            pagamentosOnline = dados.pagamentos_online !== false
            atualizarBotaoToggle()
            var inputContato = document.getElementById('telegram-contato')
            if (inputContato && dados.telegram_contato) {
                inputContato.value = dados.telegram_contato
            }
            // Gateway fixo: EfiBank
        })
        .catch(function () {
            pagamentosOnline = true
            atualizarBotaoToggle()
        })
}

function salvarContatoTelegram() {
    var inputContato = document.getElementById('telegram-contato')
    if (!inputContato) return

    var contato = inputContato.value.trim().replace('@', '')
    if (!contato) {
        mostrarToast('Digite um usuario do Telegram valido', 'aviso')
        return
    }

    fazerRequestSegura('/admin/api/salvar-config-pagamento', {
        telegram_contato: contato
    }, function (erro, data) {
        if (erro) {
            mostrarToast('Erro ao salvar contato', 'erro')
            return
        }

        if (data.sucesso || (data.dados && data.dados.sucesso)) {
            mostrarToast('Contato @' + contato + ' salvo!', 'sucesso')
        } else {
            mostrarToast('Erro ao salvar: ' + (data.erro || data.msg || 'Erro desconhecido'), 'erro')
        }
    })
}

function atualizarBotaoToggle() {
    var btn = document.getElementById('btn-toggle-pagamentos')
    if (!btn) return

    if (pagamentosOnline) {
        btn.className = 'btn-toggle-status online'
        btn.querySelector('.toggle-text').textContent = 'ONLINE'
    } else {
        btn.className = 'btn-toggle-status offline'
        btn.querySelector('.toggle-text').textContent = 'OFFLINE'
    }
}

function togglePagamentos() {
    var novoStatus = !pagamentosOnline

    fazerRequestSegura('/admin/api/salvar-config-pagamento', {
        pagamentos_online: novoStatus
    }, function (erro, data) {
        if (erro) {
            mostrarToast('Erro ao atualizar status dos pagamentos', 'erro')
            return
        }

        if (data.sucesso || (data.dados && data.dados.sucesso)) {
            pagamentosOnline = novoStatus
            atualizarBotaoToggle()
            mostrarToast('Pagamentos ' + (novoStatus ? 'ATIVADOS' : 'DESATIVADOS') + '!', novoStatus ? 'sucesso' : 'aviso')
        } else {
            mostrarToast('Erro ao atualizar: ' + (data.erro || data.msg || 'Erro desconhecido'), 'erro')
        }
    })
}

// salvarGateway removida - gateway fixo EfiBank


function executarOperacaoMassa() {
    var modo = document.getElementById('massa-modo').value
    var quantidade = parseInt(document.getElementById('massa-quantidade').value) || 0

    if (quantidade <= 0) {
        mostrarToast('Quantidade deve ser maior que 0', 'aviso')
        return
    }

    var modoTexto = modo === 'global' ? 'TODAS as keys ativas' : 'usuarios do Telegram'
    if (!confirm('Tem certeza que deseja adicionar +' + quantidade + ' salas em ' + modoTexto + '?')) {
        return
    }

    var btn = document.getElementById('btn-massa')
    btn.disabled = true
    btn.textContent = 'Executando...'

    var resultadoDiv = document.getElementById('massa-resultado')
    resultadoDiv.style.display = 'none'

    fazerRequestSegura('/admin/api/operacao-massa', {
        modo: modo,
        quantidade: quantidade
    }, function (erro, data) {
        btn.disabled = false
        btn.textContent = 'Executar Operação'

        if (erro) {
            mostrarToast('Erro ao executar operacao', 'erro')
            return
        }

        if (data.sucesso && data.resultado) {
            var r = data.resultado
            var texto = r.msg + '<br>'
            if (r.keys_atualizadas !== undefined) {
                texto += 'Keys atualizadas: ' + r.keys_atualizadas + ' | Ignoradas: ' + r.keys_ignoradas
            }
            if (r.usuarios_atualizados !== undefined) {
                texto += 'Usuarios atualizados: ' + r.usuarios_atualizados + ' | Ignorados: ' + r.usuarios_ignorados
            }
            texto += '<br>Total de salas adicionadas: ' + r.total_salas_adicionadas

            document.getElementById('massa-resultado-texto').innerHTML = texto
            resultadoDiv.style.display = 'block'
            mostrarToast('Operacao concluida!', 'sucesso')
            carregarKeys()
        } else {
            mostrarToast('Erro: ' + (data.erro || 'Erro desconhecido'), 'erro')
        }
    })
}

var avisoImagemBase64 = ''

document.addEventListener('DOMContentLoaded', function () {
    var inputImagem = document.getElementById('aviso-imagem')
    if (inputImagem) {
        inputImagem.addEventListener('change', function (e) {
            var arquivo = e.target.files[0]
            if (!arquivo) return
            if (arquivo.size > 5 * 1024 * 1024) {
                mostrarToast('Imagem deve ter no maximo 5MB', 'erro')
                e.target.value = ''
                return
            }
            var leitor = new FileReader()
            leitor.onload = function (ev) {
                avisoImagemBase64 = ev.target.result
                document.getElementById('aviso-imagem-prev').src = avisoImagemBase64
                document.getElementById('aviso-imagem-preview').style.display = 'block'
            }
            leitor.readAsDataURL(arquivo)
        })
    }
})

function limparImagemAviso() {
    avisoImagemBase64 = ''
    var inputImagem = document.getElementById('aviso-imagem')
    if (inputImagem) inputImagem.value = ''
    document.getElementById('aviso-imagem-preview').style.display = 'none'
    document.getElementById('aviso-imagem-prev').src = ''
}

function carregarAvisos() {
    fetch('/api/v1/admin/avisos/listar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    })
        .then(function (r) { return r.json() })
        .then(function (dados) {
            if (!dados.sucesso) return

            var avisos = dados.avisos || []
            document.getElementById('total-avisos').textContent = avisos.length

            var container = document.getElementById('avisos-lista')
            container.innerHTML = ''

            if (avisos.length === 0) {
                container.innerHTML = '<div style="text-align:center;color:#666;padding:30px;">Nenhum aviso publicado</div>'
                return
            }

            avisos.forEach(function (aviso) {
                var card = document.createElement('div')
                card.style.cssText = 'background:#1a1a2e;border:1px solid #333;border-radius:12px;padding:20px;'

                var imgHtml = ''
                if (aviso.imagem) {
                    imgHtml = '<img src="' + aviso.imagem + '" alt="" style="max-width:100%;max-height:300px;border-radius:8px;margin-bottom:12px;display:block;">'
                }

                card.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;">' +
                    '<div>' +
                    '<h3 style="margin:0;color:#fff;font-size:16px;">' + aviso.titulo + '</h3>' +
                    '<small style="color:#666;">' + aviso.criado_em + '</small>' +
                    '</div>' +
                    '<button onclick="deletarAviso(\'' + aviso.id + '\')" style="background:none;border:1px solid #f44;color:#f44;padding:4px 12px;border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap;">Deletar</button>' +
                    '</div>' +
                    imgHtml +
                    '<p style="color:#ccc;margin:0;white-space:pre-wrap;line-height:1.5;">' + aviso.conteudo + '</p>'

                container.appendChild(card)
            })
        })
}

function criarAviso() {
    var titulo = document.getElementById('aviso-titulo').value.trim()
    var conteudo = document.getElementById('aviso-conteudo').value.trim()

    if (!titulo || titulo.length < 3) {
        mostrarToast('Titulo deve ter pelo menos 3 caracteres', 'erro')
        return
    }
    if (!conteudo || conteudo.length < 3) {
        mostrarToast('Conteudo deve ter pelo menos 3 caracteres', 'erro')
        return
    }

    var dados = {
        titulo: titulo,
        conteudo: conteudo,
        imagem: avisoImagemBase64
    }

    fetch('/api/v1/admin/avisos/criar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dados)
    })
        .then(function (r) { return r.json() })
        .then(function (res) {
            if (res.sucesso) {
                mostrarToast('Aviso publicado!', 'sucesso')
                document.getElementById('aviso-titulo').value = ''
                document.getElementById('aviso-conteudo').value = ''
                limparImagemAviso()
                carregarAvisos()
            } else {
                mostrarToast('Erro: ' + (res.msg || 'Erro desconhecido'), 'erro')
            }
        })
        .catch(function () {
            mostrarToast('Erro ao publicar aviso', 'erro')
        })
}

function deletarAviso(id) {
    if (!confirm('Tem certeza que deseja deletar este aviso?')) return

    fetch('/api/v1/admin/avisos/deletar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id })
    })
        .then(function (r) { return r.json() })
        .then(function (res) {
            if (res.sucesso) {
                mostrarToast('Aviso deletado', 'sucesso')
                carregarAvisos()
            } else {
                mostrarToast('Erro: ' + (res.msg || 'Erro desconhecido'), 'erro')
            }
        })
        .catch(function () {
            mostrarToast('Erro ao deletar aviso', 'erro')
        })
}

// ─── ABA: KEYS MASTERS (PARTNERS) ───

function carregarPartnerKeys(callback) {
    var tbody = document.getElementById('partner-keys-table-body')
    if (tbody) {
        tbody.innerHTML = gerarSkeleton(5, 3)
    }

    fazerRequestSegura('/admin/api/partner-keys/list', null, function (erro, res) {
        if (erro) {
            mostrarToast('Erro ao carregar chaves', 'erro')
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--red)">Erro ao carregar dados do servidor.</td></tr>'
            return
        }

        var keys = (res.dados && res.dados.keys) ? res.dados.keys : []
        partnerKeysCache = keys

        // Limpar o campo de pesquisa ao recarregar
        var searchInput = document.getElementById('search-partner-keys');
        if (searchInput) searchInput.value = '';

        renderizarPartnerKeysList(keys);
        if (typeof callback === 'function') callback();
    })
}

function renderizarPartnerKeysList(keys) {
    var tbody = document.getElementById('partner-keys-table-body')
    if (!tbody) return;

    if (keys.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-muted)">Nenhuma chave master cadastrada.</td></tr>'
        return
    }

    // Ordenar: primeiro as fixadas (fixado === true)
    keys.sort(function (a, b) {
        var aFix = a.fixado === true ? 1 : 0;
        var bFix = b.fixado === true ? 1 : 0;
        if (aFix !== bFix) {
            return bFix - aFix;
        }
        return new Date(b.criada_em || 0) - new Date(a.criada_em || 0);
    });

    var html = ''
    keys.forEach(function (k) {
        var statusBadge = k.ativa 
            ? '<span class="cargo-tag cargo-admin">Ativa</span>' 
            : '<span class="cargo-tag cargo-dono">Inativa</span>'
        
        var safeKey = escapeHtmlPartner(k.key)
        html += '<tr>'
        html += '<td style="font-weight:600">' + escapeHtmlPartner(k.nome) + '</td>'
        html += '<td><code style="font-family:var(--font-mono); font-size:12px; background:var(--bg-surface); padding:2px 6px; border-radius:4px; border:1px solid var(--border)">' + safeKey + '</code></td>'
        html += '<td>' + statusBadge + '</td>'
        html += '<td>' + escapeHtmlPartner(k.criada_em || '-') + '</td>'
        
        html += '<td style="text-align:center">'
        html += '<div style="display:flex; gap:8px; justify-content:center">'
        
        // Botão de Estrela (Fixar/Favoritar)
        var starFill = k.fixado ? 'currentColor' : 'none';
        var starColor = k.fixado ? 'var(--orange)' : 'inherit';
        html += '<button class="btn-tabela-acao btn-editar" onclick="togglePinPartnerKey(\'' + safeKey + '\')" title="Fixar no topo">'
        html += '<svg viewBox="0 0 24 24" fill="' + starFill + '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;color:' + starColor + '"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>'
        html += '</button>'

        html += '<button class="btn-tabela-acao btn-editar" onclick="configurarPartnerKeyGear(\'' + safeKey + '\')" title="Configurar">'
        html += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'
        html += '</button>'
        html += '<button class="btn-tabela-acao btn-remover" onclick="deletarPartnerKey(\'' + safeKey + '\')" title="Deletar">'
        html += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>'
        html += '</button>'
        html += '</div>'
        html += '</td>'
        html += '</tr>'
    })
    tbody.innerHTML = html
}

function filtrarPartnerKeys() {
    var termo = document.getElementById('search-partner-keys').value.toLowerCase().trim();
    if (!partnerKeysCache) return;

    if (termo === '') {
        renderizarPartnerKeysList(partnerKeysCache);
        return;
    }

    var keysFiltradas = partnerKeysCache.filter(function (k) {
        var nome = (k.nome || '').toLowerCase();
        var key = (k.key || '').toLowerCase();
        return nome.indexOf(termo) !== -1 || key.indexOf(termo) !== -1;
    });

    renderizarPartnerKeysList(keysFiltradas);
}

function escapeHtmlPartner(text) {
    if (!text) return ''
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
}

function abrirModalAddPartnerKey() {
    document.getElementById('partner-key-nome').value = ''
    document.getElementById('partner-key-val').value = ''
    document.getElementById('modal-partner-key').style.display = 'flex'
}

function fecharModalPartnerKey() {
    document.getElementById('modal-partner-key').style.display = 'none'
}

function gerarPartnerKeyAleatoria() {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    var key = 'neonstore'
    for (var i = 0; i < 20; i++) {
        key += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    document.getElementById('partner-key-val').value = key
}

function confirmarAddPartnerKey() {
    var nome = document.getElementById('partner-key-nome').value.trim()
    var key = document.getElementById('partner-key-val').value.trim()

    if (!nome) {
        mostrarToast('Nome do parceiro é obrigatório', 'erro')
        return
    }

    if (!key) {
        gerarPartnerKeyAleatoria()
        key = document.getElementById('partner-key-val').value.trim()
    }

    fazerRequestSegura('/admin/api/partner-keys/add', { nome: nome, key: key }, function (erro, res) {
        if (erro || !res.sucesso) {
            mostrarToast('Erro: ' + (res ? res.erro : 'Erro ao adicionar chave'), 'erro')
            return
        }

        mostrarToast(res.msg || 'Chave mestre adicionada com sucesso!', 'sucesso')
        fecharModalPartnerKey()
        carregarPartnerKeys()
    })
}

function deletarPartnerKey(key) {
    if (!confirm('Deseja realmente excluir esta Master Key? As requisições de API de parceria associadas a esta chave deixarão de funcionar imediatamente!')) {
        return
    }

    fazerRequestSegura('/admin/api/partner-keys/delete', { key: key }, function (erro, res) {
        if (erro || !res.sucesso) {
            mostrarToast('Erro: ' + (res ? res.erro : 'Erro ao deletar chave'), 'erro')
            return
        }

        mostrarToast(res.msg || 'Chave deletada com sucesso!', 'sucesso')
        carregarPartnerKeys()
    })
}

var _usoIlimitadoTimerInterval = null;

function configurarPartnerKeyGear(key) {
    if (_usoIlimitadoTimerInterval) {
        clearInterval(_usoIlimitadoTimerInterval);
        _usoIlimitadoTimerInterval = null;
    }

    var keyInfo = null
    for (var i = 0; i < partnerKeysCache.length; i++) {
        if (partnerKeysCache[i].key === key) {
            keyInfo = partnerKeysCache[i]
            break
        }
    }

    if (!keyInfo) {
        mostrarToast('Erro ao carregar detalhes da chave', 'erro')
        return
    }

    // Preencher campos básicos das configurações no modal
    document.getElementById('settings-partner-nome').textContent = keyInfo.nome
    document.getElementById('settings-partner-key').textContent = keyInfo.key
    document.getElementById('settings-partner-ativa').checked = Boolean(keyInfo.ativa)
    var semDesconto = Boolean(keyInfo.sem_desconto);
    document.getElementById('settings-partner-sem-desconto').checked = semDesconto;
    
    var expContainer = document.getElementById('settings-partner-uso-ilimitado-exp-container');
    var statusText = document.getElementById('settings-partner-uso-ilimitado-status');
    
    // Resetar/iniciar inputs de tempo
    var diasInicial = '';
    var horasInicial = '';
    var minutosInicial = '';
    
    if (semDesconto && keyInfo.sem_desconto_expira) {
        const expTime = new Date(keyInfo.sem_desconto_expira).getTime();
        const diffMs = expTime - Date.now();
        if (diffMs > 0) {
            const diffMinTotal = Math.floor(diffMs / 60000);
            minutosInicial = diffMinTotal % 60;
            const horasTotal = Math.floor(diffMinTotal / 60);
            horasInicial = horasTotal % 24;
            diasInicial = Math.floor(horasTotal / 24);
        }
    }
    
    document.getElementById('settings-partner-uso-ilimitado-dias').value = diasInicial;
    document.getElementById('settings-partner-uso-ilimitado-horas').value = horasInicial;
    document.getElementById('settings-partner-uso-ilimitado-minutos').value = minutosInicial;
    
    if (semDesconto) {
        expContainer.style.display = 'flex';
        if (keyInfo.sem_desconto_expira) {
            function atualizarTimer() {
                const expTime = new Date(keyInfo.sem_desconto_expira).getTime();
                const diffMs = expTime - Date.now();
                if (diffMs > 0) {
                    const diffSegTotal = Math.floor(diffMs / 1000);
                    const seg = diffSegTotal % 60;
                    const diffMinTotal = Math.floor(diffSegTotal / 60);
                    const min = diffMinTotal % 60;
                    const horasTotal = Math.floor(diffMinTotal / 60);
                    const horas = horasTotal % 24;
                    const dias = Math.floor(horasTotal / 24);
                    
                    statusText.style.color = '#4caf50';
                    statusText.textContent = 'Ativo (Restam ' + dias + 'd ' + horas + 'h ' + min + 'm ' + seg + 's)';
                } else {
                    statusText.style.color = '#f44336';
                    statusText.textContent = 'Expirado';
                    if (_usoIlimitadoTimerInterval) {
                        clearInterval(_usoIlimitadoTimerInterval);
                        _usoIlimitadoTimerInterval = null;
                    }
                }
            }
            atualizarTimer();
            _usoIlimitadoTimerInterval = setInterval(atualizarTimer, 1000);
        } else {
            statusText.style.color = '#2196f3';
            statusText.textContent = 'Ativo permanentemente';
        }
    } else {
        if (keyInfo.sem_desconto_expirou) {
            expContainer.style.display = 'flex';
            statusText.style.color = '#f44336';
            statusText.textContent = 'Expirado';
        } else {
            expContainer.style.display = 'none';
            statusText.textContent = '';
        }
    }
    
    document.getElementById('settings-partner-bloquear-compartilhamento').checked = Boolean(keyInfo.bloquear_compartilhamento)
    document.getElementById('settings-partner-valor-sala').value = keyInfo.valor_por_sala !== undefined ? parseFloat(keyInfo.valor_por_sala) : ''

    // Preencher campos do sistema de afiliado
    var afiliadoAtivo = Boolean(keyInfo.afiliado_ativo)
    document.getElementById('settings-partner-afiliado-ativo').checked = afiliadoAtivo
    document.getElementById('settings-partner-afiliado-taxa').value = keyInfo.afiliado_taxa !== undefined ? keyInfo.afiliado_taxa : ''
    document.getElementById('settings-partner-afiliado-pix').value = keyInfo.afiliado_pix !== undefined ? keyInfo.afiliado_pix : ''
    var afiliadoArea = document.getElementById('afiliado-config-area')
    afiliadoArea.style.display = afiliadoAtivo ? 'flex' : 'none'
    document.getElementById('preview-lucro-afiliado').textContent = 'Carregando...'
    document.getElementById('preview-lucro-sistema').textContent = 'Carregando...'
    document.getElementById('preview-lucro-compras').textContent = 'Carregando...'
    document.getElementById('preview-lucro-faturamento').textContent = 'Carregando...'

    // Limpar e preparar seção financeira
    document.getElementById('partner-stats-hoje').textContent = 'Carregando...'
    document.getElementById('partner-stats-arrecadado').textContent = 'Carregando...'
    document.getElementById('partner-stats-pendentes').textContent = 'Carregando...'
    document.getElementById('partner-stats-lucro-diario').textContent = 'Carregando...'
    document.getElementById('partner-stats-lucro-semanal').textContent = 'Carregando...'
    document.getElementById('partner-stats-lucro-mensal').textContent = 'Carregando...'

    var tbody = document.getElementById('partner-payments-table-body')
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--text-muted)">Carregando pagamentos...</td></tr>'

    // Abrir o modal
    document.getElementById('modal-partner-key-settings').style.display = 'flex'

    // Fazer requisição das estatísticas e lista de pagamentos específicos desta chave
    fazerRequestSegura('/admin/api/partner-keys/stats', { key: key }, function (erro, res) {
        if (erro || !res.sucesso) {
            mostrarToast('Erro ao carregar métricas financeiras', 'erro')
            return
        }

        var stats = res.dados || {}

        // Atualizar painel de lucro / stats
        document.getElementById('partner-stats-hoje').textContent = stats.pagamentos_hoje || 0
        document.getElementById('partner-stats-arrecadado').textContent = 'R$ ' + (stats.total_arrecadado || 0).toFixed(2).replace('.', ',')
        document.getElementById('partner-stats-pendentes').textContent = stats.pagamentos_pendentes || 0

        // Atualizar cards de afiliado
        var afiliadoAtivo2 = document.getElementById('settings-partner-afiliado-ativo').checked
        document.getElementById('partner-stats-afiliado-card').style.display = afiliadoAtivo2 ? 'block' : 'none'
        document.getElementById('partner-stats-sistema-card').style.display = afiliadoAtivo2 ? 'block' : 'none'
        if (afiliadoAtivo2) {
            document.getElementById('partner-stats-afiliado-total').textContent = 'R$ ' + (stats.total_afiliado || 0).toFixed(2).replace('.', ',')
            document.getElementById('partner-stats-sistema-total').textContent = 'R$ ' + (stats.total_sistema || 0).toFixed(2).replace('.', ',')
            document.getElementById('preview-lucro-afiliado').textContent = 'R$ ' + (stats.total_afiliado || 0).toFixed(2).replace('.', ',')
            document.getElementById('preview-lucro-sistema').textContent = 'R$ ' + (stats.total_sistema || 0).toFixed(2).replace('.', ',')
            document.getElementById('preview-lucro-compras').textContent = stats.total_compras || 0
            document.getElementById('preview-lucro-faturamento').textContent = 'R$ ' + (stats.total_faturamento || 0).toFixed(2).replace('.', ',')
        } else {
            document.getElementById('preview-lucro-afiliado').textContent = 'R$ 0,00'
            document.getElementById('preview-lucro-sistema').textContent = 'R$ 0,00'
            document.getElementById('preview-lucro-compras').textContent = '0'
            document.getElementById('preview-lucro-faturamento').textContent = 'R$ 0,00'
        }
        document.getElementById('partner-stats-lucro-diario').textContent = 'R$ ' + (stats.lucro_diario || 0).toFixed(2).replace('.', ',')
        document.getElementById('partner-stats-lucro-semanal').textContent = 'R$ ' + (stats.lucro_semanal || 0).toFixed(2).replace('.', ',')
        document.getElementById('partner-stats-lucro-mensal').textContent = 'R$ ' + (stats.lucro_mensal || 0).toFixed(2).replace('.', ',')

        // Atualizar tabela de últimos pagamentos
        var pagamentos = stats.pagamentos || []
        if (pagamentos.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--text-muted)">Nenhum pagamento registrado para este parceiro.</td></tr>'
            return
        }

        var html = ''
        pagamentos.forEach(function (pag) {
            var statusClass = 'cargo-tag cargo-admin' // PAGO
            if (pag.status === 'PENDENTE') {
                statusClass = 'cargo-tag cargo-dono'
            } else if (pag.status === 'ESTORNADO') {
                statusClass = 'cargo-tag cargo-fornecedor'
            }

            var cleanUser = escapeHtmlPartner(pag.user_id || '').replace('discord_', '')

            html += '<tr>'
            html += '<td style="font-weight:600">' + cleanUser + '</td>'
            html += '<td>' + escapeHtmlPartner(pag.tipo || 'Salas') + '</td>'
            html += '<td>' + (pag.quantidade || 0) + '</td>'
            html += '<td>R$ ' + (pag.valor || 0).toFixed(2).replace('.', ',') + '</td>'
            html += '<td><span class="' + statusClass + '">' + escapeHtmlPartner(pag.status) + '</span></td>'
            html += '<td style="font-size:11px; color:var(--text-secondary)">' + escapeHtmlPartner(pag.criado_em || '') + '</td>'
            html += '</tr>'
        })
        tbody.innerHTML = html
    })
}

function fecharModalPartnerKeySettings() {
    document.getElementById('modal-partner-key-settings').style.display = 'none'
}

function onAfiliadoToggle() {
    var ativo = document.getElementById('settings-partner-afiliado-ativo').checked
    var area = document.getElementById('afiliado-config-area')
    area.style.display = ativo ? 'flex' : 'none'
    salvarConfiguracoesPartnerKey()
}

var _afiliadoSaveTimer = null
function onAfiliadoTaxaInput() {
    clearTimeout(_afiliadoSaveTimer)
    _afiliadoSaveTimer = setTimeout(function () {
        salvarConfiguracoesPartnerKey()
    }, 800)
}

function onUsoIlimitadoToggle() {
    if (_usoIlimitadoTimerInterval) {
        clearInterval(_usoIlimitadoTimerInterval);
        _usoIlimitadoTimerInterval = null;
    }
    var semDesconto = document.getElementById('settings-partner-sem-desconto').checked;
    var expContainer = document.getElementById('settings-partner-uso-ilimitado-exp-container');
    if (semDesconto) {
        expContainer.style.display = 'flex';
    } else {
        expContainer.style.display = 'none';
        document.getElementById('settings-partner-uso-ilimitado-status').textContent = '';
    }
    salvarConfiguracoesPartnerKey();
}

function salvarConfiguracoesPartnerKey() {
    var key = document.getElementById('settings-partner-key').textContent.trim()
    var valorSalaInput = document.getElementById('settings-partner-valor-sala').value.trim()
    var ativa = document.getElementById('settings-partner-ativa').checked
    var semDesconto = document.getElementById('settings-partner-sem-desconto').checked
    var bloquearCompartilhamento = document.getElementById('settings-partner-bloquear-compartilhamento').checked
    var afiliadoAtivo = document.getElementById('settings-partner-afiliado-ativo').checked
    var afiliadoTaxaInput = document.getElementById('settings-partner-afiliado-taxa').value.trim()
    var afiliadoPix = document.getElementById('settings-partner-afiliado-pix').value.trim()

    var expDias = parseInt(document.getElementById('settings-partner-uso-ilimitado-dias').value) || 0
    var expHoras = parseInt(document.getElementById('settings-partner-uso-ilimitado-horas').value) || 0
    var expMinutos = parseInt(document.getElementById('settings-partner-uso-ilimitado-minutos').value) || 0

    var valorSala = 0.10
    if (valorSalaInput) {
        var parsed = parseFloat(valorSalaInput.replace(',', '.'))
        if (!isNaN(parsed) && parsed > 0) {
            valorSala = parsed
        }
    }

    var afiliadoTaxa = 0
    if (afiliadoAtivo && afiliadoTaxaInput) {
        var parsedTaxa = parseFloat(afiliadoTaxaInput)
        if (!isNaN(parsedTaxa) && parsedTaxa > 0 && parsedTaxa < 100) {
            afiliadoTaxa = parsedTaxa
        }
    }

    fazerRequestSegura('/admin/api/partner-keys/save-config', {
        key: key,
        valor_por_sala: valorSala,
        ativa: ativa,
        sem_desconto: semDesconto,
        uso_ilimitado_dias: expDias,
        uso_ilimitado_horas: expHoras,
        uso_ilimitado_minutos: expMinutos,
        bloquear_compartilhamento: bloquearCompartilhamento,
        afiliado_ativo: afiliadoAtivo,
        afiliado_taxa: afiliadoTaxa,
        afiliado_pix: afiliadoPix
    }, function (erro, res) {
        if (erro || !res.sucesso) {
            mostrarToast('Erro: ' + (res ? res.erro : 'Erro ao salvar configurações'), 'erro')
            return
        }

        mostrarToast(res.msg || 'Configurações do parceiro salvas com sucesso!', 'sucesso')
        carregarPartnerKeys(function () {
            configurarPartnerKeyGear(key);
        })
    })
}

function resetarLucrosParceiro() {
    var key = document.getElementById('settings-partner-key').textContent.trim()
    if (!key) return;

    if (!confirm('Tem certeza que deseja zerar os lucros acumulados do afiliado e do sistema para este parceiro?')) {
        return;
    }

    fazerRequestSegura('/admin/api/partner-keys/reset-lucro', { key: key }, function (erro, res) {
        if (erro || !res.sucesso) {
            mostrarToast('Erro: ' + (res ? res.erro : 'Erro ao resetar lucros'), 'erro')
            return
        }

        mostrarToast(res.msg || 'Valores de lucro zerados com sucesso!', 'sucesso')
        
        carregarPartnerKeys()
        
        var partnerKeys = partnerKeysCache || []
        var keyInfo = partnerKeys.find(function (k) { return k.key === key })
        if (keyInfo) {
            abrirModalPartnerKeySettings(keyInfo)
        } else {
            fecharModalPartnerKeySettings()
        }
    })
}

var _statusBotUpdateInterval = null;

function carregarStatusBot() {
    var tbody = document.getElementById('status-bot-table-body');
    if (tbody && (tbody.innerHTML.indexOf('Carregando') !== -1 || tbody.innerHTML.trim() === '')) {
        tbody.innerHTML = gerarSkeleton(5, 5);
    }

    fazerRequestSegura('/admin/api/status-bot', null, function (erro, res) {
        if (erro) {
            mostrarToast('Erro ao obter status do bot', 'erro');
            if (tbody) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--red)">Erro ao conectar na bridge do bot.</td></tr>';
            }
            return;
        }

        // Preencher estatísticas dos cards
        var maxConc = res.max_concurrent !== undefined ? res.max_concurrent : '—';
        var onlineVal = (res.contas_online !== undefined) ? res.contas_online + ' / ' + maxConc : '—';
        var standbyVal = (res.contas_standby !== undefined) ? res.contas_standby : '—';
        var salasVal = (res.salas_ativas_no_momento !== undefined) ? res.salas_ativas_no_momento : '—';
        var blacklistVal = (res.contas_blacklist !== undefined) ? res.contas_blacklist : '—';
        var substVal = (res.contas_substituidas !== undefined) ? res.contas_substituidas : '—';

        var elOnline = document.getElementById('status-contas-online-total');
        if (elOnline) elOnline.textContent = onlineVal;
        
        var elStandby = document.getElementById('status-contas-standby');
        if (elStandby) elStandby.textContent = standbyVal;

        var elSalas = document.getElementById('status-salas-momento');
        if (elSalas) elSalas.textContent = salasVal;

        var elBlack = document.getElementById('status-contas-blacklist');
        if (elBlack) elBlack.textContent = blacklistVal;

        var elSubst = document.getElementById('status-contas-substituidas');
        if (elSubst) elSubst.textContent = substVal;

        var geradorEl = document.getElementById('status-gerador-status');
        if (geradorEl) {
            if (res.gerador_em_andamento) {
                geradorEl.innerHTML = '<span style="color:var(--green); font-weight:600">Gerando contas</span>';
            } else {
                geradorEl.innerHTML = '<span style="color:var(--text-muted)">Parado</span>';
            }
        }

        // Preencher tabela de contas
        if (tbody) {
            var contas = res.contas || [];
            if (contas.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-muted)">Nenhuma conta registrada no bot.</td></tr>';
                return;
            }

            // Ordenar contas: online primeiro, offline depois
            contas.sort(function (a, b) {
                if (a.online && !b.online) return -1;
                if (!a.online && b.online) return 1;
                return 0;
            });

            var html = '';
            contas.forEach(function (c) {
                var statusBadge = c.online 
                    ? '<span class="cargo-tag cargo-admin">Online</span>' 
                    : '<span class="cargo-tag cargo-dono">Offline</span>';
                
                var estadoBadge = c.em_sala 
                    ? '<span style="color:var(--orange); font-weight:600">Em Sala</span>' 
                    : '<span style="color:var(--green); font-weight:600">Livre</span>';
                
                var chatBadge = c.chat_conectado 
                    ? '<span style="color:var(--green)">Conectado</span>' 
                    : '<span style="color:var(--text-muted)">Desconectado</span>';

                html += '<tr>';
                html += '<td><code style="font-family:var(--font-mono); font-size:12px; background:var(--bg-surface); padding:2px 6px; border-radius:4px; border:1px solid var(--border)">' + escapeHtmlPartner(c.account_id) + '</code></td>';
                html += '<td style="font-weight:600">' + escapeHtmlPartner(c.nickname) + '</td>';
                html += '<td>' + statusBadge + '</td>';
                html += '<td>' + estadoBadge + '</td>';
                html += '<td>' + chatBadge + '</td>';
                html += '</tr>';
            });
            tbody.innerHTML = html;
        }
    });
}

function togglePinPartnerKey(key) {
    fazerRequestSegura('/admin/api/partner-keys/toggle-pin', { key: key }, function (erro, res) {
        if (erro || !res.sucesso) {
            mostrarToast('Erro ao alterar fixação da chave', 'erro');
            return;
        }
        mostrarToast(res.msg, 'sucesso');
        carregarPartnerKeys();
    });
}

// ─── Turbofy Pay Integration Frontend ───
var checkPixInterval = null;

function carregarTurbofyInfo() {
    fazerRequestSegura('/admin/api/turbofy/info', {}, function (erro, dados) {
        if (erro) {
            console.error('Erro ao carregar info do Turbofy:', erro);
            return;
        }
        
        var resDados = dados.dados || {};
        var saldo = resDados.saldo || 0.0;
        var depositos = resDados.depositos || [];
        
        var saldoEl = document.getElementById('turbofy-saldo-display');
        if (saldoEl) {
            saldoEl.textContent = 'R$ ' + saldo.toFixed(2).replace('.', ',');
        }
        
        var listaEl = document.getElementById('turbofy-depositos-lista');
        if (!listaEl) return;
        
        listaEl.innerHTML = '';
        
        if (depositos.length === 0) {
            listaEl.innerHTML = '<div style="font-size: 12px; color: var(--text-muted); text-align: center; padding: 10px 0;">Nenhum depósito realizado</div>';
            return;
        }
        
        depositos.forEach(function (dep) {
            var item = document.createElement('div');
            item.style.display = 'flex';
            item.style.alignItems = 'center';
            item.style.justifyContent = 'space-between';
            item.style.padding = '8px 12px';
            item.style.background = 'var(--bg-surface-hover, rgba(255,255,255,0.02))';
            item.style.borderRadius = '6px';
            item.style.border = '1px solid var(--border)';
            item.style.fontSize = '12px';
            
            var statusColor = 'var(--text-muted)';
            var statusText = dep.status;
            if (dep.status === 'PAID') {
                statusColor = 'var(--success)';
                statusText = 'Pago';
            } else if (dep.status === 'PENDING' || dep.status === 'ACTIVE') {
                statusColor = 'var(--warning)';
                statusText = 'Pendente';
            } else {
                statusColor = 'var(--danger)';
            }
            
            var infoHtml = '<div>' +
                '<span style="font-weight:600;color:var(--text-primary)">R$ ' + dep.valor.toFixed(2).replace('.', ',') + '</span> ' +
                '<span style="color:' + statusColor + ';margin-left:8px;font-weight:500">' + statusText + '</span>' +
                '<div style="font-size:10px;color:var(--text-muted);margin-top:2px">' + dep.criado_em + '</div>' +
                '</div>';
                
            var acoesHtml = '<div style="display:flex;gap:6px;">';
            if (dep.status === 'PENDING' || dep.status === 'ACTIVE') {
                acoesHtml += '<button class="btn-sm btn-ghost" onclick="mostrarQRPixExistente(\'' + dep.copia_cola.replace(/'/g, "\\'") + '\', \'' + dep.qr_code + '\', \'' + dep.id + '\')" style="padding:4px 8px;font-size:11px">QR Code</button>';
                acoesHtml += '<button class="btn-sm btn-criar" id="btn-verif-' + dep.id + '" onclick="verificarPixTurbofy(\'' + dep.id + '\')" style="padding:4px 8px;font-size:11px">Verificar</button>';
            }
            acoesHtml += '</div>';
            
            item.innerHTML = infoHtml + acoesHtml;
            listaEl.appendChild(item);
        });
    });
}

function abrirModalDepositoTurbofy() {
    document.getElementById('turbofy-deposito-valor').value = '10.00';
    document.getElementById('turbofy-etapa-valor').style.display = 'block';
    document.getElementById('turbofy-etapa-pix').style.display = 'none';
    document.getElementById('modal-turbofy-deposito').style.display = 'flex';
}

function fecharModalTurbofy() {
    document.getElementById('modal-turbofy-deposito').style.display = 'none';
    if (checkPixInterval) {
        clearInterval(checkPixInterval);
        checkPixInterval = null;
    }
    carregarTurbofyInfo();
}

function gerarPixTurbofy() {
    var valor = parseFloat(document.getElementById('turbofy-deposito-valor').value);
    if (isNaN(valor) || valor <= 0) {
        mostrarToast('Valor inválido', 'erro');
        return;
    }
    
    var btn = document.querySelector('#turbofy-etapa-valor .btn-criar');
    if (btn) btn.disabled = true;
    
    fazerRequestSegura('/admin/api/turbofy/depositar', { valor: valor }, function (erro, dados) {
        if (btn) btn.disabled = false;
        if (erro) {
            mostrarToast('Erro: ' + erro, 'erro');
            return;
        }
        
        var resDados = dados.dados || {};
        var dep = resDados.deposito;
        if (dep) {
            exibirPixGerado(dep.copia_cola, dep.qr_code, dep.id);
        } else {
            mostrarToast('Erro ao obter dados do PIX', 'erro');
        }
    });
}

function formatarQrCodeSrc(qrCode) {
    if (!qrCode) return '';
    if (qrCode.startsWith('data:image') || qrCode.startsWith('http://') || qrCode.startsWith('https://')) {
        return qrCode;
    }
    return 'data:image/png;base64,' + qrCode;
}

function exibirPixGerado(copiaCola, qrCodeBase64, id) {
    document.getElementById('turbofy-etapa-valor').style.display = 'none';
    document.getElementById('turbofy-etapa-pix').style.display = 'block';
    
    document.getElementById('turbofy-qrcode-img').src = formatarQrCodeSrc(qrCodeBase64);
    document.getElementById('turbofy-copia-cola').value = copiaCola;
    
    if (checkPixInterval) clearInterval(checkPixInterval);
    checkPixInterval = setInterval(function () {
        verificarPixSilencioso(id);
    }, 5000);
}

function mostrarQRPixExistente(copiaCola, qrCodeBase64, id) {
    document.getElementById('turbofy-etapa-valor').style.display = 'none';
    document.getElementById('turbofy-etapa-pix').style.display = 'block';
    document.getElementById('modal-turbofy-deposito').style.display = 'flex';
    
    document.getElementById('turbofy-qrcode-img').src = formatarQrCodeSrc(qrCodeBase64);
    document.getElementById('turbofy-copia-cola').value = copiaCola;
    
    if (checkPixInterval) clearInterval(checkPixInterval);
    checkPixInterval = setInterval(function () {
        verificarPixSilencioso(id);
    }, 5000);
}

function copiarPixTurbofy() {
    var textarea = document.getElementById('turbofy-copia-cola');
    textarea.select();
    textarea.setSelectionRange(0, 99999);
    try {
        document.execCommand('copy');
        mostrarToast('Código Pix copiado!', 'sucesso');
    } catch (e) {
        mostrarToast('Erro ao copiar', 'erro');
    }
}

function verificarPixTurbofy(id) {
    var btn = document.getElementById('btn-verif-' + id);
    if (btn) {
        btn.disabled = true;
        btn.textContent = '...';
    }
    
    fazerRequestSegura('/admin/api/turbofy/consultar-pix', { id: id }, function (erro, dados) {
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Verificar';
        }
        if (erro) {
            mostrarToast('Erro ao consultar: ' + erro, 'erro');
            return;
        }
        
        var resDados = dados.dados || {};
        var dep = resDados.deposito;
        if (dep && dep.status === 'PAID') {
            var creditado = dep.valor_creditado !== undefined ? dep.valor_creditado : parseFloat((dep.valor * 0.975).toFixed(2));
            mostrarToast('Depósito confirmado! R$ ' + creditado.toFixed(2).replace('.', ',') + ' creditados (-2,5%).', 'sucesso');
            fecharModalTurbofy();
        } else {
            mostrarToast('Pagamento ainda não confirmado.', 'info');
        }
    });
}

function verificarPixSilencioso(id) {
    fazerRequestSegura('/admin/api/turbofy/consultar-pix', { id: id }, function (erro, dados) {
        if (erro) return;
        var resDados = dados.dados || {};
        var dep = resDados.deposito;
        if (dep && dep.status === 'PAID') {
            var creditado = dep.valor_creditado !== undefined ? dep.valor_creditado : parseFloat((dep.valor * 0.975).toFixed(2));
            mostrarToast('Depósito confirmado! R$ ' + creditado.toFixed(2).replace('.', ',') + ' creditados (-2,5%).', 'sucesso');
            fecharModalTurbofy();
        }
    });
}
