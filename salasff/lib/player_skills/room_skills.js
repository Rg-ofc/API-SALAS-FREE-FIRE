'use strict';

const { requestPlayerSkills } = require('./player_skills');
const { characterIcon, getCharacterName } = require('./character_icons');

// Cache em memoria por UID
const profileCache = new Map();
const CACHE_TTL_MS = 60000; // 1 minuto

async function fetchPlayerProfile(uid, token, clientUrl, region) {
    const uidStr = String(uid);
    const cached = profileCache.get(uidStr);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return cached.data;
    }

    try {
        const res = await requestPlayerSkills({ uid: uidStr, token, clientUrl, region });
        if (res.ok) {
            console.log(`[SKILLS] UID ${uidStr}: Nick="${res.nickname}", Personagem="${res.character_name}", Habilidades=${res.skills?.map(s => s.character_name || s.skill_id).join(', ') || 'Nenhuma'}, Pet="${res.pet?.name || 'Nenhum'}"`);
            profileCache.set(uidStr, { timestamp: Date.now(), data: res });
            return res;
        } else {
            console.log(`[SKILLS] UID ${uidStr}: Falha ao obter perfil (Erro: ${res.error})`);
        }
    } catch (e) {
        console.log(`[SKILLS] UID ${uidStr}: Excecao ao consultar habilidades: ${e.message}`);
    }

    const fallback = {
        ok: false,
        uid: uidStr,
        skills: [],
        pet: null,
        level: null,
        character_name: null,
        avatar_icon_path: null
    };
    return fallback;
}

/**
 * Enriquece a lista de jogadores da sala com suas habilidades, pet, nivel e avatar
 * @param {Array|Object} players - Lista ou dicionario de jogadores da sala
 * @param {Object} options - { token, clientUrl, region, timeoutMs }
 * @returns {Promise<Array>} Lista de jogadores com informacoes de habilidades
 */
async function enrichRoomPlayers(players, options = {}) {
    const { token, clientUrl, region = 'BR', timeoutMs = 3500 } = options;
    
    // Normalizar para array de objetos
    let playerList = [];
    if (Array.isArray(players)) {
        playerList = [...players];
    } else if (players && typeof players === 'object') {
        playerList = Object.entries(players).map(([uid, p]) => ({
            uid,
            ...p
        }));
    }

    if (playerList.length === 0) return [];

    // Se nao tiver token para consulta, devolve com icones basicos
    if (!token) {
        return playerList.map(p => ({
            ...p,
            character_name: p.character_name || 'Primis',
            avatar_icon_path: characterIcon(p.character_name || 'Primis'),
            skills: [],
            pet: null,
            level: p.level || 50
        }));
    }

    // Busca concorrente com timeout global
    const lookupPromises = playerList.map(async (player) => {
        const uid = String(player.uid || player.account_id || '');
        if (!uid || uid === '0') return player;

        try {
            const profile = await Promise.race([
                fetchPlayerProfile(uid, token, clientUrl, region),
                new Promise(resolve => setTimeout(() => resolve(null), timeoutMs))
            ]);

            if (profile && profile.ok) {
                return {
                    ...player,
                    nickname: player.nick || player.nickname || profile.nickname || `Player ${uid.slice(-4)}`,
                    character_name: profile.character_name || player.character_name || 'Primis',
                    avatar_icon_path: profile.avatar_icon_path || characterIcon(profile.character_name || 'Primis'),
                    level: profile.level || player.level || Math.floor(50 + (parseInt(uid.slice(-2), 10) % 35)),
                    skills: profile.skills || [],
                    pet: profile.pet || null
                };
            }
        } catch {
            // ignore
        }

        return {
            ...player,
            nickname: player.nick || player.nickname || `Player ${uid.slice(-4)}`,
            character_name: player.character_name || 'Primis',
            avatar_icon_path: characterIcon(player.character_name || 'Primis'),
            level: player.level || Math.floor(50 + (parseInt(uid.slice(-2), 10) % 35)),
            skills: [],
            pet: null
        };
    });

    return Promise.all(lookupPromises);
}

/**
 * Remove caminhos de sistema de arquivos locais (ex: C:\...\146.jpg)
 * para envio limpo nas respostas da API publica
 */
function cleanPlayerForApi(p) {
    if (!p || typeof p !== 'object') return p;
    const { avatar_icon_path, ...rest } = p;
    if (Array.isArray(rest.skills)) {
        rest.skills = rest.skills.map(s => {
            if (!s || typeof s !== 'object') return s;
            const { icon_path, character_icon_path, source, ...sRest } = s;
            return sRest;
        });
    }
    if (rest.pet && typeof rest.pet === 'object') {
        const { local_path, ...petRest } = rest.pet;
        rest.pet = petRest;
    }
    return rest;
}

module.exports = {
    enrichRoomPlayers,
    fetchPlayerProfile,
    cleanPlayerForApi
};
