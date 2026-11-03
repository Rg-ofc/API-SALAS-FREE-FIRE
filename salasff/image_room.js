const { createCanvas, loadImage, registerFont } = require('canvas');
const path = require('path');
const fs = require('fs');

const fontDir = __dirname;
try {
    const oswaldPath = path.join(fontDir, 'Oswald.ttf');
    if (fs.existsSync(oswaldPath)) {
        registerFont(oswaldPath, { family: 'Oswald', weight: 'bold' });
        console.log('[IMAGE_ROOM] Fonte Oswald.ttf registrada');
    }
} catch (e) { console.log('[IMAGE_ROOM] Oswald.ttf nao encontrada, usando fallback'); }

try {
    const bebasPath = path.join(fontDir, 'BebasNeue.ttf');
    if (fs.existsSync(bebasPath)) {
        registerFont(bebasPath, { family: 'Bebas Neue', weight: 'normal' });
        console.log('[IMAGE_ROOM] Fonte BebasNeue.ttf registrada');
    }
} catch (e) { console.log('[IMAGE_ROOM] BebasNeue.ttf nao encontrada, usando fallback'); }

const CARD_W = 800;
const CARD_H = 450;
const TOP_BAR_H = 52;
const BOT_BAR_H = 48;
const RADIUS = 12;
const IMG_DIR = path.join(__dirname, 'room_images');

let _bgCache = null;

async function _carregarFundo() {
    if (_bgCache) return _bgCache;

    const extensoes = ['png', 'jpg', 'jpeg', 'webp'];
    for (const ext of extensoes) {
        const bgPath = path.join(__dirname, `bermuda_landscape.${ext}`);
        if (fs.existsSync(bgPath)) {
            try {
                console.log(`[IMAGE_ROOM] Tentando carregar fundo: ${bgPath} (${(fs.statSync(bgPath).size / 1024).toFixed(0)}KB)`);
                const buf = fs.readFileSync(bgPath);
                _bgCache = await loadImage(buf);
                console.log(`[IMAGE_ROOM] Fundo carregado com sucesso: ${_bgCache.width}x${_bgCache.height} (${ext})`);
                return _bgCache;
            } catch (e) {
                console.log(`[IMAGE_ROOM] Falha ao carregar ${ext}: ${e.message}`);
            }
        }
    }

    try {
        const files = fs.readdirSync(__dirname).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f));
        console.log(`[IMAGE_ROOM] ERRO: Nenhum bermuda_landscape encontrado! Imagens no diretorio: ${files.join(', ') || 'NENHUMA'}`);
        console.log(`[IMAGE_ROOM] Diretorio: ${__dirname}`);
    } catch (e) { /* ignore */ }

    throw new Error('bermuda_landscape nao encontrado em nenhum formato (png/jpg/webp) em ' + __dirname);
}

async function gerarImagemSala(roomId, senha, sshash, senhaColor = '#FFD700') {
    if (!fs.existsSync(IMG_DIR)) {
        fs.mkdirSync(IMG_DIR, { recursive: true });
    }

    console.log(`[IMAGE_ROOM] Gerando imagem: room_id=${roomId}, senha=${senha ? '***' : 'sem'}, cor=${senhaColor}`);

    const canvas = createCanvas(CARD_W, CARD_H);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, CARD_W, CARD_H);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(RADIUS, 0);
    ctx.lineTo(CARD_W - RADIUS, 0);
    ctx.arcTo(CARD_W, 0, CARD_W, RADIUS, RADIUS);
    ctx.lineTo(CARD_W, CARD_H - RADIUS);
    ctx.arcTo(CARD_W, CARD_H, CARD_W - RADIUS, CARD_H, RADIUS);
    ctx.lineTo(RADIUS, CARD_H);
    ctx.arcTo(0, CARD_H, 0, CARD_H - RADIUS, RADIUS);
    ctx.lineTo(0, RADIUS);
    ctx.arcTo(0, 0, RADIUS, 0, RADIUS);
    ctx.closePath();
    ctx.clip();

    try {
        const bg = await _carregarFundo();

        const bgRatio = bg.width / bg.height;
        const cardRatio = CARD_W / CARD_H;
        let drawW, drawH, drawX, drawY;
        if (bgRatio > cardRatio) {
            drawH = CARD_H;
            drawW = CARD_H * bgRatio;
            drawX = (CARD_W - drawW) / 2;
            drawY = 0;
        } else {
            drawW = CARD_W;
            drawH = CARD_W / bgRatio;
            drawX = 0;
            drawY = (CARD_H - drawH) / 2;
        }
        ctx.drawImage(bg, drawX, drawY, drawW, drawH);
    } catch (e) {
        console.log(`[IMAGE_ROOM] ERRO ao desenhar fundo: ${e.message} - usando fundo escuro`);
    }

    ctx.fillStyle = 'rgba(15, 15, 20, 0.88)';
    ctx.fillRect(0, 0, CARD_W, TOP_BAR_H);
    ctx.strokeStyle = 'rgba(100, 180, 255, 0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, TOP_BAR_H);
    ctx.lineTo(CARD_W, TOP_BAR_H);
    ctx.stroke();
    ctx.fillStyle = 'rgba(10, 10, 15, 0.85)';
    ctx.fillRect(0, CARD_H - BOT_BAR_H, CARD_W, BOT_BAR_H);
    ctx.strokeStyle = 'rgba(100, 180, 255, 0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, CARD_H - BOT_BAR_H);
    ctx.lineTo(CARD_W, CARD_H - BOT_BAR_H);
    ctx.stroke();

    const barCenterY = TOP_BAR_H / 2;

    ctx.font = 'bold 22px "Oswald", "Bebas Neue", sans-serif';
    ctx.fillStyle = '#FFFFFF';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText('ID', 18, barCenterY);

    const idWidth = ctx.measureText('ID').width;
    ctx.font = 'bold 24px "Oswald", "Bebas Neue", sans-serif';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(String(roomId), 18 + idWidth + 12, barCenterY);

    if (senha) {

        const corSenha = /^#[0-9A-Fa-f]{6}$/.test(senhaColor) ? senhaColor : '#FFD700';
        ctx.font = 'bold 22px "Oswald", "Bebas Neue", sans-serif';
        ctx.fillStyle = corSenha;
        ctx.textAlign = 'right';
        ctx.fillText('SENHA: ' + senha, CARD_W - 20, barCenterY);
    }

    ctx.font = 'bold 26px "Oswald", "Bebas Neue", sans-serif';
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('BERMUDA', CARD_W / 2, CARD_H - BOT_BAR_H / 2);

    ctx.restore();

    const filePath = path.join(IMG_DIR, `room_${sshash}.png`);
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(filePath, buffer);

    console.log(`[IMAGE_ROOM] Imagem gerada: ${filePath} (${buffer.length} bytes)`);
    return filePath;
}

function obterImagemSala(sshash) {
    const filePath = path.join(IMG_DIR, `room_${sshash}.png`);
    try {
        if (fs.existsSync(filePath)) {
            return fs.readFileSync(filePath);
        }
    } catch (e) {
        console.log(`[IMAGE_ROOM] Erro ao ler imagem: ${e.message}`);
    }
    return null;
}

function removerImagemSala(sshash) {
    const filePath = path.join(IMG_DIR, `room_${sshash}.png`);
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`[IMAGE_ROOM] Imagem removida: ${filePath}`);
        }
    } catch (e) {
        console.log(`[IMAGE_ROOM] Erro ao remover imagem: ${e.message}`);
    }
}

_carregarFundo().then(() => {
    console.log('[IMAGE_ROOM] Modulo image_room carregado com sucesso (fundo pre-carregado)');
}).catch(e => {
    console.log(`[IMAGE_ROOM] AVISO: Fundo nao pre-carregado: ${e.message}`);
});

module.exports = { gerarImagemSala, obterImagemSala, removerImagemSala };
