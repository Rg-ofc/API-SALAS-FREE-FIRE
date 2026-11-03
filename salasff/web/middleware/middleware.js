'use strict';

const path = require('path');
const fs = require('fs');

const MaxBodySize = 2 * 1024 * 1024;

function cors(req, res, next) {
    setCORS(res);
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    next();
}

function setCORS(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
}

function logger(req, res, next) {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        if (duration > 1000) {
            console.log(`  \x1b[93m[SLOW]\x1b[0m ${req.method} ${req.url} (${duration}ms)`);
        }
    });
    next();
}

// Security Headers
function securityHeaders(req, res, next) {
    setSecurityHeaders(res);
    next();
}

function setSecurityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

// JSON Response
function jsonResponse(res, data, statusCode = 200) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.writeHead(statusCode);
    res.end(JSON.stringify(data));
}

// No Cache Headers
function noCacheHeaders(res) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
}

// Parse Body (JSON)
async function parseBody(req) {
    if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'DELETE') return null;
    if (req._parsedBody !== undefined) return req._parsedBody;

    return new Promise((resolve) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MaxBodySize) {
                req.destroy();
                resolve(null);
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                const body = Buffer.concat(chunks).toString('utf-8');
                const parsed = JSON.parse(body);
                req._parsedBody = parsed;
                resolve(parsed);
            } catch {
                req._parsedBody = null;
                resolve(null);
            }
        });
        req.on('error', () => resolve(null));
    });
}

// Extrair OAuth Key
function extrairOAuthKey(req, corpo) {
    if (req.method === 'POST') {
        const auth = req.headers['authorization'] || '';
        if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
        if (auth.trim()) return auth.trim();
        if (corpo && corpo.oauth_key) return String(corpo.oauth_key).trim();
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const qKey = url.searchParams.get('oauth_key');
        if (qKey) return qKey;
        return '';
    }
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    return url.searchParams.get('oauth_key') || '';
}

// Extrair Parâmetro
function extrairParam(req, nome, padrao, corpo) {
    if (req.method === 'POST') {
        if (corpo && corpo[nome] !== undefined && corpo[nome] !== null) {
            const val = corpo[nome];
            if (typeof val === 'string') return val;
            if (typeof val === 'number') return Number.isInteger(val) ? String(val) : String(val);
            if (typeof val === 'boolean') return val ? 'true' : 'false';
            return JSON.stringify(val);
        }
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const qVal = url.searchParams.get(nome);
        if (qVal) return qVal;
        return padrao;
    }
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const qVal = url.searchParams.get(nome);
    if (qVal) return qVal;
    return padrao;
}

// Sanitize Filename
function sanitizeFilename(filename) {
    filename = filename.replace(/\.\./g, '').replace(/[/\\]/g, '').trim();
    return filename || '_invalid_';
}

// Serve Static File
function serveStaticFile(res, req, baseDir, filename) {
    const clean = sanitizeFilename(filename);
    if (clean === '_invalid_' || clean !== filename) {
        res.writeHead(404);
        res.end('Not Found');
        return;
    }
    const ext = path.extname(clean).toLowerCase();
    const cacheExts = ['.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf'];
    if (cacheExts.includes(ext)) {
        res.setHeader('Cache-Control', 'public, max-age=3600');
    } else {
        noCacheHeaders(res);
    }
    const filePath = path.join(baseDir, clean);
    serveFile(res, req, filePath);
}

// Serve File helper
function serveFile(res, req, filePath) {
    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404);
            res.end('Not Found');
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
            '.html': 'text/html; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.js': 'application/javascript; charset=utf-8',
            '.json': 'application/json; charset=utf-8',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon',
            '.woff': 'font/woff',
            '.woff2': 'font/woff2',
            '.ttf': 'font/ttf',
            '.eot': 'application/vnd.ms-fontobject',
        };
        const contentType = mimeTypes[ext] || 'application/octet-stream';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Length', stats.size);
        res.writeHead(200);
        fs.createReadStream(filePath).pipe(res);
    });
}

// Get Client IP
function getClientIP(req) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return xff.split(',')[0].trim();
    const xri = req.headers['x-real-ip'];
    if (xri) return xri.trim();
    const addr = req.socket.remoteAddress || '';
    return addr.replace(/^::ffff:/, '');
}

module.exports = {
    cors,
    setCORS,
    logger,
    securityHeaders,
    setSecurityHeaders,
    jsonResponse,
    noCacheHeaders,
    parseBody,
    extrairOAuthKey,
    extrairParam,
    sanitizeFilename,
    serveStaticFile,
    serveFile,
    getClientIP,
    MaxBodySize,
};
