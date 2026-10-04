# GymControl API

Backend privado de GymControl para centralizar las credenciales de Google. Las instalaciones de escritorio nunca reciben el Client ID, Client Secret ni el refresh token: únicamente conocen la URL del servicio y una clave común de la API.

El servidor guarda o reemplaza `GymControl_Respaldo_<HWID>.db` en Google Drive y puede compartirlo con una dirección y enviar el enlace mediante Gmail. Cada HWID conserva un único nombre estable. Si hay duplicados históricos con el mismo nombre, el servicio intenta eliminarlos después de verificar la nueva subida.

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
| `GYMCONTROL_API_KEY` | Bearer compartido por las instalaciones autorizadas. Mínimo 32 caracteres. |
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

El backend puede iniciar sin `GOOGLE_REFRESH_TOKEN`. Los códigos temporales se guardan en memoria y vencen en diez minutos, por lo que el flujo debe completarse sobre la misma instancia y sin redeploy intermedio.

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

3. Autoriza la cuenta propietaria. El callback muestra un **código de entrega** de un solo uso; nunca imprime el refresh token en los logs.

4. Canjea inmediatamente el código:

   ```powershell
   $cuerpo = @{ codigo = "CODIGO_MOSTRADO_POR_EL_CALLBACK" } | ConvertTo-Json
   $resultado = Invoke-RestMethod -Method Post -Uri "$apiUrl/oauth/google/refresh-token" `
     -Headers $adminHeaders -ContentType "application/json" -Body $cuerpo
   $resultado.refreshToken
   ```

5. Copia el valor a `GOOGLE_REFRESH_TOKEN` en Render y vuelve a desplegar. Con esa variable presente, `/oauth/google/start` queda bloqueado. Para rotar el token, retira temporalmente la variable, despliega y repite este flujo.

`GET /health` confirma el estado sin revelar secretos:

```json
{
  "ok": true,
  "estado": "operativo",
  "googleOAuthConfigurado": true,
  "generadoEn": "2026-10-03T12:00:00.000Z"
}
```

## Contrato de la aplicación de escritorio

Todas las rutas `/api/v1` requieren `Authorization: Bearer <GYMCONTROL_API_KEY>`.

### Subir o reemplazar un respaldo

```http
PUT /api/v1/backups/GYM-1234-A
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

## Desarrollo local

```powershell
Copy-Item .env.example .env
# Completa .env solo en tu equipo; está excluido por Git.
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm start
```

Las pruebas no llaman a Google: usan servicios simulados y verifican autenticación, validaciones, integridad y el contrato HTTP.

## Render y Docker

El `Dockerfile` usa Node 24, instala dependencias desde `pnpm-lock.yaml` y ejecuta el proceso con el usuario sin privilegios `node`. En Render selecciona el runtime Docker y usa `/health` como Health Check Path. El disco local no guarda respaldos. Los códigos OAuth temporales sí se pierden si la instancia reinicia durante el bootstrap.

## Seguridad operativa

- Rota cualquier credencial que haya sido publicada en una conversación, captura o commit.
- Mantén `OAUTH_ADMIN_KEY` fuera de los equipos cliente.
- La clave común `GYMCONTROL_API_KEY` evita accesos casuales, pero cualquier instalación puede extraerla de su configuración local. Para un despliegue de mayor riesgo, el siguiente paso es emitir credenciales revocables por instalación.
- Los errores y logs nunca incluyen tokens, claves ni cuerpos de bases de datos.
