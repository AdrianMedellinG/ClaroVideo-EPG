const express = require('express');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

loadEnvFile(path.join(__dirname, '.env'));

const app = express();
app.disable('x-powered-by');

const LEGACY_XML_PATH = path.join(__dirname, 'clarovideo_epg.xml');
const CACHE_DIR = path.join(__dirname, 'cache');
const CACHE_PREFIX = 'clarovideo_epg';
const CRON_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_HOURS_RANGE = 168;

const MOJIBAKE_REPLACEMENTS = new Map([
  ['\u00c3\u00b1', '\u00f1'],
  ['\u00c3\u00a1', '\u00e1'],
  ['\u00c3\u00a9', '\u00e9'],
  ['\u00c3\u00ad', '\u00ed'],
  ['\u00c3\u00b3', '\u00f3'],
  ['\u00c3\u00ba', '\u00fa'],
  ['\u00c3\u2018', '\u00d1'],
  ['\u00c3\u0081', '\u00c1'],
  ['\u00c3\u0089', '\u00c9'],
  ['\u00c3\u008d', '\u00cd'],
  ['\u00c3\u201c', '\u00d3'],
  ['\u00c3\u0161', '\u00da'],
]);

const PORT = getEnvPort(process.env.PORT, 3000);
const PUPPETEER_EXECUTABLE_PATH = String(process.env.PUPPETEER_EXECUTABLE_PATH || '').trim();
const DEFAULT_PAIS = sanitizePais(process.env.DEFAULT_PAIS || 'mexico', 'mexico');
const DEFAULT_HOURS_BACK = getEnvHours('HOURS_BACK', 3);
const DEFAULT_HOURS_AHEAD = getEnvHours('HOURS_AHEAD', 12);
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || '').trim();

const SOCKS_PROXY_URL = process.env.SOCKS_PROXY_URL || '';
const PROXY_HOST = process.env.PROXY_HOST || '';
const PROXY_PORT = process.env.PROXY_PORT || '';
const PROXY_USER = process.env.PROXY_USER || '';
const PROXY_PASS = process.env.PROXY_PASS || '';

let isRunning = false;
let lastRunAt = null;
let lastSuccessAt = null;
let lastError = null;
let lastDurationMs = null;
let activeGeneration = null;
let generationQueue = Promise.resolve();

const pendingGenerations = new Map();

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line || line.startsWith('#')) {
      continue;
    }

    const normalizedLine = line.startsWith('export ') ? line.slice(7) : line;
    const separatorIndex = normalizedLine.indexOf('=');

    if (separatorIndex === -1) {
      continue;
    }

    const key = normalizedLine.slice(0, separatorIndex).trim();
    let value = normalizedLine.slice(separatorIndex + 1).trim();

    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function xmlEscape(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeText(text = '') {
  let value = String(text);

  for (const [broken, fixed] of MOJIBAKE_REPLACEMENTS) {
    value = value.replaceAll(broken, fixed);
  }

  return value;
}

function stripDiacritics(text = '') {
  return normalizeText(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function getEnvPort(value, fallback) {
  const parsed = Number(value);

  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
    return parsed;
  }

  return fallback;
}

function getEnvHours(name, fallback) {
  const raw = process.env[name];

  if (raw == null || raw === '') {
    return fallback;
  }

  const parsed = Number(raw);

  if (Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_HOURS_RANGE) {
    return parsed;
  }

  console.warn(`${name} invalido (${raw}), usando ${fallback}`);
  return fallback;
}

function getConfiguredExecutablePath() {
  if (!PUPPETEER_EXECUTABLE_PATH) {
    return '';
  }

  if (fs.existsSync(PUPPETEER_EXECUTABLE_PATH)) {
    return PUPPETEER_EXECUTABLE_PATH;
  }

  console.warn(
    `PUPPETEER_EXECUTABLE_PATH no existe (${PUPPETEER_EXECUTABLE_PATH}), usando el navegador por defecto de Puppeteer`
  );
  return '';
}

function sanitizePais(value, fallback = 'mexico') {
  const normalized = stripDiacritics(String(value || ''))
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9_-]/g, '');

  return normalized || fallback;
}

function parseHoursValue(value, fallback, name) {
  if (value == null || value === '') {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    throw createHttpError(400, `El parametro "${name}" debe ser un entero`);
  }

  if (parsed < 0 || parsed > MAX_HOURS_RANGE) {
    throw createHttpError(
      400,
      `El parametro "${name}" debe estar entre 0 y ${MAX_HOURS_RANGE}`
    );
  }

  return parsed;
}

function parsePaisValue(value, fallback) {
  if (value == null || value === '') {
    return fallback;
  }

  const normalized = sanitizePais(value, '');

  if (!normalized) {
    throw createHttpError(400, 'El parametro "pais" es invalido');
  }

  return normalized;
}

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function formatApiDate(date) {
  return (
    date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

function getDateRange(hoursBack = DEFAULT_HOURS_BACK, hoursAhead = DEFAULT_HOURS_AHEAD) {
  const now = new Date();

  const from = new Date(now);
  from.setHours(from.getHours() - hoursBack);

  const to = new Date(now);
  to.setHours(to.getHours() + hoursAhead);

  return {
    date_from: formatApiDate(from),
    date_to: formatApiDate(to),
  };
}

function buildChannelId(channelName = '') {
  return stripDiacritics(channelName)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function formatXmltvUtc(dateStr, gmt = 0) {
  if (!dateStr) {
    return '';
  }

  const sign = gmt >= 0 ? '+' : '-';
  const abs = Math.abs(gmt).toString().padStart(2, '0');
  const iso = dateStr.replace(/\//g, '-').replace(' ', 'T');
  const withOffset = `${iso}${sign}${abs}:00`;
  const date = new Date(withOffset);

  if (Number.isNaN(date.getTime())) {
    console.log('Fecha invalida:', withOffset);
    return '';
  }

  return (
    date.getUTCFullYear() +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    ' +0000'
  );
}

function formatXmltvDateOnlyUtc(dateStr, gmt = 0) {
  if (!dateStr) {
    return '';
  }

  const sign = gmt >= 0 ? '+' : '-';
  const abs = Math.abs(gmt).toString().padStart(2, '0');
  const iso = dateStr.replace(/\//g, '-').replace(' ', 'T');
  const withOffset = `${iso}${sign}${abs}:00`;
  const date = new Date(withOffset);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return (
    date.getUTCFullYear() +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate())
  );
}

function buildXml(data) {
  if (!data || !data.response || !Array.isArray(data.response.channels)) {
    throw new Error('JSON invalido: no existe response.channels');
  }

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<tv generator-info-name="ClaroVideo Puppeteer GMT">\n';

  const seenChannels = new Set();

  for (const channel of data.response.channels) {
    const rawChannelName = channel.name || '';
    const channelName = normalizeText(rawChannelName).trim();

    if (!channelName) {
      continue;
    }

    const channelId = buildChannelId(channelName);

    if (!channelId || seenChannels.has(channelId)) {
      continue;
    }

    seenChannels.add(channelId);
    xml += `  <channel id="${xmlEscape(channelId)}">\n`;
    xml += `    <display-name>${xmlEscape(channelName)}</display-name>\n`;

    if (channel.image) {
      xml += `    <icon src="${xmlEscape(channel.image)}"/>\n`;
    }

    xml += '  </channel>\n';
  }

  const programmes = [];

  for (const channel of data.response.channels) {
    const rawChannelName = channel.name || '';
    const channelName = normalizeText(rawChannelName).trim();

    if (!channelName) {
      continue;
    }

    const channelId = buildChannelId(channelName);

    if (!channelId) {
      continue;
    }

    for (const ev of channel.events || []) {
      const gmt = Number(ev.gmt || 0);
      const start = formatXmltvUtc(ev.date_begin || '', gmt);
      const stop = formatXmltvUtc(ev.date_end || '', gmt);

      if (!start || !stop) {
        continue;
      }

      programmes.push({
        channelId,
        start,
        stop,
        title: normalizeText((ev.name || '').trim()),
        desc: normalizeText((ev.description || ev.name || '').trim()),
        dateOnly: formatXmltvDateOnlyUtc(ev.date_begin || '', gmt),
      });
    }
  }

  programmes.sort((a, b) => {
    if (a.channelId !== b.channelId) {
      return a.channelId.localeCompare(b.channelId);
    }

    return a.start.localeCompare(b.start);
  });

  for (const programme of programmes) {
    xml += `  <programme channel="${xmlEscape(programme.channelId)}" start="${xmlEscape(programme.start)}" stop="${xmlEscape(programme.stop)}">\n`;
    xml += `    <title>${xmlEscape(programme.title)}</title>\n`;
    xml += `    <desc>${xmlEscape(programme.desc)}</desc>\n`;
    xml += `    <date>${xmlEscape(programme.dateOnly)}</date>\n`;
    xml += '  </programme>\n';
  }

  xml += '</tv>\n';
  return xml;
}

function getProxyConfig() {
  if (SOCKS_PROXY_URL) {
    try {
      const parsed = new URL(SOCKS_PROXY_URL);

      return {
        proxyServerArg: `${parsed.protocol}//${parsed.hostname}:${parsed.port}`,
        username: decodeURIComponent(parsed.username || ''),
        password: decodeURIComponent(parsed.password || ''),
        display: `${parsed.protocol}//${parsed.hostname}:${parsed.port}`,
        type: parsed.protocol.replace(':', ''),
      };
    } catch (err) {
      throw new Error(`SOCKS_PROXY_URL invalido: ${err.message}`);
    }
  }

  if (PROXY_HOST && PROXY_PORT) {
    return {
      proxyServerArg: `http://${PROXY_HOST}:${PROXY_PORT}`,
      username: PROXY_USER,
      password: PROXY_PASS,
      display: `http://${PROXY_HOST}:${PROXY_PORT}`,
      type: 'http',
    };
  }

  return null;
}

async function launchBrowser() {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-zygote',
  ];

  const proxyConfig = getProxyConfig();

  if (proxyConfig) {
    args.push(`--proxy-server=${proxyConfig.proxyServerArg}`);
  }

  const launchOptions = {
    headless: true,
    args,
  };

  const executablePath = getConfiguredExecutablePath();

  if (executablePath) {
    launchOptions.executablePath = executablePath;
  }

  return puppeteer.launch(launchOptions);
}

async function preparePage(browser) {
  const page = await browser.newPage();
  const proxyConfig = getProxyConfig();

  if (proxyConfig?.username && proxyConfig?.password) {
    await page.authenticate({
      username: proxyConfig.username,
      password: proxyConfig.password,
    });
  }

  await page.setUserAgent(
    'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36'
  );

  await page.setExtraHTTPHeaders({
    Accept: 'application/json, text/plain, */*',
    Origin: 'https://www.clarovideo.com',
    Referer: 'https://www.clarovideo.com/',
  });

  return page;
}

function resolveGenerationOptions(source = {}) {
  const pais = parsePaisValue(source.pais, DEFAULT_PAIS);
  const hoursBack = parseHoursValue(source.hoursBack, DEFAULT_HOURS_BACK, 'hoursBack');
  const hoursAhead = parseHoursValue(source.hoursAhead, DEFAULT_HOURS_AHEAD, 'hoursAhead');
  const saveToDisk = source.saveToDisk !== false;
  const cacheInfo = getCacheInfo({ pais, hoursBack, hoursAhead });

  return {
    pais,
    hoursBack,
    hoursAhead,
    saveToDisk,
    cacheInfo,
  };
}

function getCacheInfo({ pais, hoursBack, hoursAhead }) {
  const cacheKey = `${pais}_${hoursBack}_${hoursAhead}`;
  const isDefault =
    pais === DEFAULT_PAIS &&
    hoursBack === DEFAULT_HOURS_BACK &&
    hoursAhead === DEFAULT_HOURS_AHEAD;

  return {
    cacheKey,
    isDefault,
    filePath: isDefault
      ? LEGACY_XML_PATH
      : path.join(CACHE_DIR, `${CACHE_PREFIX}_${cacheKey}.xml`),
  };
}

function ensureCacheDirectory(filePath) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
}

function writeXmlCache(filePath, xml) {
  ensureCacheDirectory(filePath);

  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, xml, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function sendXml(res, xml) {
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.send(xml);
}

function sendXmlError(res, error) {
  const status = error.status || 500;
  res
    .status(status)
    .type('application/xml')
    .send(`<?xml version="1.0" encoding="UTF-8"?><error>${xmlEscape(error.message)}</error>`);
}

function sendJsonError(res, error) {
  const status = error.status || 500;
  res.status(status).json({
    ok: false,
    error: error.message,
  });
}

function canAccessAdminRoutes(req) {
  if (!ADMIN_TOKEN) {
    return true;
  }

  const candidate = String(req.get('x-admin-token') || req.query.token || '').trim();
  return candidate === ADMIN_TOKEN;
}

function requireAdminAccess(req, res) {
  if (canAccessAdminRoutes(req)) {
    return true;
  }

  res.status(401).json({
    ok: false,
    error: 'Unauthorized',
  });

  return false;
}

async function fetchClaroVideoJsonWithPuppeteer({
  pais = DEFAULT_PAIS,
  hoursBack = DEFAULT_HOURS_BACK,
  hoursAhead = DEFAULT_HOURS_AHEAD,
} = {}) {
  const { date_from, date_to } = getDateRange(hoursBack, hoursAhead);
  const params = new URLSearchParams({
    device_id: 'web',
    device_category: 'web',
    device_model: 'web',
    device_type: 'web',
    device_so: 'Chrome',
    format: 'json',
    device_manufacturer: 'generic',
    authpn: 'webclient',
    authpt: 'tfg1h3j4k6fd7',
    api_version: 'v5.93',
    region: pais,
    HKS: '(web69b3087c5299b)',
    user_id: '82348660',
    node_id: '18132',
    quantity: '43',
    date_from,
    date_to,
  });

  const apiUrl = `https://mfwkweb-api.clarovideo.net/services/epg/channel?${params.toString()}`;
  const proxyConfig = getProxyConfig();

  console.log('Consultando API:', apiUrl);
  console.log('Proxy activo:', proxyConfig ? proxyConfig.display : 'no');

  const browser = await launchBrowser();

  try {
    const page = await preparePage(browser);

    await page.goto('https://www.clarovideo.com/', {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });

    await new Promise((resolve) => setTimeout(resolve, 3000));

    const result = await page.evaluate(async (url) => {
      const res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: {
          Accept: 'application/json, text/plain, */*',
        },
      });

      const text = await res.text();

      return {
        ok: res.ok,
        status: res.status,
        text,
      };
    }, apiUrl);

    if (!result.ok) {
      throw new Error(`HTTP ${result.status}: ${result.text.slice(0, 500)}`);
    }

    try {
      return JSON.parse(result.text);
    } catch {
      throw new Error('La respuesta no es JSON valido');
    }
  } finally {
    await browser.close();
  }
}

async function getBrowserIp() {
  const browser = await launchBrowser();

  try {
    const page = await preparePage(browser);
    const response = await page.goto('https://api.ipify.org?format=json', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    if (!response) {
      throw new Error('No hubo respuesta consultando IP');
    }

    return JSON.parse(await response.text());
  } finally {
    await browser.close();
  }
}

function buildGenerationSummary(request, xml) {
  return {
    xml,
    bytes: Buffer.byteLength(xml, 'utf8'),
    cacheKey: request.cacheInfo.cacheKey,
    cachePath: request.cacheInfo.filePath,
    isDefaultCache: request.cacheInfo.isDefault,
    params: {
      pais: request.pais,
      hoursBack: request.hoursBack,
      hoursAhead: request.hoursAhead,
    },
  };
}

function generateEpg(source = {}) {
  const request = resolveGenerationOptions(source);
  const existing = pendingGenerations.get(request.cacheInfo.cacheKey);

  if (existing) {
    return existing;
  }

  const promise = generationQueue.catch(() => null).then(async () => {
    isRunning = true;
    lastRunAt = new Date().toISOString();
    lastError = null;
    activeGeneration = {
      cacheKey: request.cacheInfo.cacheKey,
      filePath: request.cacheInfo.filePath,
      pais: request.pais,
      hoursBack: request.hoursBack,
      hoursAhead: request.hoursAhead,
    };

    const startedAt = Date.now();

    try {
      const data = await fetchClaroVideoJsonWithPuppeteer(request);
      const xml = buildXml(data);

      if (request.saveToDisk) {
        writeXmlCache(request.cacheInfo.filePath, xml);
      }

      lastSuccessAt = new Date().toISOString();
      lastDurationMs = Date.now() - startedAt;

      return buildGenerationSummary(request, xml);
    } catch (err) {
      lastError = err.message;
      lastDurationMs = Date.now() - startedAt;
      throw err;
    } finally {
      isRunning = false;
      activeGeneration = null;
    }
  });

  pendingGenerations.set(request.cacheInfo.cacheKey, promise);
  generationQueue = promise.catch(() => null);

  return promise.finally(() => {
    if (pendingGenerations.get(request.cacheInfo.cacheKey) === promise) {
      pendingGenerations.delete(request.cacheInfo.cacheKey);
    }
  });
}

function defaultGenerationOptions() {
  return {
    pais: DEFAULT_PAIS,
    hoursBack: DEFAULT_HOURS_BACK,
    hoursAhead: DEFAULT_HOURS_AHEAD,
  };
}

function parseRequestOptions(req) {
  return resolveGenerationOptions({
    pais: req.query.pais,
    hoursBack: req.query.hoursBack,
    hoursAhead: req.query.hoursAhead,
    saveToDisk: true,
  });
}

function startCronJob() {
  console.log('CRON iniciado (cada 6 horas)');

  async function run() {
    try {
      console.log('Generando EPG...', new Date().toISOString());
      await generateEpg(defaultGenerationOptions());
      console.log('EPG actualizado correctamente');
    } catch (err) {
      console.error('Error en CRON:', err.message);
    }
  }

  run();
  setInterval(run, CRON_INTERVAL_MS);
}

app.get('/epg.xml', async (req, res) => {
  try {
    const request = parseRequestOptions(req);
    const fileExists = fs.existsSync(request.cacheInfo.filePath);

    if (fileExists) {
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      return res.sendFile(request.cacheInfo.filePath, (err) => {
        if (err && !res.headersSent) {
          sendXmlError(res, new Error('No se pudo enviar el archivo XML'));
        }
      });
    }

    console.log(`No existe cache XML para ${request.cacheInfo.cacheKey}, generando...`);
    const result = await generateEpg(request);
    return sendXml(res, result.xml);
  } catch (error) {
    return sendXmlError(res, error);
  }
});

app.get('/refresh', async (req, res) => {
  if (!requireAdminAccess(req, res)) {
    return;
  }

  try {
    const request = parseRequestOptions(req);
    const result = await generateEpg(request);

    res.json({
      ok: true,
      message: 'EPG regenerado correctamente',
      bytes: result.bytes,
      cacheKey: result.cacheKey,
      cachePath: path.relative(__dirname, result.cachePath) || path.basename(result.cachePath),
      lastSuccessAt,
      params: result.params,
    });
  } catch (error) {
    sendJsonError(res, error);
  }
});

app.get('/health', (req, res) => {
  const proxyConfig = getProxyConfig();
  const defaultCache = getCacheInfo(defaultGenerationOptions());
  const cacheExists = fs.existsSync(defaultCache.filePath);
  const ok = cacheExists || Boolean(lastSuccessAt);

  res.status(ok ? 200 : 503).json({
    ok,
    isRunning,
    lastRunAt,
    lastSuccessAt,
    lastError,
    lastDurationMs,
    cacheExists,
    defaultCachePath: path.relative(__dirname, defaultCache.filePath) || path.basename(defaultCache.filePath),
    pendingGenerations: pendingGenerations.size,
    activeGeneration,
    defaults: defaultGenerationOptions(),
    proxyEnabled: Boolean(proxyConfig),
    proxyType: proxyConfig?.type || null,
    proxyDisplay: proxyConfig?.display || null,
    proxyAuthEnabled: Boolean(proxyConfig?.username && proxyConfig?.password),
    adminProtectionEnabled: Boolean(ADMIN_TOKEN),
  });
});

app.get('/debug-ip', async (req, res) => {
  if (!requireAdminAccess(req, res)) {
    return;
  }

  try {
    const ip = await getBrowserIp();
    const proxyConfig = getProxyConfig();

    res.json({
      ok: true,
      proxyEnabled: Boolean(proxyConfig),
      proxyType: proxyConfig?.type || null,
      proxyDisplay: proxyConfig?.display || null,
      proxyAuthEnabled: Boolean(proxyConfig?.username && proxyConfig?.password),
      ip,
    });
  } catch (error) {
    sendJsonError(res, error);
  }
});

function startServer() {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor en http://0.0.0.0:${PORT}/epg.xml`);
    startCronJob();
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  buildXml,
  defaultGenerationOptions,
  formatXmltvDateOnlyUtc,
  formatXmltvUtc,
  getCacheInfo,
  getDateRange,
  normalizeText,
  resolveGenerationOptions,
  startServer,
};
