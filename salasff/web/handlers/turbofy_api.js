const axios = require('axios');

const TURBOFY_API_URL = 'https://api.turbofypay.com';
const CLIENT_ID = process.env.TURBOFY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.TURBOFY_CLIENT_SECRET || '';

async function criarCobrancaPix(amountCents, description, externalRef) {
    try {
        const response = await axios.post(`${TURBOFY_API_URL}/sellers/pix`, {
            amountCents,
            description,
            externalRef
        }, {
            headers: {
                'x-client-id': CLIENT_ID,
                'x-client-secret': CLIENT_SECRET,
                'Content-Type': 'application/json'
            },
            timeout: 10000
        });
        return response.data;
    } catch (err) {
        console.error('[TURBOFY API] Erro ao criar cobranca:', err.response ? err.response.data : err.message);
        const errMsg = err.response && err.response.data && err.response.data.error ? err.response.data.error.message : err.message;
        throw new Error(errMsg);
    }
}

async function consultarCobrancaPix(id) {
    try {
        const response = await axios.get(`${TURBOFY_API_URL}/sellers/pix/${id}`, {
            headers: {
                'x-client-id': CLIENT_ID,
                'x-client-secret': CLIENT_SECRET
            },
            timeout: 10000
        });
        return response.data;
    } catch (err) {
        console.error('[TURBOFY API] Erro ao consultar cobranca:', err.response ? err.response.data : err.message);
        const errMsg = err.response && err.response.data && err.response.data.error ? err.response.data.error.message : err.message;
        throw new Error(errMsg);
    }
}

const crypto = require('crypto');

function detectarTipoChavePix(chave) {
    if (!chave || typeof chave !== 'string') return 'EVP';
    chave = chave.trim();
    if (chave.includes('@')) return 'EMAIL';
    const digitsOnly = chave.replace(/\D/g, '');
    if (digitsOnly.length === 11 && !chave.startsWith('+')) return 'CPF';
    if (digitsOnly.length === 14) return 'CNPJ';
    if (chave.startsWith('+') || (digitsOnly.length >= 10 && digitsOnly.length <= 13 && !chave.includes('-'))) return 'PHONE';
    return 'EVP';
}

async function criarLotePayout({ pixKey, amountCents, recipientName, recipientDocument, description, idempotencyKey, pixKeyType }) {
    const pathOnly = '/v1/payouts/batches';
    const timestamp = Date.now().toString();
    const method = 'POST';

    const payloadObj = {
        idempotencyKey: idempotencyKey || `saque-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
        description: description || 'Saque de Saldo Afiliado',
        items: [
            {
                pixKey: pixKey.trim(),
                pixKeyType: pixKeyType || detectarTipoChavePix(pixKey),
                amountCents: amountCents,
                recipientName: (recipientName || 'Afiliado').trim(),
                referenceId: `item-${Date.now()}`
            }
        ]
    };

    if (recipientDocument) {
        payloadObj.items[0].recipientDocument = recipientDocument.replace(/\D/g, '');
    }

    const bodyStr = JSON.stringify(payloadObj);
    const signaturePayload = `${timestamp}.${method}.${pathOnly}.${bodyStr}`;
    const signature = crypto.createHmac('sha256', CLIENT_SECRET).update(signaturePayload).digest('hex');

    try {
        const response = await axios.post(`${TURBOFY_API_URL}${pathOnly}`, payloadObj, {
            headers: {
                'x-client-id': CLIENT_ID,
                'x-client-secret': CLIENT_SECRET,
                'x-turbofy-timestamp': timestamp,
                'x-turbofy-signature': signature,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });
        return response.data;
    } catch (err) {
        console.error('[TURBOFY PAYOUT API] Erro ao criar lote de payout:', err.response ? err.response.data : err.message);
        const errMsg = err.response && err.response.data && err.response.data.error ? (err.response.data.error.message || JSON.stringify(err.response.data.error)) : err.message;
        throw new Error(errMsg);
    }
}

module.exports = {
    criarCobrancaPix,
    consultarCobrancaPix,
    criarLotePayout,
    detectarTipoChavePix
};
