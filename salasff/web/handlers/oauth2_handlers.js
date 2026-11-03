'use strict';

const crypto = require('crypto');
const https = require('https');
const querystring = require('querystring');
const cryptoUtils = require('../crypto_utils');
const h = require('./helpers');

const discordClientID = process.env.DISCORD_CLIENT_ID || '';
const discordClientSecret = process.env.DISCORD_CLIENT_SECRET || '';
const discordBaseURL = process.env.DISCORD_BASE_URL || 'https://neonsalas.store';
const discordAuthorizeURL = 'https://discord.com/api/oauth2/authorize';
const discordTokenURL = 'https://discord.com/api/oauth2/token';
const discordUserURL = 'https://discord.com/api/users/@me';

const adminDiscordIDs = {};
if (process.env.ADMIN_DISCORD_IDS) {
    process.env.ADMIN_DISCORD_IDS.split(',').forEach(id => {
        if (id.trim()) adminDiscordIDs[id.trim()] = true;
    });
}

const oauthStates = new Map();

function generateOAuthState() {
    return crypto.randomBytes(16).toString('hex');
}

function cleanExpiredStates() {
    const now = Date.now();
    for (const [state, info] of oauthStates) {
        if (now - info.createdAt > 10 * 60 * 1000) oauthStates.delete(state);
    }
}

function getDiscordRedirectURI(loginType) {
    return loginType === 'admin' ? discordBaseURL + '/admin/oauth/callback' : discordBaseURL + '/auth/callback';
}

function buildDiscordAuthURL(state, loginType) {
    const redirectURI = getDiscordRedirectURI(loginType);
    const params = querystring.stringify({
        client_id: discordClientID, redirect_uri: redirectURI,
        response_type: 'code', scope: 'identify', state, prompt: 'none',
    });
    return discordAuthorizeURL + '?' + params;
}

function exchangeCodeForToken(code, loginType) {
    return new Promise((resolve, reject) => {
        const redirectURI = getDiscordRedirectURI(loginType);
        const data = querystring.stringify({
            client_id: discordClientID, client_secret: discordClientSecret,
            grant_type: 'authorization_code', code, redirect_uri: redirectURI,
        });
        const url = new URL(discordTokenURL);
        const req = https.request({ hostname: url.hostname, path: url.pathname, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                try {
                    const body = JSON.parse(Buffer.concat(chunks).toString());
                    if (body.access_token) resolve(body.access_token);
                    else reject(new Error('access_token nao encontrado: ' + JSON.stringify(body)));
                } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

function fetchDiscordUser(accessToken) {
    return new Promise((resolve, reject) => {
        const url = new URL(discordUserURL);
        const req = https.request({ hostname: url.hostname, path: url.pathname, method: 'GET', headers: { Authorization: 'Bearer ' + accessToken } }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                try {
                    const user = JSON.parse(Buffer.concat(chunks).toString());
                    if (!user.id) reject(new Error('usuario invalido'));
                    else resolve(user);
                } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

function getDiscordAvatarURL(user) {
    if (!user.avatar) return 'https://cdn.discordapp.com/embed/avatars/0.png';
    const ext = user.avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=128`;
}

function getDisplayName(user) { return user.global_name || user.username; }

function OAuth2AdminRedirect(req, res) {
    if (h.verificarAdminLogado(req)) { res.writeHead(302, { Location: '/dashadmin' }); res.end(); return; }
    cleanExpiredStates();
    const state = generateOAuthState();
    oauthStates.set(state, { createdAt: Date.now(), type: 'admin' });
    const authURL = buildDiscordAuthURL(state, 'admin');
    res.writeHead(302, { Location: authURL }); res.end();
}

async function OAuth2AdminCallback(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const code = url.searchParams.get('code') || '';
    const state = url.searchParams.get('state') || '';
    const errorParam = url.searchParams.get('error') || '';

    if (errorParam) { res.writeHead(302, { Location: '/admin/oauth' }); res.end(); return; }
    const stateInfo = oauthStates.get(state);
    if (stateInfo) oauthStates.delete(state);
    if (!stateInfo || stateInfo.type !== 'admin') { res.writeHead(302, { Location: '/admin/oauth?erro=state' }); res.end(); return; }
    if (!code) { res.writeHead(302, { Location: '/admin/oauth?erro=nocode' }); res.end(); return; }

    try {
        const accessToken = await exchangeCodeForToken(code, 'admin');
        const discUser = await fetchDiscordUser(accessToken);

        if (!adminDiscordIDs[discUser.id]) {
            console.log(`[OAUTH2 ADMIN] Acesso negado para Discord ID: ${discUser.id} (${discUser.username})`);
            res.writeHead(302, { Location: '/erro-acesso' }); res.end(); return;
        }

        const displayName = getDisplayName(discUser);
        const avatarURL = getDiscordAvatarURL(discUser);
        const userID = 'discord_' + discUser.id;
        const sessionToken = cryptoUtils.gerarTokenSessao();
        const csrfToken = cryptoUtils.gerarCSRFToken();

        const [sess] = h.createAdminSession(res, req);
        sess.adminLogado = true;
        sess.adminUserID = userID;
        sess.adminUsername = displayName;
        sess.adminAvatar = avatarURL;
        sess.sessionToken = sessionToken;
        sess.csrfToken = csrfToken;
        sess.accessToken = accessToken;
        sess.permanent = true;

        const sessions = h.carregarAdminSessions();
        sessions[userID] = { user_id: userID, discord_id: discUser.id, username: displayName, avatar: avatarURL, session_token: sessionToken, csrf_token: csrfToken, ultimo_acesso: h.obterHoraBrasilia() };
        h.salvarAdminSessions(sessions);
        h.persistSessionStore();

        const infoAdmin = h.carregarInfoAdmin();
        Object.assign(infoAdmin, { user_id: userID, discord_id: discUser.id, username: displayName, avatar: avatarURL, session_token: sessionToken, csrf_token: csrfToken, ultimo_acesso: h.obterHoraBrasilia(), total_logins: h.getFloat(infoAdmin, 'total_logins') + 1 });
        h.salvarInfoAdmin(infoAdmin);

        console.log(`[OAUTH2 ADMIN] Login OK: ${displayName} (${discUser.username}) - Discord ID: ${discUser.id}`);
        res.writeHead(302, { Location: '/dashadmin' }); res.end();
    } catch (err) {
        console.error('[OAUTH2 ADMIN] Erro:', err.message);
        res.writeHead(302, { Location: '/admin/oauth?erro=token' }); res.end();
    }
}

function OAuth2DashboardRedirect(req, res) {
    const cookies = h.parseCookies(req);
    const token = cookies.dash_session || '';
    if (h.validarSessaoDashboard(token)) { res.writeHead(302, { Location: '/dashboard' }); res.end(); return; }
    cleanExpiredStates();
    const state = generateOAuthState();
    oauthStates.set(state, { createdAt: Date.now(), type: 'dashboard' });
    const authURL = buildDiscordAuthURL(state, 'dashboard');
    res.writeHead(302, { Location: authURL }); res.end();
}

async function OAuth2DashboardCallback(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const code = url.searchParams.get('code') || '';
    const state = url.searchParams.get('state') || '';
    const errorParam = url.searchParams.get('error') || '';

    if (errorParam) { res.writeHead(302, { Location: '/dashboard/login' }); res.end(); return; }
    const stateInfo = oauthStates.get(state);
    if (stateInfo) oauthStates.delete(state);
    if (!stateInfo || stateInfo.type !== 'dashboard') { res.writeHead(302, { Location: '/dashboard/login?erro=state' }); res.end(); return; }
    if (!code) { res.writeHead(302, { Location: '/dashboard/login?erro=nocode' }); res.end(); return; }

    try {
        const accessToken = await exchangeCodeForToken(code, 'dashboard');
        const discUser = await fetchDiscordUser(accessToken);
        const displayName = getDisplayName(discUser);
        const avatarURL = getDiscordAvatarURL(discUser);
        const userID = 'discord_' + discUser.id;

        h.registrarUsuario(userID, displayName, avatarURL);
        const [tokenSessao] = h.criarSessaoDashboard(userID, displayName, avatarURL);
        const secure = h.isSecureRequest(req);
        res.setHeader('Set-Cookie', `dash_session=${tokenSessao}; Path=/; Max-Age=${14 * 24 * 60 * 60}; HttpOnly${secure ? '; Secure' : ''}; SameSite=Lax`);

        console.log(`[OAUTH2 DASH] Login OK: ${displayName} (${discUser.username}) - Discord ID: ${discUser.id}`);
        res.writeHead(302, { Location: '/dashboard' }); res.end();
    } catch (err) {
        console.error('[OAUTH2 DASH] Erro:', err.message);
        res.writeHead(302, { Location: '/dashboard/login?erro=token' }); res.end();
    }
}

module.exports = {
    OAuth2AdminRedirect, OAuth2AdminCallback,
    OAuth2DashboardRedirect, OAuth2DashboardCallback,
    adminDiscordIDs,
};
