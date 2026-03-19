const express = require('express');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const app = express();

const PORT = process.env.PORT || 3000;
const XML_PATH = path.join(__dirname, 'clarovideo_epg.xml');
const DEFAULT_PAIS = process.env.DEFAULT_PAIS || 'mexico';
const DEFAULT_HOURS_BACK = Number(process.env.HOURS_BACK || 3);
const DEFAULT_HOURS_AHEAD = Number(process.env.HOURS_AHEAD || 12);
const CRON_INTERVAL_MS = 6 * 60 * 60 * 1000;

let isRunning = false;
let lastRunAt = null;
let lastSuccessAt = null;
let lastError = null;

function xmlEscape(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeText(text = '') {
  const map = {
    ñ: 'n', á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u',
    Ñ: 'N', Á: 'A', É: 'E', Í: 'I', Ó: 'O', Ú: 'U'
  };

  return String(text).replace(/[ñáéíóúÑÁÉÍÓÚ]/g, (m) => map[m] || m);
}

function pad(n) {
  return String(n).padStart(2, '0');
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
  return normalizeText(channelName)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function formatXmltvUtc(dateStr, gmt = 0) {
  if (!dateStr) return '';

  const sign = gmt >= 0 ? '+' : '-';
  const abs = Math.abs(gmt).toString().padStart(2, '0');

  const iso = dateStr.replace(/\//g, '-').replace(' ', 'T');
  const withOffset = `${iso}${sign}${abs}:00`;

  const date = new Date(withOffset);

  if (Number.isNaN(date.getTime())) {
    console.log('Fecha inválida:', withOffset);
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
  if (!dateStr) return '';

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
    throw new Error('JSON inválido: no existe response.channels');
  }

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<tv generator-info-name="ClaroVideo Puppeteer GMT">\n';

  const seenChannels = new Set();

  for (const channel of data.response.channels) {
    const rawChannelName = channel.name || '';
    const channelName = normalizeText(rawChannelName).trim();

    if (!channelName) continue;

    const channelId = buildChannelId(channelName);
    if (!channelId) continue;

    if (seenChannels.has(channelId)) continue;
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

    if (!channelName) continue;

    const channelId = buildChannelId(channelName);
    if (!channelId) continue;

    for (const ev of channel.events || []) {
      const gmt = Number(ev.gmt || 0);
      const start = formatXmltvUtc(ev.date_begin || '', gmt);
      const stop = formatXmltvUtc(ev.date_end || '', gmt);

      if (!start || !stop) continue;

      const title = normalizeText((ev.name || '').trim());
      const desc = normalizeText((ev.description || ev.name || '').trim());
      const dateOnly = formatXmltvDateOnlyUtc(ev.date_begin || '', gmt);

      programmes.push({
        channelId,
        start,
        stop,
        title,
        desc,
        dateOnly,
      });
    }
  }

  programmes.sort((a, b) => {
    if (a.channelId !== b.channelId) {
      return a.channelId.localeCompare(b.channelId);
    }
    return a.start.localeCompare(b.start);
  });

  for (const p of programmes) {
    xml += `  <programme channel="${xmlEscape(p.channelId)}" start="${xmlEscape(p.start)}" stop="${xmlEscape(p.stop)}">\n`;
    xml += `    <title>${xmlEscape(p.title)}</title>\n`;
    xml += `    <desc>${xmlEscape(p.desc)}</desc>\n`;
    xml += `    <date>${xmlEscape(p.dateOnly)}</date>\n`;
    xml += '  </programme>\n';
  }

  xml += '</tv>\n';

  return xml;
}

async function fetchClaroVideoJsonWithPuppeteer({
  pais = DEFAULT_PAIS,
  hoursBack = DEFAULT_HOURS_BACK,
  hoursAhead = DEFAULT_HOURS_AHEAD
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

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote'
    ],
  });

  try {
    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36'
    );

    await page.setExtraHTTPHeaders({
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://www.clarovideo.com',
      Referer: 'https://www.clarovideo.com/',
    });

    const response = await page.goto(apiUrl, {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });

    if (!response) {
      throw new Error('No hubo respuesta al consultar la API');
    }

    const status = response.status();
    const text = await response.text();

    if (status < 200 || status >= 300) {
      throw new Error(`HTTP ${status}: ${text.slice(0, 500)}`);
    }

    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(`La respuesta no es JSON válido: ${text.slice(0, 300)}`);
    }
  } finally {
    await browser.close();
  }
}

async function generateEpg({
  pais = DEFAULT_PAIS,
  hoursBack = DEFAULT_HOURS_BACK,
  hoursAhead = DEFAULT_HOURS_AHEAD,
  saveToDisk = true
} = {}) {
  if (isRunning) {
    throw new Error('Ya hay una generación en progreso');
  }

  isRunning = true;
  lastRunAt = new Date().toISOString();
  lastError = null;

  try {
    const data = await fetchClaroVideoJsonWithPuppeteer({ pais, hoursBack, hoursAhead });
    const xml = buildXml(data);

    if (saveToDisk) {
      fs.writeFileSync(XML_PATH, xml, 'utf8');
    }

    lastSuccessAt = new Date().toISOString();
    return xml;
  } catch (err) {
    lastError = err.message;
    throw err;
  } finally {
    isRunning = false;
  }
}

function startCronJob() {
  console.log('CRON iniciado (cada 6 horas)');

  async function run() {
    if (isRunning) {
      console.log('Cron omitido: ya hay una ejecución en progreso');
      return;
    }

    try {
      console.log('Generando EPG...', new Date().toISOString());

      await generateEpg({
        pais: DEFAULT_PAIS,
        hoursBack: DEFAULT_HOURS_BACK,
        hoursAhead: DEFAULT_HOURS_AHEAD,
        saveToDisk: true
      });

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
    const fileExists = fs.existsSync(XML_PATH);

    if (!fileExists) {
      console.log('No existe cache XML, generando en caliente...');

      const xml = await generateEpg({
        pais: req.query.pais || DEFAULT_PAIS,
        hoursBack: Number(req.query.hoursBack || DEFAULT_HOURS_BACK),
        hoursAhead: Number(req.query.hoursAhead || DEFAULT_HOURS_AHEAD),
        saveToDisk: true
      });

      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      return res.send(xml);
    }

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    return res.sendFile(XML_PATH, (err) => {
      if (err) {
        res
          .status(500)
          .type('application/xml')
          .send('<?xml version="1.0" encoding="UTF-8"?><error>No se pudo enviar el archivo XML</error>');
      }
    });
  } catch (error) {
    res
      .status(500)
      .type('application/xml')
      .send(`<?xml version="1.0" encoding="UTF-8"?><error>${xmlEscape(error.message)}</error>`);
  }
});

app.get('/refresh', async (req, res) => {
  try {
    const xml = await generateEpg({
      pais: req.query.pais || DEFAULT_PAIS,
      hoursBack: Number(req.query.hoursBack || DEFAULT_HOURS_BACK),
      hoursAhead: Number(req.query.hoursAhead || DEFAULT_HOURS_AHEAD),
      saveToDisk: true
    });

    res.json({
      ok: true,
      message: 'EPG regenerado correctamente',
      bytes: Buffer.byteLength(xml, 'utf8'),
      lastSuccessAt
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    isRunning,
    lastRunAt,
    lastSuccessAt,
    lastError,
    cacheExists: fs.existsSync(XML_PATH)
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor en http://0.0.0.0:${PORT}/epg.xml`);
  startCronJob();
});