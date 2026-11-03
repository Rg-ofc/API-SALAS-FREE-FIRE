const { createCanvas, loadImage, registerFont } = require('canvas');
const path = require('path');
const fs = require('fs');

const fontDir = __dirname;
try {
    const oswaldPath = path.join(fontDir, 'Oswald.ttf');
    if (fs.existsSync(oswaldPath)) {
        registerFont(oswaldPath, { family: 'Oswald', weight: 'bold' });
    }
} catch (e) { /* ignore */ }

try {
    const bebasPath = path.join(fontDir, 'BebasNeue.ttf');
    if (fs.existsSync(bebasPath)) {
        registerFont(bebasPath, { family: 'Bebas Neue', weight: 'normal' });
    }
} catch (e) { /* ignore */ }

const TEMPLATE_PATH = path.join(__dirname, 'assets', 'scoreboard_template.png');
let _cachedTemplate = null;

async function getTemplate() {
    if (_cachedTemplate) return _cachedTemplate;
    if (fs.existsSync(TEMPLATE_PATH)) {
        try {
            _cachedTemplate = await loadImage(TEMPLATE_PATH);
            return _cachedTemplate;
        } catch (e) {
            console.error('[CANVAS_SCOREBOARD] Erro ao carregar template:', e.message);
        }
    }
    return null;
}

/**
 * Desenha os textos VENCEDOR e PERDEDOR nos banners.
 */
function desenharBannersTimes(ctx, timeVencedor) {
    ctx.save();

    const isTeam1Winner = (timeVencedor === 1);
    const isTeam2Winner = (timeVencedor === 2);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // Posição Y elevada para centralizar na faixa de cor
    const TEXT_Y = 178;

    // BANNER ESQUERDA (Time 1 - Azul)
    if (isTeam1Winner) {
        ctx.shadowColor = '#FFE066';
        ctx.shadowBlur = 10;
        ctx.font = 'bold 24px "Oswald", "Arial Black", sans-serif';
        ctx.fillStyle = '#FFEB99';
        ctx.fillText('VENCEDOR', 205, TEXT_Y);
    } else {
        ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
        ctx.shadowBlur = 4;
        ctx.font = 'bold 24px "Oswald", "Arial Black", sans-serif';
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText('PERDEDOR', 205, TEXT_Y);
    }

    ctx.restore();
    ctx.save();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // BANNER DIREITA (Time 2 - Laranja)
    if (isTeam2Winner) {
        ctx.shadowColor = '#FFE066';
        ctx.shadowBlur = 10;
        ctx.font = 'bold 24px "Oswald", "Arial Black", sans-serif';
        ctx.fillStyle = '#FFEB99';
        ctx.fillText('VENCEDOR', 815, TEXT_Y);
    } else {
        ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
        ctx.shadowBlur = 4;
        ctx.font = 'bold 24px "Oswald", "Arial Black", sans-serif';
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText('PERDEDOR', 815, TEXT_Y);
    }

    ctx.restore();
}

/**
 * Desenha um slot de jogador (ou vazio) no estilo Free Fire Contra Squad
 */
function desenharSlot(ctx, { x, y, width, height, player, isMvp, isWinnerTeam, slotIndex, kdaCenterX, dmgCenterX }) {
    ctx.save();

    // Fundo 100% opaco escuro para cobrir completamente qualquer resquício da imagem template
    ctx.fillStyle = '#0a0d18';
    ctx.fillRect(x, y, width, height);

    if (player) {
        if (isMvp) {
            // MVP Highlight
            const mvpGrad = ctx.createLinearGradient(x, y, x + width, y);
            mvpGrad.addColorStop(0, 'rgba(212, 138, 20, 0.35)');
            mvpGrad.addColorStop(0.35, 'rgba(18, 26, 45, 0.95)');
            mvpGrad.addColorStop(1, 'rgba(10, 13, 24, 0.98)');
            ctx.fillStyle = mvpGrad;
            ctx.fillRect(x, y, width, height);

            ctx.strokeStyle = '#F1B82D';
            ctx.lineWidth = 1.8;
            ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
        } else if (isWinnerTeam) {
            // Time vencedor
            const winGrad = ctx.createLinearGradient(x, y, x + width, y);
            if (player.team === 2) {
                winGrad.addColorStop(0, 'rgba(215, 65, 17, 0.35)');
                winGrad.addColorStop(0.5, 'rgba(25, 20, 30, 0.95)');
                winGrad.addColorStop(1, 'rgba(10, 12, 22, 0.98)');
                ctx.fillStyle = winGrad;
                ctx.fillRect(x, y, width, height);
                ctx.strokeStyle = 'rgba(224, 78, 29, 0.55)';
            } else {
                winGrad.addColorStop(0, 'rgba(0, 114, 198, 0.35)');
                winGrad.addColorStop(0.5, 'rgba(15, 25, 42, 0.95)');
                winGrad.addColorStop(1, 'rgba(10, 12, 22, 0.98)');
                ctx.fillStyle = winGrad;
                ctx.fillRect(x, y, width, height);
                ctx.strokeStyle = 'rgba(0, 130, 220, 0.55)';
            }
            ctx.lineWidth = 1.2;
            ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
        } else {
            // Time perdedor
            const normGrad = ctx.createLinearGradient(x, y, x + width, y);
            normGrad.addColorStop(0, 'rgba(20, 25, 38, 0.9)');
            normGrad.addColorStop(1, 'rgba(10, 13, 22, 0.98)');
            ctx.fillStyle = normGrad;
            ctx.fillRect(x, y, width, height);

            ctx.strokeStyle = 'rgba(38, 48, 70, 0.45)';
            ctx.lineWidth = 1;
            ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
        }

        // Ícone / Badge
        let contentStartX = x + 8;
        if (isMvp) {
            const badgeW = 38;
            const badgeH = 28;
            const badgeY = y + (height - badgeH) / 2;

            const bGrad = ctx.createLinearGradient(contentStartX, badgeY, contentStartX + badgeW, badgeY + badgeH);
            bGrad.addColorStop(0, '#FFE066');
            bGrad.addColorStop(0.5, '#F5A623');
            bGrad.addColorStop(1, '#BF6800');
            ctx.fillStyle = bGrad;

            ctx.beginPath();
            ctx.moveTo(contentStartX + 5, badgeY);
            ctx.lineTo(contentStartX + badgeW - 5, badgeY);
            ctx.lineTo(contentStartX + badgeW, badgeY + badgeH / 2);
            ctx.lineTo(contentStartX + badgeW - 5, badgeY + badgeH);
            ctx.lineTo(contentStartX + 5, badgeY + badgeH);
            ctx.lineTo(contentStartX, badgeY + badgeH / 2);
            ctx.closePath();
            ctx.fill();

            ctx.fillStyle = '#1A0E00';
            ctx.font = 'bold 13px "Oswald", "Arial Black", sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('MVP', contentStartX + badgeW / 2, badgeY + badgeH / 2);

            contentStartX += badgeW + 10;
        } else {
            const avSize = 28;
            const avY = y + (height - avSize) / 2;

            ctx.fillStyle = 'rgba(25, 35, 55, 0.9)';
            ctx.fillRect(contentStartX, avY, avSize, avSize);
            ctx.strokeStyle = isWinnerTeam ? (player.team === 2 ? '#E04E1D' : '#0072C6') : '#3F4E68';
            ctx.lineWidth = 1;
            ctx.strokeRect(contentStartX, avY, avSize, avSize);

            ctx.fillStyle = '#8FA3BF';
            ctx.font = 'bold 13px "Oswald", sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(slotIndex + 1), contentStartX + avSize / 2, avY + avSize / 2);

            contentStartX += avSize + 10;
        }

        // Nickname
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = 'bold 15px "Oswald", "Arial Black", sans-serif';
        ctx.fillStyle = isMvp ? '#FFF4C2' : '#FFFFFF';

        let nick = player.nickname || 'Jogador';
        if (nick.length > 15) nick = nick.slice(0, 13) + '...';
        ctx.fillText(nick, contentStartX, y + height / 2);

        // K / D / A centralizado exatamente sob o header
        ctx.textAlign = 'center';
        ctx.font = 'bold 16px "Oswald", "Arial Black", sans-serif';
        const kText = `${player.kills || 0}/${player.deaths || 0}/${player.assists || 0}`;
        ctx.fillStyle = isMvp ? '#FFD452' : (isWinnerTeam ? '#5CD2FF' : '#C8D2E4');
        ctx.fillText(kText, kdaCenterX, y + height / 2);

        // DMG centralizado exatamente sob o header
        ctx.textAlign = 'center';
        ctx.font = 'bold 16px "Oswald", "Arial Black", sans-serif';
        ctx.fillStyle = (player.dano || 0) > 0 ? '#FFFFFF' : '#7F8EAA';
        ctx.fillText(String(player.dano || 0), dmgCenterX, y + height / 2);

    } else {
        // Slot Vazio
        ctx.fillStyle = 'rgba(12, 16, 28, 0.95)';
        ctx.fillRect(x, y, width, height);

        ctx.strokeStyle = 'rgba(30, 40, 60, 0.45)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);

        ctx.fillStyle = 'rgba(65, 80, 110, 0.25)';
        ctx.font = '13px "Oswald", sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(`— Slot ${slotIndex + 1} Vazio —`, x + 25, y + height / 2);
    }

    ctx.restore();
}

function desenharRodapeSeguro(ctx) {
    ctx.save();

    // Cobrir o botão VOLTAR original do template (y: 517 a 555, x: 836 a 1010)
    // para não aparecer duplicado
    ctx.fillStyle = 'rgba(11, 7, 20, 1)';
    ctx.fillRect(836, 515, 188, 45);

    // Desenhar 1 único botão VOLTAR
    const btnX = 836;
    const btnY = 520;
    const btnW = 158;
    const btnH = 36;

    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = 8;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(btnX, btnY, btnW, btnH);
    ctx.restore();

    ctx.fillStyle = '#141414';
    ctx.font = 'bold 18px "Oswald", "Arial Black", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('VOLTAR', btnX + btnW / 2, btnY + btnH / 2 + 1);

    ctx.restore();
}

/**
 * Gera o Canvas da tela de Resultado da Partida (1024x560 - inclui botao VOLTAR do template)
 * @param {Object} resultado - Objeto retornado por handle_match_scoreboard
 * @returns {Promise<{ buffer: Buffer, base64: string, dataUri: string }>}
 */
async function gerarCanvasResultado(resultado) {
    const W = 1024;
    const H = 560; // Inclui VOLTAR e NEON STORE do template (y: 533-555)
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    const template = await getTemplate();

    if (template) {
        ctx.drawImage(template, 0, 0, W, 576);
    } else {
        const bgGrad = ctx.createRadialGradient(W / 2, H / 2, 50, W / 2, H / 2, 600);
        bgGrad.addColorStop(0, '#1a1f33');
        bgGrad.addColorStop(1, '#090b14');
        ctx.fillStyle = bgGrad;
        ctx.fillRect(0, 0, W, H);
    }

    // 1. Determinar time vencedor
    const timeVencedor = resultado.time_vencedor || (resultado.vitoria === 'time 2' ? 2 : (resultado.vitoria === 'time 1' ? 1 : 1));
    const mvpUid = String(resultado.mvp || '');

    // 2. Desenhar VENCEDOR e PERDEDOR diretamente sobre os banners (sem nenhuma label escura)
    desenharBannersTimes(ctx, timeVencedor);

    // 3. Coordenadas das duas colunas de jogadores
    const TABLE_Y_START = 247;
    const ROW_HEIGHT = 48;
    const ROW_GAP = 2.5;
    const COL_WIDTH = 478;

    const LEFT_COL_X = 25;   // Time 1
    const RIGHT_COL_X = 521; // Time 2

    // Alinhamento exato das colunas de K/D/A e DMG com os headers do template
    const LEFT_KDA_X = 302;
    const LEFT_DMG_X = 365;

    const RIGHT_KDA_X = 785;
    const RIGHT_DMG_X = 847;

    const players = resultado.players || [];
    const team1Players = players.filter(p => (p.team || 1) === 1);
    const team2Players = players.filter(p => (p.team || 1) === 2);

    // 4 slots do Time 1 (Esquerda)
    for (let i = 0; i < 4; i++) {
        const rowY = TABLE_Y_START + i * (ROW_HEIGHT + ROW_GAP);
        const player = team1Players[i] || null;
        const isMvp = player && String(player.uid) === mvpUid;
        const isWinner = timeVencedor === 1;

        desenharSlot(ctx, {
            x: LEFT_COL_X,
            y: rowY,
            width: COL_WIDTH,
            height: ROW_HEIGHT,
            player: player,
            isMvp: isMvp,
            isWinnerTeam: isWinner,
            slotIndex: i,
            kdaCenterX: LEFT_KDA_X,
            dmgCenterX: LEFT_DMG_X
        });
    }

    // 4 slots do Time 2 (Direita)
    for (let i = 0; i < 4; i++) {
        const rowY = TABLE_Y_START + i * (ROW_HEIGHT + ROW_GAP);
        const player = team2Players[i] || null;
        const isMvp = player && String(player.uid) === mvpUid;
        const isWinner = timeVencedor === 2;

        desenharSlot(ctx, {
            x: RIGHT_COL_X,
            y: rowY,
            width: COL_WIDTH,
            height: ROW_HEIGHT,
            player: player,
            isMvp: isMvp,
            isWinnerTeam: isWinner,
            slotIndex: i,
            kdaCenterX: RIGHT_KDA_X,
            dmgCenterX: RIGHT_DMG_X
        });
    }

    // 4. Desenhar rodapé elevado na Safe Zone (evita corte por barras de 40px em navegadores/modais)
    desenharRodapeSeguro(ctx);

    const buffer = canvas.toBuffer('image/png');
    const base64 = buffer.toString('base64');
    const dataUri = `data:image/png;base64,${base64}`;

    return {
        buffer,
        base64,
        dataUri
    };
}

module.exports = {
    gerarCanvasResultado,
    getTemplate
};
