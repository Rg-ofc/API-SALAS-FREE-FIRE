const _axios = require('/root/salasff/node_modules/axios');
const axios = _axios.default || _axios;
const { HttpsProxyAgent } = require('/root/salasff/node_modules/https-proxy-agent');
const { RoomClient, encAes } = require('/root/salasff/cliente');
const { criarPacoteMajorLogin } = require('/root/salasff/pacotes');

async function testWithProxy() {
    const uid = process.env.TEST_UID || '';
    const pass = process.env.TEST_PASS || '';
    
    const proxyUser = process.env.PROXY_USER ? (process.env.PROXY_USER + '__session.' + uid) : '';
    const proxyUrl = process.env.PROXY_URL || (proxyUser && process.env.PROXY_PASS && process.env.PROXY_HOST ? `http://${proxyUser}:${process.env.PROXY_PASS}@${process.env.PROXY_HOST}:${process.env.PROXY_PORT || 823}` : '');
    const httpsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;
    const axiosConfig = httpsAgent ? { httpsAgent, timeout: 20000 } : { timeout: 20000 };

    console.log('1. Obtendo token guest...');
    const client = new RoomClient(uid, pass);
    const [at, oi] = await client.obterTokenGuest(true);
    console.log('Token guest OK:', oi);

    console.log('2. MajorLogin...');
    const proto = criarPacoteMajorLogin(oi, at, '45.188.255.22');
    const payload = Buffer.from(encAes(proto.toString('hex')), 'hex');
    
    const nowSec = Math.floor(Date.now() / 1000);
    const mlHeaders = {
        'Accept': '*/*',
        'Accept-Encoding': 'deflate, gzip',
        'Authorization': 'Bearer',
        'Connection': 'Keep-Alive',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Expect': '100-continue',
        'ReleaseVersion': 'OB55',
        'User-Agent': 'UnityPlayer/2018.4.12f1 (UnityWebRequest/1.0, libcurl/8.5.0-DEV)',
        'X-GA': 'v1 1',
        'X-GA-SV': String(nowSec),
        'X-Unity-Version': '2018.4.12f1'
    };

    const mlResp = await axios.post('https://loginbp.ppmainecoonghj.com/MajorLogin', payload, {
        headers: mlHeaders,
        responseType: 'arraybuffer',
        ...axiosConfig
    });
    console.log('MajorLogin Status:', mlResp.status);

    const strData = Buffer.from(mlResp.data).toString('latin1');
    const jwtMatch = strData.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    const realJwt = jwtMatch ? jwtMatch[0] : null;
    console.log('Real JWT len:', realJwt ? realJwt.length : 0);

    console.log('3. GetLoginData...');
    const glHeaders = {
        'Accept': '*/*',
        'Accept-Encoding': 'deflate, gzip',
        'Authorization': 'Bearer ' + realJwt,
        'Connection': 'Keep-Alive',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Expect': '100-continue',
        'ReleaseVersion': 'OB55',
        'User-Agent': 'UnityPlayer/2018.4.12f1 (UnityWebRequest/1.0, libcurl/8.5.0-DEV)',
        'X-GA': 'v1 1',
        'X-GA-SV': String(nowSec),
        'X-Unity-Version': '2018.4.12f1'
    };

    const glResp = await axios.post('https://client.us.freefiremobile.com/GetLoginData', payload, {
        headers: glHeaders,
        responseType: 'arraybuffer',
        validateStatus: false,
        ...axiosConfig
    });
    console.log('GetLoginData Status:', glResp.status, 'Len:', glResp.data ? glResp.data.length : 0);
    const bodyStr = Buffer.from(glResp.data).toString('utf-8');
    console.log('Body:', bodyStr.substring(0, 100));
}
testWithProxy().catch(console.error);
