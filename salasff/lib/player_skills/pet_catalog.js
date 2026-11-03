'use strict';

const path = require('path');
const fs = require('fs');

const PETS_DIR = path.join(__dirname, '..', '..', 'assets', 'pets');
let pets = [];
try {
    pets = require(path.join(PETS_DIR, 'sources.json'));
} catch (e) {
    console.warn('[PET_CATALOG] Aviso: sources.json nao encontrado em assets/pets');
}

const byId = new Map();
for (const pet of pets) {
    const filename = path.basename(pet.icon_url || `${pet.id}.png`);
    const fullPath = path.join(PETS_DIR, filename);
    const localExists = fs.existsSync(fullPath);
    byId.set(Number(pet.id), {
        ...pet,
        local_path: localExists ? fullPath : null
    });
}

function normalizePet(info) {
    if (!info) return null;
    const id = Number(info.id || info.petid);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const entry = byId.get(id);
    const skinId = Number(info.skinid) || null;
    
    // Tenta encontrar a skin localmente, senao usa o icone base
    let localPath = entry?.local_path || null;
    if (skinId) {
        const skinPath = path.join(PETS_DIR, `${skinId}.png`);
        if (fs.existsSync(skinPath)) localPath = skinPath;
    }

    return {
        id,
        name: entry?.name || `Pet ${id}`,
        nickname: info.name || null,
        level: Number(info.level) || null,
        selected: typeof info.isselected === 'boolean' ? info.isselected : null,
        skin_id: skinId,
        skill_id: Number(info.selectedskillid || info.skillid) || null,
        local_path: localPath
    };
}

function petIcon(petId, skinId = null) {
    const id = Number(petId);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    if (skinId) {
        const skinPath = path.join(PETS_DIR, `${skinId}.png`);
        if (fs.existsSync(skinPath)) return skinPath;
    }
    return byId.get(id)?.local_path || null;
}

module.exports = {
    normalizePet,
    petIcon,
    byId
};
