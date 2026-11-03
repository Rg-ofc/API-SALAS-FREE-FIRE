'use strict';

const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const protobuf = require('protobufjs');
const { enrichSkills, normalizeSkillRoles } = require('./skill_catalog');
const { characterIcon, getCharacterName } = require('./character_icons');
const { normalizePet } = require('./pet_catalog');

// Chave/IV usados pelo endpoint protobuf HTTP do cliente Free Fire
const API_KEY = Buffer.from('Yg&tc%DEuh6%Zc^8', 'utf8');
const API_IV = Buffer.from('6oyZDr22E3ychjM%', 'utf8');
const TIMEOUT_MS = 6000;

const protoPath = path.join(__dirname, 'proto', 'PlayerPersonalShowSkills.proto');
const root = protobuf.loadSync(protoPath);
const PersonalShowRequest = root.lookupType('VanyPlayerShow.request');
const PersonalShowResponse = root.lookupType('VanyPlayerShow.response');

function safeUid(value) {
    const text = String(value || '').trim();
    if (!/^\d+$/.test(text) || text === '0') throw new Error('invalid_player_uid');
    return text;
}

function encryptPayload(plain) {
    const cipher = crypto.createCipheriv('aes-128-cbc', API_KEY, API_IV);
    return Buffer.concat([cipher.update(Buffer.from(plain)), cipher.final()]);
}

function decryptPayload(ciphertext) {
    const input = Buffer.from(ciphertext || []);
    if (!input.length || input.length % 16 !== 0) return null;
    try {
        const decipher = crypto.createDecipheriv('aes-128-cbc', API_KEY, API_IV);
        return Buffer.concat([decipher.update(input), decipher.final()]);
    } catch {
        return null;
    }
}

function readVarint(buf, offset = 0) {
    let value = 0n;
    let shift = 0n;
    let pos = offset;
    while (pos < buf.length && shift <= 70n) {
        const b = BigInt(buf[pos++]);
        value |= (b & 0x7fn) << shift;
        if ((b & 0x80n) === 0n) return { value, next: pos };
        shift += 7n;
    }
    return null;
}

function wireFields(buffer) {
    const buf = Buffer.from(buffer || []);
    const fields = [];
    let pos = 0;
    while (pos < buf.length) {
        const tag = readVarint(buf, pos);
        if (!tag || tag.value === 0n) break;
        pos = tag.next;
        const field = Number(tag.value >> 3n);
        const wire = Number(tag.value & 7n);
        if (!Number.isSafeInteger(field) || field <= 0) break;

        if (wire === 0) {
            const v = readVarint(buf, pos);
            if (!v) break;
            fields.push({ field, wire, value: v.value });
            pos = v.next;
        } else if (wire === 2) {
            const len = readVarint(buf, pos);
            if (!len) break;
            pos = len.next;
            const n = Number(len.value);
            if (!Number.isSafeInteger(n) || n < 0 || pos + n > buf.length) break;
            fields.push({ field, wire, value: buf.subarray(pos, pos + n) });
            pos += n;
        } else if (wire === 1) {
            if (pos + 8 > buf.length) break;
            fields.push({ field, wire, value: buf.subarray(pos, pos + 8) });
            pos += 8;
        } else if (wire === 5) {
            if (pos + 4 > buf.length) break;
            fields.push({ field, wire, value: buf.subarray(pos, pos + 4) });
            pos += 4;
        } else {
            break;
        }
    }
    return fields;
}

function decodePackedVarints(buffer) {
    const buf = Buffer.from(buffer || []);
    const out = [];
    let pos = 0;
    while (pos < buf.length) {
        const v = readVarint(buf, pos);
        if (!v) return [];
        const n = Number(v.value);
        if (!Number.isSafeInteger(n)) return [];
        out.push(n);
        pos = v.next;
    }
    return out;
}

function isPlausibleSkillId(value) {
    const id = Number(value);
    if (!Number.isSafeInteger(id)) return false;
    if (id === 22016) return true;
    const group = Math.floor(id / 100);
    const level = id % 100;
    return group >= 1 && group <= 85 && level >= 1 && level <= 6;
}

function parseTaggedSkillVector(values, source = 'wire') {
    const nums = (Array.isArray(values) ? values : []).map(Number).filter(Number.isSafeInteger);
    const out = [];
    const seen = new Set();

    const push = (slot, skillId) => {
        const s = Number(slot || 0);
        const id = Number(skillId || 0);
        if (!isPlausibleSkillId(id) || s < 0 || s > 16) return;
        const key = `${s}:${id}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ slot: s, skill_id: id, source });
    };

    for (let i = 0; i < nums.length;) {
        // field 2 = skillId (tag 16), field 1 = slot (tag 8)
        if (nums[i] === 16 && i + 1 < nums.length && isPlausibleSkillId(nums[i + 1])) {
            const skillId = nums[i + 1];
            if (nums[i + 2] === 8 && i + 3 < nums.length && nums[i + 3] >= 0 && nums[i + 3] <= 16) {
                push(nums[i + 3], skillId);
                i += 4;
                continue;
            }
            push(out.length, skillId);
            i += 2;
            continue;
        }
        // field 1 = slot (tag 8), field 2 = skillId (tag 16)
        if (nums[i] === 8 && i + 3 < nums.length && nums[i + 2] === 16 && isPlausibleSkillId(nums[i + 3])) {
            const slot = nums[i + 1];
            if (slot >= 0 && slot <= 16) {
                push(slot, nums[i + 3]);
                i += 4;
                continue;
            }
        }
        i += 1;
    }

    return out.sort((a, b) => a.slot - b.slot || a.skill_id - b.skill_id).slice(0, 8);
}

function scanForSkills(buffer) {
    const candidates = [];

    function visit(buf, label, depth) {
        if (depth > 6 || !buf?.length) return;
        for (const f of wireFields(buf)) {
            if (f.wire !== 2 || !Buffer.isBuffer(f.value)) continue;
            // Ignora basicinfo (campo 1 de response) pois contem strings e dados de conta
            if (label === 'response' && f.field === 1) continue;

            const nums = decodePackedVarints(f.value);
            if (nums.length) {
                const skills = parseTaggedSkillVector(nums, `${label}.${f.field}`);
                if (skills.length) {
                    const uniqueSlots = new Set(skills.map(x => x.slot));
                    const score = skills.length * 1000 + uniqueSlots.size * 100 - Math.max(0, nums.length - 20);
                    candidates.push({ skills, nums, score, path: `${label}.${f.field}` });
                }
            }
            visit(f.value, `${label}.${f.field}`, depth + 1);
        }
    }

    visit(Buffer.from(buffer || []), 'response', 0);
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);

    // Se o melhor candidato ja tem 4 habilidades, retorna ele
    if (candidates[0].skills.length >= 4) return candidates[0];

    // Se houver mais candidatos, agrega habilidades unicas encontradas em outros campos wire
    const merged = [...candidates[0].skills];
    const seenSkillIds = new Set(merged.map(s => s.skill_id));
    for (let i = 1; i < candidates.length; i++) {
        for (const s of candidates[i].skills) {
            if (!seenSkillIds.has(s.skill_id)) {
                seenSkillIds.add(s.skill_id);
                merged.push({ ...s, slot: merged.length });
                if (merged.length >= 4) break;
            }
        }
        if (merged.length >= 4) break;
    }

    return {
        skills: merged,
        nums: candidates[0].nums,
        score: candidates[0].score,
        path: candidates[0].path
    };
}

function decodeSkills(raw) {
    const body = Buffer.from(raw || []);
    let protoSkills = [];
    let pet = null;
    let accountId = null;
    let basicInfo = null;
    let avatarId = null;
    let decodeError = null;

    try {
        const decoded = PersonalShowResponse.toObject(PersonalShowResponse.decode(body), {
            longs: String,
            defaults: false,
            arrays: true,
            objects: true
        });
        
        if (decoded?.basicinfo) {
            basicInfo = decoded.basicinfo;
            accountId = String(basicInfo.accountid || '');
        }
        if (decoded?.profileinfo) {
            avatarId = Number(decoded.profileinfo.avatarid) || null;
            const rawSkills = decoded.profileinfo.equipedskills || [];
            protoSkills = parseTaggedSkillVector(rawSkills, 'profileinfo.equipedskills');
        }
        if (decoded?.petinfo) {
            pet = normalizePet(decoded.petinfo);
        }
    } catch (error) {
        decodeError = error.message;
    }

    // Varredura recursiva de campos wire para encontrar habilidades reais do jogador
    const wire = scanForSkills(body);
    const selected = (wire?.skills?.length || 0) >= protoSkills.length 
        ? (wire?.skills || []) 
        : protoSkills;

    const normalizedSkills = normalizeSkillRoles(enrichSkills(selected));
    
    // Identifica o personagem principal
    let characterName = null;
    const activeSkill = normalizedSkills.find(s => s.is_active);
    if (activeSkill && activeSkill.character_name) {
        characterName = activeSkill.character_name;
    } else {
        const anyNamedSkill = normalizedSkills.find(s => s.character_name);
        if (anyNamedSkill) {
            characterName = anyNamedSkill.character_name;
        } else if (avatarId) {
            characterName = getCharacterName(avatarId);
        } else if (basicInfo?.headpic) {
            characterName = getCharacterName(basicInfo.headpic);
        }
    }

    if (!characterName) {
        characterName = 'Primis';
    }
    
    // Icone do avatar do jogador
    let avatarIconPath = characterIcon(characterName);
    if (!avatarIconPath && avatarId) {
        avatarIconPath = characterIcon(avatarId);
    }
    if (!avatarIconPath && basicInfo?.headpic) {
        avatarIconPath = characterIcon(basicInfo.headpic);
    }
    if (!avatarIconPath) {
        avatarIconPath = characterIcon('146') || null;
    }

    return {
        account_id: accountId,
        level: basicInfo?.level ? Number(basicInfo.level) : null,
        nickname: basicInfo?.nickname || null,
        character_name: characterName,
        avatar_icon_path: avatarIconPath,
        skills: normalizedSkills,
        pet,
        decode_error: decodeError
    };
}

function buildRequest(uid) {
    return Buffer.from(PersonalShowRequest.encode(PersonalShowRequest.create({
        accountId: String(uid),
        callSignSrc: 7,
        needGalleryInfo: true,
        needBlacklist: false,
        needSparkInfo: false
    })).finish());
}

async function requestPlayerSkills({ uid, token, clientUrl, region = 'BR' }) {
    const playerUid = safeUid(uid);
    if (!token) throw new Error('token_required');

    const baseUrl = (clientUrl || 'https://client.us.freefiremobile.com').replace(/\/+$/, '');
    const endpoints = [
        `${baseUrl}/GetPlayerPersonalShow`,
        'https://clientbp.ggblueshark.com/GetPlayerPersonalShow',
        'https://client.us.freefiremobile.com/GetPlayerPersonalShow'
    ];
    const uniqueEndpoints = [...new Set(endpoints)];

    const plain = buildRequest(playerUid);
    const encrypted = encryptPayload(plain);
    const headers = {
        'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 9; G011A Build/PI)',
        Accept: '*/*',
        'Accept-Encoding': 'gzip',
        Connection: 'Keep-Alive',
        'Content-Type': 'application/octet-stream',
        'X-Unity-Version': '2018.4.12f1',
        'X-GA': 'v1 1',
        ReleaseVersion: 'OB55',
        Authorization: `Bearer ${token}`,
        Region: String(region).trim().toUpperCase()
    };

    for (const endpoint of uniqueEndpoints) {
        try {
            const resp = await axios.post(endpoint, encrypted, {
                headers,
                responseType: 'arraybuffer',
                timeout: TIMEOUT_MS,
                validateStatus: () => true,
                maxBodyLength: 1024 * 1024
            });

            if (resp.status === 200 && resp.data) {
                const transport = Buffer.from(resp.data);
                const decrypted = decryptPayload(transport);
                const bodyToDecode = decrypted && decrypted.length ? decrypted : transport;
                const result = decodeSkills(bodyToDecode);
                return {
                    ok: true,
                    uid: playerUid,
                    ...result
                };
            }
        } catch (err) {
            // Tenta proximo endpoint
        }
    }

    return {
        ok: false,
        uid: playerUid,
        skills: [],
        pet: null,
        error: 'personal_show_lookup_failed'
    };
}

module.exports = {
    requestPlayerSkills,
    decodeSkills,
    encryptPayload,
    decryptPayload
};
