'use strict';

const { createCanvas, loadImage, registerFont } = require('canvas');
const path = require('path');
const fs = require('fs');
const { characterIcon } = require('./player_skills/character_icons');
const { resolveSkillIcon } = require('./player_skills/skill_catalog');
const { petIcon } = require('./player_skills/pet_catalog');

// Registrar fontes do sistema se disponiveis para suporte total a simbolos Unicode, emojis, escritas especiais (Javanese, Nirmala, Gadugi, etc.)
const FONT_DIR = path.join(__dirname, '..');
try {
    const oswald = path.join(FONT_DIR, 'Oswald.ttf');
    if (fs.existsSync(oswald)) registerFont(oswald, { family: 'Oswald', weight: 'bold' });
} catch { /* ignore */ }

try {
    const bebas = path.join(FONT_DIR, 'BebasNeue.ttf');
    if (fs.existsSync(bebas)) registerFont(bebas, { family: 'Bebas Neue' });
} catch { /* ignore */ }

// Registra fontes Unicode para suporte a 100% dos simbolos de Free Fire (letras goticas, katakana, asas, etc.)
const ASSET_FONTS = path.join(__dirname, '../assets/fonts');
const WIN_FONTS = 'C:\\Windows\\Fonts';
const fontCandidates = [
    { file: 'javatext.ttf', family: 'Javanese Text' },
    { file: 'Nirmala.ttf', family: 'Nirmala UI' },
    { file: 'NirmalaB.ttf', family: 'Nirmala UI', weight: 'bold' },
    { file: 'gadugi.ttf', family: 'Gadugi' },
    { file: 'gadugib.ttf', family: 'Gadugi', weight: 'bold' },
    { file: 'segoeui.ttf', family: 'Segoe UI' },
    { file: 'segoeuib.ttf', family: 'Segoe UI', weight: 'bold' },
    { file: 'seguisym.ttf', family: 'Segoe UI Symbol' },
    { file: 'arial.ttf', family: 'Arial' },
    { file: 'arialbd.ttf', family: 'Arial', weight: 'bold' }
];

for (const c of fontCandidates) {
    try {
        let full = path.join(ASSET_FONTS, c.file);
        if (!fs.existsSync(full)) {
            full = path.join(WIN_FONTS, c.file);
        }
        if (fs.existsSync(full)) {
            registerFont(full, { family: c.family, weight: c.weight });
        }
    } catch { /* ignore */ }
}

// Pilhas de fontes robustas: suporte maximo a caracteres especiais e estetica moderna
const FONT_NICKNAME = 'bold 17px "Segoe UI", "Javanese Text", "Nirmala UI", "Gadugi", "Segoe UI Symbol", "Segoe UI Emoji", "Noto Sans CJK JP", "Noto Sans CJK SC", "Noto Sans CJK KR", "Noto Sans JP", "Noto Color Emoji", "Noto Sans Symbols", "Noto Sans Symbols 2", "Noto Sans", "DejaVu Sans", "Arial", sans-serif';
const FONT_DETAIL = '13px "Segoe UI", "Arial", sans-serif';
const FONT_TITLE = 'bold 36px "Oswald", "Bebas Neue", "Segoe UI", "Arial Black", sans-serif';
const FONT_SUBTITLE = 'bold 20px "Oswald", "Bebas Neue", "Segoe UI", "Arial Black", sans-serif';
const FONT_ROOM_ID = 'bold 26px "Oswald", "Bebas Neue", "Segoe UI", sans-serif';
const FONT_LABEL = 'bold 12px "Oswald", "Segoe UI", sans-serif';
const FONT_BADGE = 'bold 10px "Segoe UI", "Arial", sans-serif';
const FONT_LEVEL = 'bold 11px "Segoe UI", "Arial Black", sans-serif';
const FONT_FOOTER = '13px "Segoe UI", "Arial", sans-serif';

// Cache de imagens em memoria para renderizacao super rapida
const imageCache = new Map();

async function getCachedImage(filePathOrUrl) {
    if (!filePathOrUrl) return null;
    if (imageCache.has(filePathOrUrl)) return imageCache.get(filePathOrUrl);

    try {
        if (typeof filePathOrUrl === 'string' && fs.existsSync(filePathOrUrl)) {
            const buf = fs.readFileSync(filePathOrUrl);
            const img = await loadImage(buf);
            imageCache.set(filePathOrUrl, img);
            return img;
        }
    } catch (e) {
        // Falha ao carregar
    }
    return null;
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
}

/**
 * Renderiza o card "SALA INICIADA" com os dois times e habilidades
 * @param {Object} data 
 * @param {string|number} data.roomId
 * @param {Array} data.time1 - Jogadores do Time 1 (slots 1-4)
 * @param {Array} data.time2 - Jogadores do Time 2 (slots 5-8)
 * @param {string} data.modeName - Nome do modo da sala
 * @param {string} data.systemName - Nome do sistema (padrao: ZYON SYSTEM)
 * @returns {Promise<string>} Base64 data URL da imagem
 */
async function renderSalaIniciadaImage({
    roomId = '00000000',
    time1 = [],
    time2 = [],
    modeName = 'Full Ouro',
    systemName = 'NEON STORE'
}) {
    const W = 1280;
    const H = 720;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    // 1. Fundo Gradiente Escuro Moderno
    const bgGrad = ctx.createLinearGradient(0, 0, W, H);
    bgGrad.addColorStop(0, '#0a0d14');
    bgGrad.addColorStop(0.5, '#0e131f');
    bgGrad.addColorStop(1, '#080a0f');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);

    // Efeito de brilho ambiente atras dos times
    // Brilho azul/cyan no Time 1 (esquerda)
    const glowT1 = ctx.createRadialGradient(250, 360, 50, 250, 360, 450);
    glowT1.addColorStop(0, 'rgba(14, 116, 144, 0.15)');
    glowT1.addColorStop(0.6, 'rgba(2, 132, 199, 0.05)');
    glowT1.addColorStop(1, 'transparent');
    ctx.fillStyle = glowT1;
    ctx.fillRect(0, 0, W / 2, H);

    // Brilho laranja/vermelho no Time 2 (direita)
    const glowT2 = ctx.createRadialGradient(1030, 360, 50, 1030, 360, 450);
    glowT2.addColorStop(0, 'rgba(194, 65, 12, 0.14)');
    glowT2.addColorStop(0.6, 'rgba(225, 29, 72, 0.05)');
    glowT2.addColorStop(1, 'transparent');
    ctx.fillStyle = glowT2;
    ctx.fillRect(W / 2, 0, W / 2, H);

    // Moldura externa elegante com cantos arredondados
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1.5;
    drawRoundedRect(ctx, 16, 16, W - 32, H - 32, 20);
    ctx.stroke();

    // 2. Cabecalho Superior
    // Titulo "SALA INICIADA"
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = FONT_TITLE;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText('SALA INICIADA', 50, 40);

    // Linha de destaque sob o titulo
    const titleWidth = ctx.measureText('SALA INICIADA').width;
    const lineGrad = ctx.createLinearGradient(50, 0, 50 + titleWidth + 30, 0);
    lineGrad.addColorStop(0, '#38bdf8');
    lineGrad.addColorStop(0.8, '#818cf8');
    lineGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = lineGrad;
    ctx.fillRect(50, 84, titleWidth + 40, 3.5);

    // Card ID DA SALA no canto superior direito
    const idCardW = 220;
    const idCardH = 68;
    const idCardX = W - 50 - idCardW;
    const idCardY = 36;

    ctx.fillStyle = 'rgba(20, 26, 40, 0.85)';
    drawRoundedRect(ctx, idCardX, idCardY, idCardW, idCardH, 12);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.font = FONT_LABEL;
    ctx.fillStyle = '#818cf8';
    ctx.letterSpacing = '1px';
    ctx.fillText('ID DA SALA', idCardX + idCardW / 2, idCardY + 11);

    ctx.font = FONT_ROOM_ID;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(String(roomId), idCardX + idCardW / 2, idCardY + 28);

    // 3. Sub-cabecalho dos Times
    const t1Players = time1.filter(p => p && (p.nick || p.nickname || p.uid));
    const t2Players = time2.filter(p => p && (p.nick || p.nickname || p.uid));

    // TIME 1
    ctx.textAlign = 'left';
    ctx.font = FONT_SUBTITLE;
    ctx.fillStyle = '#38bdf8';
    ctx.fillText('TIME 1', 50, 118);

    ctx.textAlign = 'right';
    ctx.font = FONT_DETAIL;
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(`${t1Players.length} jogadores`, 590, 122);

    // TIME 2
    ctx.textAlign = 'left';
    ctx.font = FONT_DETAIL;
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(`${t2Players.length} jogadores`, 690, 122);

    ctx.textAlign = 'right';
    ctx.font = FONT_SUBTITLE;
    ctx.fillStyle = '#fb923c';
    ctx.fillText('TIME 2', W - 50, 118);

    // 4. Emblema Central "VS"
    const vsX = W / 2;
    const vsY = 380;
    const vsRadius = 26;

    // Circulo externo brilhante
    const vsOuterGrad = ctx.createLinearGradient(vsX - vsRadius, vsY, vsX + vsRadius, vsY);
    vsOuterGrad.addColorStop(0, '#0284c7');
    vsOuterGrad.addColorStop(1, '#ea580c');
    ctx.strokeStyle = vsOuterGrad;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(vsX, vsY, vsRadius, 0, Math.PI * 2);
    ctx.stroke();

    // Circulo interno escuro
    ctx.fillStyle = '#0f1422';
    ctx.beginPath();
    ctx.arc(vsX, vsY, vsRadius - 2, 0, Math.PI * 2);
    ctx.fill();

    // Texto VS
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 16px "Oswald", "Arial Black", sans-serif';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText('VS', vsX, vsY + 1);

    // 5. Cards de Jogadores (4 slots por time)
    const slotW = 540;
    const slotH = 104;
    const slotGap = 16;
    const startY = 154;

    // Helper para desenhar card de jogador
    async function drawPlayerCard({ x, y, player, isTeam2 = false }) {
        ctx.save();

        if (!player) {
            // Slot Vazio
            ctx.fillStyle = 'rgba(15, 20, 32, 0.45)';
            drawRoundedRect(ctx, x, y, slotW, slotH, 14);
            ctx.fill();

            ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
            ctx.lineWidth = 1;
            ctx.setLineDash([6, 6]);
            drawRoundedRect(ctx, x, y, slotW, slotH, 14);
            ctx.stroke();
            ctx.setLineDash([]);

            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font = '14px "Oswald", sans-serif';
            ctx.fillStyle = '#475569';
            ctx.fillText('Slot Vazio', x + slotW / 2, y + slotH / 2);
            ctx.restore();
            return;
        }

        // Fundo do Card com Gradiente Escuro
        const cardGrad = ctx.createLinearGradient(x, y, x + slotW, y + slotH);
        if (!isTeam2) {
            cardGrad.addColorStop(0, 'rgba(18, 25, 42, 0.95)');
            cardGrad.addColorStop(1, 'rgba(12, 17, 28, 0.98)');
        } else {
            cardGrad.addColorStop(0, 'rgba(24, 20, 34, 0.95)');
            cardGrad.addColorStop(1, 'rgba(14, 15, 26, 0.98)');
        }
        ctx.fillStyle = cardGrad;
        drawRoundedRect(ctx, x, y, slotW, slotH, 14);
        ctx.fill();

        // Borda suave com destaque sutil de equipe
        ctx.strokeStyle = !isTeam2 ? 'rgba(56, 189, 248, 0.22)' : 'rgba(251, 146, 60, 0.22)';
        ctx.lineWidth = 1.2;
        drawRoundedRect(ctx, x, y, slotW, slotH, 14);
        ctx.stroke();

        // Extrai dados do jogador
        const nick = String(player.nick || player.nickname || `Player ${String(player.uid || '').slice(-4)}`);
        const charName = String(player.character_name || 'Primis');
        const level = player.level || 50;
        const platform = String(player.plataforma || player.platform || 'mobile').toUpperCase();
        const skills = Array.isArray(player.skills) ? player.skills : [];
        const pet = player.pet || null;

        // Dimensões do Avatar
        const avSize = 74;
        const avY = y + (slotH - avSize) / 2;
        const iconPath = player.avatar_icon_path || characterIcon(charName);

        if (!isTeam2) {
            // Layout Time 1: Avatar na Esquerda
            const avX = x + 16;
            await drawAvatarWithLevel(ctx, avX, avY, avSize, iconPath, level, charName);

            // Informações (Nick + Personagem + Habilidades)
            const contentX = avX + avSize + 16;

            // Nickname
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.font = FONT_NICKNAME;
            ctx.fillStyle = '#FFFFFF';
            const cleanNick = truncateText(ctx, nick, 260);
            ctx.fillText(cleanNick, contentX, y + 14);

            // Nome do Personagem
            ctx.font = FONT_DETAIL;
            ctx.fillStyle = '#94a3b8';
            ctx.fillText(charName, contentX, y + 38);

            // Habilidades e Pet
            const skillY = y + 60;
            await drawSkillsRow(ctx, contentX, skillY, skills, pet);

            // Badge MOBILE / EMULADOR no canto direito
            drawPlatformBadge(ctx, x + slotW - 82, y + 20, platform);

        } else {
            // Layout Time 2: Avatar na Direita (Espelhado Simetrico)
            const avX = x + slotW - 16 - avSize;
            await drawAvatarWithLevel(ctx, avX, avY, avSize, iconPath, level, charName);

            // Informações (Nick + Personagem + Habilidades)
            const contentX = x + 20;

            // Nickname
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.font = FONT_NICKNAME;
            ctx.fillStyle = '#FFFFFF';
            const cleanNick = truncateText(ctx, nick, 260);
            ctx.fillText(cleanNick, contentX, y + 14);

            // Nome do Personagem
            ctx.font = FONT_DETAIL;
            ctx.fillStyle = '#94a3b8';
            ctx.fillText(charName, contentX, y + 38);

            // Habilidades e Pet
            const skillY = y + 60;
            await drawSkillsRow(ctx, contentX, skillY, skills, pet);

            // Badge MOBILE / EMULADOR na posicao simetrica
            drawPlatformBadge(ctx, avX - 74, y + 20, platform);
        }

        ctx.restore();
    }

    // Renderiza os 4 slots do Time 1 e os 4 slots do Time 2
    for (let i = 0; i < 4; i++) {
        const slotY = startY + i * (slotH + slotGap);
        // Time 1
        await drawPlayerCard({
            x: 50,
            y: slotY,
            player: time1[i] || null,
            isTeam2: false
        });

        // Time 2
        await drawPlayerCard({
            x: W - 50 - slotW,
            y: slotY,
            player: time2[i] || null,
            isTeam2: true
        });
    }

    // 6. Rodapé Inferior
    const totalPlayersCount = t1Players.length + t2Players.length;
    ctx.textBaseline = 'bottom';

    // Sistema / Modo no canto inferior esquerdo
    ctx.textAlign = 'left';
    ctx.font = FONT_FOOTER;
    ctx.fillStyle = '#64748b';
    ctx.fillText(`${systemName} — ${modeName}`, 50, H - 24);

    // Contador de Jogadores no canto inferior direito
    ctx.textAlign = 'right';
    ctx.font = FONT_FOOTER;
    ctx.fillStyle = '#64748b';
    ctx.fillText(`${totalPlayersCount}/8 jogadores`, W - 50, H - 24);

    return canvas.toDataURL('image/png');
}

// ============================================================
// Helpers de Renderizacao Internos
// ============================================================

function truncateText(ctx, text, maxWidth) {
    if (!text) return '';
    if (ctx.measureText(text).width <= maxWidth) return text;
    const chars = Array.from(String(text));
    while (chars.length > 2) {
        chars.pop();
        const candidate = chars.join('') + '...';
        if (ctx.measureText(candidate).width <= maxWidth) {
            return candidate;
        }
    }
    return chars.join('');
}

function drawPlatformBadge(ctx, x, y, platform) {
    const isEmu = platform.includes('EMU') || platform.includes('PC');
    const badgeW = 68;
    const badgeH = 22;

    ctx.save();
    ctx.fillStyle = isEmu ? 'rgba(234, 88, 12, 0.15)' : 'rgba(255, 255, 255, 0.05)';
    drawRoundedRect(ctx, x, y, badgeW, badgeH, 11);
    ctx.fill();

    ctx.strokeStyle = isEmu ? 'rgba(234, 88, 12, 0.35)' : 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    drawRoundedRect(ctx, x, y, badgeW, badgeH, 11);
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = FONT_BADGE;
    ctx.fillStyle = isEmu ? '#fb923c' : '#94a3b8';
    ctx.fillText(isEmu ? 'EMULADOR' : 'MOBILE', x + badgeW / 2, y + badgeH / 2);
    ctx.restore();
}

async function drawAvatarWithLevel(ctx, x, y, size, iconPath, level, charName) {
    ctx.save();

    // Fundo do avatar
    ctx.fillStyle = '#1e293b';
    drawRoundedRect(ctx, x, y, size, size, 14);
    ctx.fill();

    // Clip arredondado para foto do personagem
    ctx.save();
    drawRoundedRect(ctx, x, y, size, size, 14);
    ctx.clip();

    const img = await getCachedImage(iconPath);
    if (img) {
        ctx.drawImage(img, x, y, size, size);
    } else {
        // Fallback estilizado com inicial
        ctx.fillStyle = '#334155';
        ctx.fillRect(x, y, size, size);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = 'bold 26px "Oswald", sans-serif';
        ctx.fillStyle = '#94a3b8';
        ctx.fillText(charName ? charName[0].toUpperCase() : '?', x + size / 2, y + size / 2);
    }
    ctx.restore();

    // Borda do avatar
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1.5;
    drawRoundedRect(ctx, x, y, size, size, 14);
    ctx.stroke();

    // Badge de Nivel circular sobreposta no canto inferior
    if (level) {
        const badgeRadius = 14;
        const badgeX = x + size - 8;
        const badgeY = y + size - 8;

        ctx.fillStyle = '#0f172a';
        ctx.beginPath();
        ctx.arc(badgeX, badgeY, badgeRadius, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = '#eab308';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(badgeX, badgeY, badgeRadius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = FONT_LEVEL;
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(String(level), badgeX, badgeY + 1);
    }

    ctx.restore();
}

async function drawSkillsRow(ctx, startX, startY, skills, pet) {
    const activeSkill = skills.find(s => s.is_active);
    const passiveSkills = skills.filter(s => !s.is_active).slice(0, 3);

    let curX = startX;

    // 1. Habilidade Ativa
    const actSize = 34;
    ctx.save();
    // Borda e moldura de habilidade ativa brilhante
    ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
    drawRoundedRect(ctx, curX, startY - 2, actSize, actSize, 8);
    ctx.fill();

    const actGrad = ctx.createLinearGradient(curX, startY, curX + actSize, startY + actSize);
    actGrad.addColorStop(0, '#38bdf8');
    actGrad.addColorStop(1, '#6366f1');
    ctx.strokeStyle = actGrad;
    ctx.lineWidth = 2;
    drawRoundedRect(ctx, curX, startY - 2, actSize, actSize, 8);
    ctx.stroke();

    if (activeSkill) {
        const actPath = activeSkill.icon_path || resolveSkillIcon(activeSkill.skill_id, activeSkill.character_name);
        if (actPath) {
            const actImg = await getCachedImage(actPath);
            if (actImg) {
                ctx.save();
                drawRoundedRect(ctx, curX + 2, startY, actSize - 4, actSize - 4, 6);
                ctx.clip();
                ctx.drawImage(actImg, curX + 2, startY, actSize - 4, actSize - 4);
                ctx.restore();
            }
        }
    }
    ctx.restore();
    curX += actSize + 8;

    // 2. Habilidades Passivas (ate 3)
    const pasSize = 30;
    for (let i = 0; i < 3; i++) {
        const skill = passiveSkills[i];
        ctx.save();
        ctx.fillStyle = 'rgba(15, 23, 42, 0.8)';
        drawRoundedRect(ctx, curX, startY, pasSize, pasSize, 7);
        ctx.fill();

        ctx.strokeStyle = skill ? 'rgba(255, 255, 255, 0.15)' : 'rgba(255, 255, 255, 0.05)';
        ctx.lineWidth = 1;
        drawRoundedRect(ctx, curX, startY, pasSize, pasSize, 7);
        ctx.stroke();

        if (skill) {
            const pPath = skill.icon_path || resolveSkillIcon(skill.skill_id, skill.character_name);
            if (pPath) {
                const pImg = await getCachedImage(pPath);
                if (pImg) {
                    ctx.save();
                    drawRoundedRect(ctx, curX + 1, startY + 1, pasSize - 2, pasSize - 2, 6);
                    ctx.clip();
                    ctx.drawImage(pImg, curX + 1, startY + 1, pasSize - 2, pasSize - 2);
                    ctx.restore();
                }
            }
        }
        ctx.restore();
        curX += pasSize + 6;
    }

    // 3. Pet
    if (pet) {
        const petSize = 30;
        ctx.save();
        ctx.fillStyle = 'rgba(15, 23, 42, 0.8)';
        drawRoundedRect(ctx, curX, startY, petSize, petSize, 7);
        ctx.fill();

        ctx.strokeStyle = 'rgba(251, 191, 36, 0.35)';
        ctx.lineWidth = 1;
        drawRoundedRect(ctx, curX, startY, petSize, petSize, 7);
        ctx.stroke();

        const petPath = pet.local_path || (pet.id ? petIcon(pet.id, pet.skin_id) : null);
        if (petPath) {
            const petImg = await getCachedImage(petPath);
            if (petImg) {
                ctx.save();
                drawRoundedRect(ctx, curX + 1, startY + 1, petSize - 2, petSize - 2, 6);
                ctx.clip();
                ctx.drawImage(petImg, curX + 1, startY + 1, petSize - 2, petSize - 2);
                ctx.restore();
            }
        }
        ctx.restore();
    }
}

module.exports = {
    renderSalaIniciadaImage
};
