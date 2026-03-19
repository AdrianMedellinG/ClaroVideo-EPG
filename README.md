# ClaroVideo EPG Generator

Generador de EPG en formato XMLTV usando **Node.js + Express + Puppeteer**.

- Obtiene la programacion desde ClaroVideo con un navegador real
- Convierte horarios a UTC para salida XMLTV
- Guarda cache XML por combinacion de parametros
- Expone endpoints HTTP para lectura, refresco y diagnostico
- Actualiza automaticamente el cache por defecto cada 6 horas

## Requisitos

- Node.js 18+
- npm
- Acceso a internet desde el servidor
- Chromium o Chrome instalado si no quieres usar el navegador por defecto de Puppeteer

## Instalacion local

```bash
git clone https://github.com/tu-usuario/clarovideoepg.git
cd clarovideoepg
npm install
```

Crea un archivo `.env`:

```env
PORT=3000
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
DEFAULT_PAIS=mexico
HOURS_BACK=3
HOURS_AHEAD=12
ADMIN_TOKEN=
TZ=America/Monterrey
```

`server.js` carga `.env` automaticamente al iniciar. Si `PUPPETEER_EXECUTABLE_PATH` esta definido pero no existe en el sistema actual, el servicio intenta usar el navegador por defecto de Puppeteer.

Ejecutar:

```bash
npm start
```

## Endpoints

| Endpoint | Descripcion |
|---|---|
| `/epg.xml` | Devuelve XMLTV desde cache; si no existe, lo genera |
| `/refresh` | Fuerza regeneracion del XML para la combinacion solicitada |
| `/health` | Estado del servicio |
| `/debug-ip` | Devuelve la IP vista por Puppeteer |

### Parametros opcionales para `/epg.xml` y `/refresh`

```text
/epg.xml?pais=mexico&hoursBack=3&hoursAhead=12
/refresh?pais=mexico&hoursBack=3&hoursAhead=12
```

| Parametro | Descripcion |
|---|---|
| `pais` | Region de ClaroVideo (default: `mexico`) |
| `hoursBack` | Horas hacia atras desde ahora |
| `hoursAhead` | Horas hacia adelante desde ahora |

El cache se guarda por combinacion de `pais`, `hoursBack` y `hoursAhead`. El cache por defecto sigue viviendo en `clarovideo_epg.xml`.

Si defines `ADMIN_TOKEN`, los endpoints `/refresh` y `/debug-ip` requieren `x-admin-token: <token>` o `?token=<token>`.

## Variables de entorno

| Variable | Descripcion | Default sugerido |
|---|---|---|
| `PORT` | Puerto del servidor | `3000` |
| `PUPPETEER_EXECUTABLE_PATH` | Ruta explicita de Chromium o Chrome | vacio |
| `DEFAULT_PAIS` | Pais o region | `mexico` |
| `HOURS_BACK` | Horas hacia atras | `3` |
| `HOURS_AHEAD` | Horas hacia adelante | `12` |
| `ADMIN_TOKEN` | Protege `/refresh` y `/debug-ip` cuando esta definido | vacio |
| `SOCKS_PROXY_URL` | Proxy SOCKS completo, por ejemplo `socks5://user:pass@host:port` | vacio |
| `PROXY_HOST` | Host de proxy HTTP | vacio |
| `PROXY_PORT` | Puerto de proxy HTTP | vacio |
| `PROXY_USER` | Usuario de proxy HTTP | vacio |
| `PROXY_PASS` | Password de proxy HTTP | vacio |
| `TZ` | Zona horaria del contenedor o servidor | `America/Monterrey` |

## Docker

```bash
docker build -t clarovideo-epg .

docker run -d \
  --name clarovideo-epg \
  -p 3000:3000 \
  -e PORT=3000 \
  -e PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
  -e DEFAULT_PAIS=mexico \
  -e HOURS_BACK=3 \
  -e HOURS_AHEAD=12 \
  -e TZ=America/Monterrey \
  clarovideo-epg
```

## Deploy

1. Sube el proyecto a GitHub.
2. Conecta el repositorio en tu plataforma de despliegue.
3. Usa el `Dockerfile` del proyecto.
4. Configura las variables de entorno necesarias.
5. Usa `/health` como healthcheck.

## Troubleshooting

**Chromium no inicia**  
Verifica que `PUPPETEER_EXECUTABLE_PATH` apunte a una ruta valida. Si lo dejas vacio, Puppeteer intentara usar su navegador por defecto.

**`/epg.xml` sin cache**  
El cron puede no haber terminado aun o pudo fallar la ultima generacion. Revisa `/health` y los logs.

**Error de red a ClaroVideo**  
Revisa conectividad del servidor, proxy configurado y acceso saliente del navegador.

## Licencia

Uso privado / interno.
