# discordwave 🎙️

Bot de Discord que sintoniza una sola radio: [SUB/WAVE](https://www.getsubwave.com). Desarrollado para **Onda Fuzz** (`radio.cundalf.com.ar`).

**Su única función es estar en el aire:** se sintoniza en un canal de voz, rebroadcastea el stream Icecast de la radio y muestra qué suena. Nada de colas ni playlists de YouTube: radio de verdad, el mismo aire para todos.

---

## La promesa central: 0 consumo = 0 oyentes

> **El stream de la radio SOLO se abre si hay alguien escuchando.**

Esto no es un check que alguien pueda olvidar: es la estructura del código. No hay preload ni buffer de fondo — el único `fetch` al stream está dentro del pipeline de un guild activo. Nada sintonizado ⇒ **0 conexiones TCP a tu radio**.

Y de yapa: **cada guild sintonizando = 1 oyente real** en el contador de Icecast (el bot abre su propia conexión HTTP por server). Si querés que suene en 3 servers, tu panel va a mostrar 3 oyentes.

### Ciclo de vida

```
/sintonizar            → join al canal de voz → recién ahí abre el stream → play
last human left canal  → auto-leave tras 10 min (configurable) → stream cortado
/salir                 → mata pipeline (FFmpeg + fetch) → oyente -1
SIGTERM / docker stop  → shutdown elegante, 0 conexiones a la radio
```

---

## Comandos

| Comando | Qué hace |
|---|---|
| `/sintonizar` | Se une a tu canal de voz y arranca la radio |
| `/salir` | Sale del canal y corta el stream (oyente -1) |
| `/suena` | Qué está sonando ahora (track, artista, DJ, oyentes) |
| `/pedir <canción>` | Le pide a la cabina que pase un tema (con tu nombre: el DJ puede nombrarte en el aire) |
| `/estado` | Uptime, guilds sintonizados, ping, salud del stream |

### El bot según la radio

| Estado de la radio | Presencia del bot |
|---|---|
| Arriba, nadie escuchando | 🟡 "la radio — /sintonizar" |
| Arriba, sonando | 🟢 "escuchando ♪ track — artista" |
| Caída | 🔴 DND: "la radio no está al aire" + los comandos responden "no está al aire" (ni intentan) |

---

## Setup (2 minutos)

### 1. Crear la app en Discord

1. [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**
2. Tab **Bot** → *Reset Token* → copiá el token
3. Tab **General Information** → copiá la **Application ID**
4. Invitalo al server con:
   ```
   https://discord.com/api/oauth2/authorize?client_id=TU_CLIENT_ID&permissions=3165184&scope=bot+applications.commands
   ```
   (permisos: Ver canales · Enviar mensajes · Insertar links · Conectar · Hablar)

### 2. Configuración

```bash
cp .env.example .env
# cargá DISCORD_TOKEN y DISCORD_CLIENT_ID (el resto ya trae defaults sanos)
```

### 3. Arrancar

```bash
docker compose up -d        # construye y levanta
npm run deploy-commands     # registra los slash commands (una sola vez)
```

Para correrlo en otro server/PC sin compilar: hacé `docker pull` y levantá con la misma `.env` (sección de deploy abajo).

---

## Variables de entorno

| Var | Default | Nota |
|---|---|---|
| `DISCORD_TOKEN` | — | token del bot |
| `DISCORD_CLIENT_ID` | — | Application ID |
| `SUBWAVE_BASE_URL` | — | `https://tu-radio...` sin barra final |
| `SUBWAVE_STREAM_PASSWORD` | — | password de oyente (va como HTTP Basic, junto en logs del proxy) |
| `SUBWAVE_STREAM_MOUNT` | `/stream.mp3` | si tu radio está detrás de Cloudflare y hay cortes, probá el origin directo `http://host:7700/stream.mp3` |
| `AUTO_LEAVE_MINUTES` | 10 | se va del canal cuando no queda oyentes humanos; `0` = off |
| `DEFAULT_VOLUME` | 80 | 0-100 |
| `NP_POLL_MS` | 30000 | cada cuánto refresca el "qué suena" para presencia / anuncios (solo con oyentes) |
| `STREAM_RETRIES` | 6 | intentos de reconexión al stream |
| `RATE_LIMIT_TUNE_COOLDOWN_S` | 20 | anti-flapping de `/sintonizar` por guild |
| `RATE_LIMIT_API_MAX_PER_10S` | 5 | máx de `/suena` + `/estado` cada 10s por guild |
| `REQUEST_COOLDOWN_S` | 60 | cooldown de `/pedir` por usuario |
| `REQUEST_GLOBAL_SPACING_S` | 60 | espaciado entre pedidos de todo el bot (= "Seconds between requests" de tu radio) |
| `REQUEST_HOURLY_CAP` | 12 | tope de pedidos por hora del bot (= "Per-listener hourly cap" de tu radio) |
| `GUILD_ID` | — | registra comandos instantáneos en un server (deploy de testing) |

> Ojo con los límites de la radio: son **por IP**, y el bot es una sola IP. Por eso el espaciado y el cap horario de `/pedir` son globales. Regla de oro: radio primero, `.env` para emparejar justo después.

---

## Deploy con imagen precompilada

El pipeline de CI (GitHub Actions) construye y publica la imagen en GHCR en cada push a `main`:

```bash
docker pull ghcr.io/cundalf/discordwave:latest
docker compose up -d   # en el server, con docker-compose.yml apuntando a esa imagen
```

Arquitectura vulnerable: si preferís self-build, `docker compose build` funciona igual — el bot runtime necesita solo ffmpeg + libsodium, y opusscript Garland como fallback de opus.

---

## Arquitectura (en pocas palabras)

```
src/
├─ index.ts           # main: dotenv, señales (SIGTERM), unhandledRejection catcher
├─ boot/boot.ts       # ensambla Discord + RadioManager + presence + sweep
├─ config/            # parseo validado de .env (con redacción de secretos)
├─ api/               # cliente de la API de SUB/WAVE (now-playing, dj, request)
├─ commands/          # slash commands + rate limiters (por guild y por usuario)
├─ radio/
│  ├─ manager.ts      # RAIZ: qué guilds están escuchando (testeado sin Discord)
│  ├─ pipeline.ts     # fetch HTTP → FFmpeg (s16le 48k) → stdout
│  ├─ discord-voice.ts# capa Discord real: joinVoiceChannel + AudioPlayer
│  ├─ stream.ts       # URL + Basic auth (la password JAMÁS va en query)
│  └─ health.ts       # radio viva/caída → presencia + respuestas
└─ format/            # embeds de Discord
```

Diseño hexagonal de manual: `RadioManager` ignora a Discord (opera contra `GuildVoiceAdapter`/`RadioPipeline` testeados con fakes), y la capa real (`DiscordAdapter`) es delgada. Testear sin Discord ni red es la garantía de que las invariantes no se discocharon.

```bash
npm test          # 68 tests (unit + e2e con FFmpeg real contra un stream fake)
npm run smoke     # check contra tu radio real: API + stream con password
```

---

## Debug rápido

```bash
docker compose logs -f            # sigue el bot en vivo
docker compose restart            # rebot suave
docker compose down               # apagado elegante (corta streams a la radio)
```

**Logs de un día productivo:**
```
[radio] stream abierto para guild 1234... (radio listeners +1)
[radio] stream cerrado para guild 1234... (radio listeners -1)
```
