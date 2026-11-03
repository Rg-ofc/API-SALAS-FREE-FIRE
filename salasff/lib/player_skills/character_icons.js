'use strict';

const path = require('path');
const fs = require('fs');

const CHARACTERS_DIR = path.join(__dirname, '..', '..', 'assets', 'characters');
let portraits = [];
try {
    portraits = require(path.join(CHARACTERS_DIR, 'sources.json'));
} catch (e) {
    console.warn('[CHARACTER_ICONS] Aviso: sources.json nao encontrado em assets/characters');
}

const byName = new Map();
const byId = new Map();
const idToName = new Map();

for (const item of portraits) {
    const filename = path.basename(item.local || `${item.id}.jpg`);
    const fullPath = path.join(CHARACTERS_DIR, filename);
    if (fs.existsSync(fullPath)) {
        if (item.name) {
            byName.set(item.name.toLowerCase().trim(), fullPath);
            if (item.id) {
                idToName.set(Number(item.id), item.name);
            }
        }
        if (item.id) {
            byId.set(Number(item.id), fullPath);
        }
    }
}

// O personagem ID 255 (KSHMR) é oficialmente 'K' na Garena global, mas no Brasil é chamado de 'Kamir'
if (idToName.has(255) && idToName.get(255) === 'K') {
    idToName.set(255, 'Kamir');
}
if (byId.has(255)) {
    byName.set('kamir', byId.get(255));
    byName.set('k', byId.get(255));
    byName.set('kshmr', byId.get(255));
}

// Fallbacks e apelidos conhecidos
const ALIASES = {
    'k': 'kamir',
    'kamir': 'kamir',
    'kshmr': 'kamir',
    'xtrema': 'xayne',
    'primis': 'adam',
    'adam': 'adam',
    'nulla': 'eve',
    'eve': 'eve',
    'orion': 'orion',
    'awakened alok': 'alok',
    'alok (despertado)': 'alok',
    'hayato (despertado)': 'hayato',
    'kelly (despertada)': 'kelly',
    'andrew (despertado)': 'andrew',
    'moco (enigma)': 'moco',
    'alvaro (despertado)': 'alvaro'
};

function getCharacterName(idOrName) {
    if (!idOrName) return null;
    const num = Number(idOrName);
    if (Number.isSafeInteger(num) && num > 0) {
        if (idToName.has(num)) {
            const n = idToName.get(num);
            return n === 'K' ? 'Kamir' : n;
        }
        const mod1m = num % 1000000;
        if (idToName.has(mod1m)) {
            const n = idToName.get(mod1m);
            return n === 'K' ? 'Kamir' : n;
        }
    }
    const raw = String(idOrName).replace(/\s*\([^)]*\)/g, '').trim().toLowerCase();
    if (raw === 'k' || raw === 'kamir' || raw === 'kshmr') return 'Kamir';
    const cleanName = ALIASES[raw] || raw;
    for (const [id, name] of idToName.entries()) {
        if (name.toLowerCase() === cleanName) return name === 'K' ? 'Kamir' : name;
    }
    return String(idOrName);
}

function characterIcon(nameOrId) {
    if (!nameOrId) return byId.get(146) || null;
    if (typeof nameOrId === 'number' || /^\d+$/.test(String(nameOrId).trim())) {
        const idNum = Number(nameOrId);
        if (byId.has(idNum)) return byId.get(idNum);
        const mod1m = idNum % 1000000;
        if (byId.has(mod1m)) return byId.get(mod1m);
    }
    const raw = String(nameOrId).replace(/\s*\([^)]*\)/g, '').trim().toLowerCase();
    const cleanName = ALIASES[raw] || raw;
    if (byName.has(cleanName)) return byName.get(cleanName);
    
    // Tenta busca parcial
    for (const [key, fullPath] of byName.entries()) {
        if (key.includes(cleanName) || cleanName.includes(key)) {
            return fullPath;
        }
    }

    // Se for Adam ou Primis ou nao encontrado, usa um icone default elegante
    if (cleanName === 'adam' || cleanName === 'primis' || cleanName === 'eve' || cleanName === 'nulla') {
        return byId.get(13) || byId.get(146) || null; // Ford ou Alok como fallback oficial
    }

    return byId.get(146) || null;
}

module.exports = {
    characterIcon,
    getCharacterName,
    byId,
    byName,
    idToName
};
