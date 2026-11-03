'use strict';

const path = require('path');
const fs = require('fs');
const { characterIcon } = require('./character_icons');

const SKILLS_DIR = path.join(__dirname, '..', '..', 'assets', 'skills');
let skillFiles = new Set();
try {
    if (fs.existsSync(SKILLS_DIR)) {
        fs.readdirSync(SKILLS_DIR).forEach(f => skillFiles.add(f));
    }
} catch (e) {
    console.warn('[SKILL_CATALOG] Aviso ao listar assets/skills:', e.message);
}

// Grupos de habilidades de personagens Free Fire
const CHARACTER_BY_GROUP = Object.freeze({
    1: 'Olivia',
    2: 'Kelly',
    3: 'Ford',
    4: 'Andrew',
    5: 'Nikita',
    6: 'Misha',
    7: 'Maxim',
    8: 'Kla',
    9: 'Paloma',
    10: 'Miguel',
    11: 'Caroline',
    12: 'Wukong',
    13: 'Antonio',
    14: 'Moco',
    15: 'Hayato',
    17: 'Laura',
    18: 'Rafael',
    19: 'A124',
    20: 'Joseph',
    21: 'Shani',
    22: 'Alok',
    23: 'Alvaro',
    24: 'Notora',
    25: 'Kelly (Despertada)',
    26: 'Steffie',
    27: 'Jota',
    28: 'Kapella',
    29: 'Luqueta',
    30: 'Wolfrahh',
    31: 'Clu',
    32: 'Hayato (Despertado)',
    33: 'Jai',
    34: 'Kamir',
    35: 'Dasha',
    37: 'Kamir',
    38: 'Chrono',
    40: 'Skyler',
    41: 'Shirou',
    42: 'Andrew (Despertado)',
    43: 'Maro',
    44: 'Xayne',
    45: 'D-Bee',
    46: 'Thiva',
    47: 'Dimitri',
    48: 'Moco (Enigma)',
    49: 'Leon',
    50: 'Otho',
    51: 'Jai',
    52: 'Nairi',
    53: 'Luna',
    54: 'Kenta',
    55: 'Homer',
    56: 'Iris',
    57: 'Link',
    58: 'Tatsuya',
    59: 'Santino',
    60: 'Santino',
    61: 'Link',
    62: 'Orion',
    63: 'Alvaro (Despertado)',
    65: 'Sonia',
    66: 'Suzy',
    67: 'Ignis',
    68: 'Ryden',
    69: 'Kairos',
    70: 'Kassie',
    71: 'Lila',
    72: 'Koda',
    73: 'Oscar',
    74: 'Rin',
    75: 'Nero',
    76: 'Morse',
    77: 'Ray'
});

const EXACT_SKILL_IDS = Object.freeze({
    22016: 'Alok (Despertado)',
    2206: 'Alok',
    6206: 'Orion',
    1506: 'Hayato',
    206: 'Kelly',
    1406: 'Moco',
    806: 'Kla',
    4606: 'Thiva',
    3806: 'Chrono',
    4006: 'Skyler',
    5806: 'Tatsuya',
    6506: 'Sonia'
});

// Grupos que possuem habilidades ATIVAS
const ACTIVE_SKILL_GROUPS = new Set([
    12,       // Wukong
    19,       // A124
    22,       // Alok
    26,       // Steffie
    31,       // Clu
    34, 37,   // K
    38,       // Chrono
    40,       // Skyler
    44,       // Xayne
    47,       // Dimitri
    54,       // Kenta
    55,       // Homer
    56,       // Iris
    58,       // Tatsuya
    59, 60,   // Santino
    62,       // Orion
    67,       // Ignis
    68,       // Ryden
    70,       // Kassie
    72,       // Koda
    73,       // Oscar
    75,       // Nero
    76,       // Morse
    77        // Ray
]);

function skillGroup(skillId) {
    const id = Number(skillId);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    return Math.floor(id / 100);
}

function skillLevel(skillId) {
    const id = Number(skillId);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    return id % 100;
}

function isActiveSkillId(skillId) {
    const id = Number(skillId);
    if (id === 22016 || id === 2206) return true;
    const group = skillGroup(id);
    return group !== null && ACTIVE_SKILL_GROUPS.has(group);
}

const SKILLS_SYMBOLS_DIR = path.join(__dirname, '..', '..', 'assets', 'skills_symbols');
const CHARACTER_SKILL_SYMBOL = Object.freeze({
    'orion': 'Icon_SkillSkin_Villain.png',
    'alok': 'ui_icon_skill_Djmale.png',
    'alok (despertado)': 'ui_icon_skill_Djmale_Awakening.png',
    'awakened alok': 'ui_icon_skill_Djmale_Awakening.png',
    'kelly': 'ui_icon_skill_runner5.png',
    'kelly (despertada)': 'ui_icon_skill_Kelly_Awakening_L.png',
    'hayato': 'ui_icon_skill_Samurai.png',
    'hayato (despertado)': 'ui_icon_skill_Hayato_Awakening.png',
    'moco': 'ui_icon_skill_HackerGirl.png',
    'moco (enigma)': 'ui_icon_skill_Moco_Awakening.png',
    'kla': 'ui_icon_skill_thaiboxer5.png',
    'thiva': 'ui_icon_skill_Singers.png',
    'tatsuya': 'ui_icon_skill_ParkourGuy.png',
    'wukong': 'Icon_SkillSkin_MonkeyGod.png',
    'chrono': 'ui_icon_skill_BountyHunter.png',
    'skyler': 'Icon_SkillSkin_Superstar.png',
    'sonia': 'Icon_SkillSkin_Nanoscientist.png',
    'dimitri': 'ui_icon_skill_AuroraBoy.png',
    'homer': 'UI_TabIcon_SkillSkin_Homer.png',
    'kassie': 'ui_icon_skill_Treatment_Decrease.png',
    'andrew': 'ui_icon_skill_cop5.png',
    'andrew (despertado)': 'ui_icon_skill_Andrew_Awakening.png',
    'maxim': 'ui_icon_skill_foodieboy5.png',
    'paloma': 'ui_icon_skill_armsdealer.png',
    'antonio': 'ui_icon_skill_bodyguard5.png',
    'k': 'ui_icon_skill_Professor_01.png',
    'olivia': 'ui_icon_skill_nurse5.png',
    'ford': 'ui_icon_skill_seaman5.png',
    'nikita': 'ui_icon_skill_bodyguard_rework.png',
    'misha': 'ui_icon_skill_racergirl5.png',
    'miguel': 'ui_icon_skill_cop5.png',
    'caroline': 'ui_icon_skill_richgirl.png',
    'laura': 'ui_icon_skill_Agent.png',
    'rafael': 'ui_icon_skill_Hitman.png',
    'a124': 'ui_icon_skill_Electricgirl.png',
    'joseph': 'ui_icon_skill_Playboy.png',
    'shani': 'ui_icon_skill_JunkEngineer.png',
    'alvaro': 'ui_icon_skill_Demolitionist.png',
    'notora': 'ui_icon_skill_GangGirl.png',
    'steffie': 'ui_icon_skill_Graffitist.png',
    'jota': 'ui_icon_skill_ParkourGuy.png',
    'kapella': 'ui_icon_skill_KpopSinger.png',
    'luqueta': 'ui_icon_skill_SoccerStar.png',
    'wolfrahh': 'ui_icon_skill_StreamerGuy.png',
    'clu': 'ui_icon_skill_Detective.png',
    'jai': 'ui_icon_skill_SwatGuy.png',
    'dasha': 'ui_icon_skill_PartyGirl.png',
    'shirou': 'ui_icon_skill_Delivery.png',
    'maro': 'ui_icon_skill_Falconer.png',
    'xayne': 'ui_icon_skill_Xtreme.png',
    'd-bee': 'ui_icon_skill_StreetBeat.png',
    'leon': 'ui_icon_skill_BooyahGuy.png',
    'otho': 'ui_icon_skill_Researcher.png',
    'nairi': 'ui_icon_skill_WinterGuy.png',
    'kenta': 'ui_icon_skill_Kenta.png',
    'santino': 'ui_icon_skill_Santino_01.png',
    'iris': 'ui_icon_skill_TRACKER.png',
    'ignis': 'ui_icon_skill_FireBoy.png',
    'ryden': 'ui_icon_skill_Spider.png'
});

function resolveSkillIcon(skillId, characterName = null) {
    const id = Number(skillId);
    
    // 1. Tenta icone de simbolo de habilidade (estilo Free Fire)
    const charKey = String(characterName || '').toLowerCase().trim();
    if (charKey && CHARACTER_SKILL_SYMBOL[charKey]) {
        const symbolFile = CHARACTER_SKILL_SYMBOL[charKey];
        const symbolPath = path.join(SKILLS_SYMBOLS_DIR, symbolFile);
        if (fs.existsSync(symbolPath)) return symbolPath;
    }

    // Se nao passou characterName, tenta resolver pelo ID
    const info = resolveSkill(id);
    if (info && info.character_name) {
        const key = info.character_name.toLowerCase().trim();
        if (CHARACTER_SKILL_SYMBOL[key]) {
            const symbolFile = CHARACTER_SKILL_SYMBOL[key];
            const symbolPath = path.join(SKILLS_SYMBOLS_DIR, symbolFile);
            if (fs.existsSync(symbolPath)) return symbolPath;
        }
    }

    // 2. Tenta icone por ID em assets/skills
    if (id && skillFiles.has(`${id}.png`)) {
        return path.join(SKILLS_DIR, `${id}.png`);
    }
    const group = skillGroup(id);
    if (group !== null) {
        if (skillFiles.has(`${group}06.png`)) return path.join(SKILLS_DIR, `${group}06.png`);
        if (skillFiles.has(`${group}01.png`)) return path.join(SKILLS_DIR, `${group}01.png`);
        for (const f of skillFiles) {
            if (f.startsWith(String(group)) && f.endsWith('.png')) {
                return path.join(SKILLS_DIR, f);
            }
        }
    }
    return null;
}

function resolveSkill(skillId) {
    const id = Number(skillId);
    if (!Number.isSafeInteger(id) || id <= 0) {
        return { skill_id: skillId ?? null, skill_group: null, skill_level: null, character_name: null, known: false };
    }
    const group = skillGroup(id);
    const level = skillLevel(id);
    const character = EXACT_SKILL_IDS[id] || CHARACTER_BY_GROUP[group] || null;
    return {
        skill_id: id,
        skill_group: group,
        skill_level: level,
        character_name: character,
        known: Boolean(character)
    };
}

function enrichSkill(skill) {
    if (!skill || typeof skill !== 'object') return skill;
    const sid = skill.skill_id ?? skill.id;
    const info = resolveSkill(sid);
    const active = isActiveSkillId(sid);
    return {
        ...skill,
        ...info,
        is_active: active,
        skill_type: active ? 'active' : 'passive',
        icon_path: resolveSkillIcon(sid),
        character_icon_path: characterIcon(info.character_name),
        display_name: info.character_name || `ID ${sid ?? '?'}`
    };
}

function enrichSkills(skills) {
    return Array.isArray(skills) ? skills.map(enrichSkill) : [];
}

function normalizeSkillRoles(skills) {
    const enriched = enrichSkills(Array.isArray(skills) ? skills : []);
    if (!enriched.length) return [];

    const sorted = enriched.map((item, index) => ({ ...item, _order: index }));
    let activeIndex = sorted.findIndex(item => isActiveSkillId(item.skill_id));

    if (activeIndex < 0) {
        activeIndex = sorted.findIndex(item => Number(item.slot) === 0 && !item.known);
    }

    const active = activeIndex >= 0 ? sorted[activeIndex] : null;
    const passives = sorted.filter((_, i) => i !== activeIndex)
        .sort((a, b) => {
            const sa = Number(a.slot);
            const sb = Number(b.slot);
            const va = Number.isFinite(sa) && sa > 0 ? sa : 999;
            const vb = Number.isFinite(sb) && sb > 0 ? sb : 999;
            return va - vb || a._order - b._order;
        });

    const out = [];
    if (active) {
        const { _order, ...clean } = active;
        out.push({ ...clean, slot: 0, skill_type: 'active', is_active: true });
    }
    passives.forEach((item, index) => {
        const { _order, ...clean } = item;
        out.push({ ...clean, slot: index + 1, skill_type: 'passive', is_active: false });
    });
    return out.slice(0, 4);
}

module.exports = {
    CHARACTER_BY_GROUP,
    EXACT_SKILL_IDS,
    ACTIVE_SKILL_GROUPS,
    skillGroup,
    skillLevel,
    isActiveSkillId,
    resolveSkillIcon,
    resolveSkill,
    enrichSkill,
    enrichSkills,
    normalizeSkillRoles
};
