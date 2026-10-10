# GymControl API

Backend privado de GymControl para centralizar las credenciales de Google. Las instalaciones de escritorio nunca reciben el Client ID, Client Secret ni el refresh token: el programa genera una clave aleatoria local y la registra automáticamente al primer uso cloud.

El servidor guarda o reemplaza `GymControl_Respaldo_<HWID>.db` en Google Drive y puede compartirlo con una dirección y enviar el enlace mediante Gmail. Cada instalación conserva su propio archivo mediante la huella de su clave, aunque otra instalación tenga el mismo HWID corto. Si hay duplicados históricos de esa instalación, el servicio intenta eliminarlos después de verificar la nueva subida.

## Requisitos

- Node.js 24.
- Drive API y Gmail API habilitadas en Google Cloud.
- Un cliente OAuth 2.0 de tipo **Aplicación web** con `https://<servicio>.onrender.com/oauth/google/callback` como URI de redirección.
- Una cuenta de Google propietaria de los respaldos.

Las credenciales web configuradas en Render pueden ser distintas de cualquier credencial OAuth usada anteriormente por la aplicación Java.

## Variables de entorno de Render

Obligatorias desde el primer despliegue:

| Variable | Uso |
|---|---|
| `GOOGLE_CLIENT_ID` | Client ID del cliente OAuth web del backend. |
| `GOOGLE_CLIENT_SECRET` | Client Secret de ese mismo cliente. |
| `GOOGLE_REDIRECT_URI` | Callback HTTPS exacto registrado en Google. |
| `OAUTH_ADMIN_KEY` | Bearer reservado para el bootstrap OAuth. Mínimo 32 caracteres. |
| `OAUTH_STATE_SECRET` | Firma el parámetro OAuth `state`. Mínimo 32 caracteres. |

Después del bootstrap también es necesaria para respaldar:

| Variable | Uso |
|---|---|
| `GOOGLE_REFRESH_TOKEN` | Token de la cuenta dueña de Drive y Gmail. Nunca se copia a los equipos. |

Opcionales:

| Variable | Predeterminado | Uso |
|---|---:|---|
| `GOOGLE_DRIVE_FOLDER_ID` | vacío | Usa y valida una carpeta a la que **este cliente OAuth** ya tenga acceso. |
| `GOOGLE_DRIVE_FOLDER_NAME` | `GymControl - Respaldos` | Nombre de la carpeta creada o buscada si no se define un ID. |
| `MAX_BACKUP_MB` | `64` | Tamaño máximo de cada SQLite, entre 1 y 256 MB. |
| `BACKUP_RATE_LIMIT` | `30` | Subidas máximas por IP y hora. |
| `EMAIL_RATE_LIMIT` | `10` | Correos máximos por IP y hora. |
| `OAUTH_RATE_LIMIT` | `20` | Operaciones OAuth máximas por IP y hora. |

En la primera instalación, deja `GOOGLE_DRIVE_FOLDER_ID` vacío para que el backend cree su propia carpeta. El scope limitado `drive.file` no concede acceso automático a una carpeta antigua solo porque pertenezca a la misma cuenta: una carpeta explícita funciona únicamente si esta aplicación OAuth ya la creó u obtuvo acceso a ella mediante Google Picker. Las credenciales web nuevas no heredan el acceso por archivo de otro cliente OAuth.

Para generar cada secreto en PowerShell moderno:

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
```

Genera tres valores independientes. No reutilices el Client Secret ni guardes valores reales en `.env`, Git o el JAR de escritorio.

## Bootstrap OAuth sin exponer el refresh token en logs

El backend puede iniciar sin `GOOGLE_REFRESH_TOKEN`. Antes de autorizar, deja esa variable ausente o vacía en Render; un texto de ejemplo también bloquea el inicio del flujo. El código de canje alternativo se guarda en memoria durante 30 minutos, por lo que debe usarse antes de reiniciar la instancia.

1. Define en tu consola la URL y la clave administrativa que ya cargaste en Render:

   ```powershell
   $apiUrl = "https://tu-servicio.onrender.com"
   $adminHeaders = @{ Authorization = "Bearer $env:OAUTH_ADMIN_KEY" }
   ```

2. Solicita una URL de autorización:

   ```powershell
   $inicio = Invoke-RestMethod -Method Post -Uri "$apiUrl/oauth/google/start" -Headers $adminHeaders
   Start-Process $inicio.authorizationUrl
   ```

3. Autoriza la cuenta propietaria. El callback muestra el **refresh token** para copiar directamente a Render y un código de entrega alternativo. No compartas el token ni una captura de esa página.

4. Sólo si no pudiste copiar el token del callback, canjea el código alternativo antes de que venza:

   ```powershell
   $cuerpo = @{ codigo = "CODIGO_MOSTRADO_POR_EL_CALLBACK" } | ConvertTo-Json
   $resultado = Invoke-RestMethod -Method Post -Uri "$apiUrl/oauth/google/refresh-token" `
     -Headers $adminHeaders -ContentType "application/json" -Body $cuerpo
   $resultado.refreshToken
   ```

5. Guarda el token real como `GOOGLE_REFRESH_TOKEN` en Render y vuelve a desplegar. Con esa variable presente, `/oauth/google/start` queda bloqueado. Para rotar el token, retira temporalmente la variable, despliega y repite este flujo.

`GET /health` informa si el proceso tiene un valor no vacío de refresh token, sin revelar secretos. **No valida ese valor contra Google**: un texto de prueba también produce `googleOAuthConfigurado: true`.

```json
{
  "ok": true,
  "estado": "operativo",
  "googleOAuthConfigurado": true,
  "generadoEn": "2026-10-03T12:00:00.000Z"
}
```

## Contrato de la aplicación de escritorio

El instalador es único: en el primer arranque, el cliente crea `%LOCALAPPDATA%\GymControl\gymcontrol-cloud.json` con la URL pública y una clave aleatoria propia. Al usar Drive o Gmail por primera vez, registra esa clave mediante `POST /api/v1/clients/<HWID>/register`; la API guarda únicamente su huella SHA-256 en Drive. El registro puede realizarse durante los 15 días de prueba. Si no hay conexión, el programa local sigue funcionando y el registro se reintenta en la siguiente operación cloud. No se configura ninguna clave por equipo en Render ni se incluye una clave compartida en el instalador.

Las demás rutas `/api/v1` requieren `Authorization: Bearer <clave local>` y `X-HWID: <HWID>`. La API comprueba la clave contra su registro persistente y separa los archivos por la huella de esa clave, incluso si dos equipos coinciden en el HWID corto. Falla de forma cerrada cuando Google no está disponible. El registro abierto tiene límite de solicitudes, pero no impide que alguien instale múltiples clientes y consuma recursos cloud; hay que vigilar sus cuotas. Si se borra el archivo local, la nueva instalación obtiene otra identidad cloud y no podrá acceder a sus respaldos anteriores sin ayuda de soporte.

### Reportes mensuales de caja

El escritorio genera `ReporteCaja_YYYY-MM_<HWID>_PARCIAL.xlsx` para el mes en curso y
`ReporteCaja_YYYY-MM_<HWID>_FINAL.xlsx` para un mes cerrado. Guarda una copia en
`%LOCALAPPDATA%\GymControl\reportes\caja\` y envía el XLSX al backend:

```http
PUT /api/v1/reports/cash/GYM-1234-A/2026-09/FINAL
X-HWID: GYM-1234-A
Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
X-Content-SHA256: <64 caracteres hexadecimales>
Authorization: Bearer <clave>

<bytes del XLSX>
```

El backend lo guarda en la subcarpeta `Reportes_Caja` de la carpeta de respaldos.
Al consolidar un período elimina su parcial y conserva como máximo los doce meses
consolidados consecutivos más recientes por equipo. Los errores de borrado se registran
sin cancelar la subida; la respuesta incluye `fallosLimpieza`. Un reporte histórico
fuera de esa ventana permanece local, y `conservadoEnDrive` informa `false`.

Para adjuntarlo por Gmail sin guardar credenciales de Google en el equipo:

```http
POST /api/v1/reports/cash/GYM-1234-A/2026-09/FINAL/email
X-HWID: GYM-1234-A
Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
X-Content-SHA256: <64 caracteres hexadecimales>
X-Recipient-Email: persona@ejemplo.com
Authorization: Bearer <clave>

<bytes del XLSX>
```

El adjunto para Gmail tiene un límite de 18 MiB. Ambas rutas derivan el nombre del
HWID, período y estado validados; no aceptan nombres arbitrarios del cliente.

### Subir o reemplazar un respaldo

```http
PUT /api/v1/backups/GYM-1234-A
X-HWID: GYM-1234-A
Content-Type: application/x-sqlite3
X-Content-SHA256: <64 caracteres hexadecimales>
Authorization: Bearer <clave>

<bytes de la base SQLite>
```

El servidor valida el HWID, el encabezado SQLite y la huella antes de contactar a Drive. El nombre se deriva del HWID. La subida queda serializada por equipo para que dos peticiones simultáneas no creen archivos duplicados.

Respuesta `201` al crear o `200` al reemplazar:

```json
{
  "ok": true,
  "creado": false,
  "archivoId": "id-de-drive",
  "nombreArchivo": "GymControl_Respaldo_GYM-1234-A.db",
  "enlaceDescarga": "https://drive.google.com/...",
  "tamanioBytes": 123456,
  "sha256": "...",
  "duplicadosEliminados": 0,
  "generadoEn": "2026-10-03T12:00:00.000Z"
}
```

### Compartir y enviar por correo

```http
POST /api/v1/backups/GYM-1234-A/email
Content-Type: application/json
Authorization: Bearer <clave>

{"destinatario":"persona@ejemplo.com"}
```

La ruta busca el respaldo estable del HWID, concede acceso de lectura si aún no existe y envía un correo con enlace, fecha, hora y tamaño del respaldo.

### Enviar un archivo adjunto desde el escritorio

```http
POST /api/v1/backups/GYM-1234-A/email-attachment
Authorization: Bearer <clave>
Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
X-Recipient-Email: persona@ejemplo.com
X-Content-SHA256: <64 caracteres hexadecimales>
X-Report-Accesses: false

<bytes del XLSX>
```

Para la base completa, usa `Content-Type: application/x-sqlite3` y envía el snapshot SQLite consistente. La ruta admite hasta 18 MiB por adjunto, comprueba la firma y SHA-256, deriva el nombre desde el HWID y envía el archivo directamente por Gmail. El Excel no se guarda en Drive. `X-Report-Accesses` indica si el reporte incluye la hoja opcional; para SQLite se ignora. El endpoint de enlace anterior y la sincronización automática con Drive siguen disponibles.

## Carpeta lista para despliegue

Esta raíz contiene únicamente el código y la configuración necesarios para construir
el backend en Render: `Dockerfile`, `package.json`, `pnpm-lock.yaml`, `server.js` y `src/`.
La carpeta `gymcontrol-api/` conserva el repositorio de desarrollo y sus pruebas,
pero está excluida por `.gitignore` y `.dockerignore`. No la agregues al repositorio
exterior ni configures Render para construir desde ella.

Para comprobar sintaxis localmente, ejecuta `node --check server.js` y
`node --check src/app.js`. Las pruebas automatizadas permanecen en el repositorio
interior y no se incluyen en esta copia de producción.

## Render y Docker

El `Dockerfile` usa Node 24, instala dependencias desde `pnpm-lock.yaml` y ejecuta el proceso con el usuario sin privilegios `node`. En Render selecciona el runtime Docker, la raíz de este repositorio como Root Directory, `./Dockerfile` como Dockerfile Path y `/health` como Health Check Path. El disco local no guarda respaldos. Los códigos OAuth temporales sí se pierden si la instancia reinicia durante el bootstrap.

## Seguridad operativa

- Rota cualquier credencial que haya sido publicada en una conversación, captura o commit.
- Mantén `OAUTH_ADMIN_KEY` fuera de los equipos cliente.
- Cada instalación genera su clave fuera del ejecutable. Para revocarla, elimina el registro `GymControl_Cliente_<SHA256 de la clave>.json` en la carpeta de Drive administrada por la API; después restablece el archivo local de esa instalación mediante soporte.
- Los errores y logs nunca incluyen tokens, claves ni cuerpos de bases de datos.
