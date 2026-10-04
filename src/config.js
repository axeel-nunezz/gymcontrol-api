const TAMANIO_MINIMO_SECRETO = 32;

class ErrorConfiguracion extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = 'ErrorConfiguracion';
  }
}

function texto(env, nombre, { requerido = false, valorPredeterminado = '' } = {}) {
  const valor = typeof env[nombre] === 'string' ? env[nombre].trim() : '';
  if (!valor && requerido) {
    throw new ErrorConfiguracion(`Falta la variable de entorno obligatoria ${nombre}.`);
  }
  return valor || valorPredeterminado;
}

function entero(env, nombre, valorPredeterminado, minimo, maximo) {
  const valorCrudo = texto(env, nombre);
  if (!valorCrudo) return valorPredeterminado;
  const valor = /^\d+$/.test(valorCrudo) ? Number.parseInt(valorCrudo, 10) : Number.NaN;
  if (!Number.isSafeInteger(valor) || valor < minimo || valor > maximo) {
    throw new ErrorConfiguracion(`${nombre} debe ser un número entero entre ${minimo} y ${maximo}.`);
  }
  return valor;
}

function secreto(env, nombre) {
  const valor = texto(env, nombre, { requerido: true });
  if (valor.length < TAMANIO_MINIMO_SECRETO) {
    throw new ErrorConfiguracion(`${nombre} debe contener al menos ${TAMANIO_MINIMO_SECRETO} caracteres.`);
  }
  return valor;
}

function urlValida(valor, nombre) {
  let limpio = (valor || '').trim();
  if ((limpio.startsWith('"') && limpio.endsWith('"')) || (limpio.startsWith("'") && limpio.endsWith("'"))) {
    limpio = limpio.slice(1, -1).trim();
  }
  const matchMd = limpio.match(/\]\((https?:\/\/[^\s)]+)\)/);
  if (matchMd) {
    limpio = matchMd[1].trim();
  } else if (limpio.startsWith('[') && limpio.endsWith(']')) {
    limpio = limpio.slice(1, -1).trim();
  }

  try {
    const url = new URL(limpio);
    const hostLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && hostLocal)) throw new Error();
  } catch {
    throw new ErrorConfiguracion(
      `${nombre} debe usar HTTPS; HTTP solo está permitido para localhost.`
    );
  }
  return limpio;
}

/**
 * Lee y valida toda la configuración del proceso sin exponer secretos.
 * GOOGLE_REFRESH_TOKEN es opcional para permitir el bootstrap OAuth inicial.
 */
function cargarConfiguracion(env = process.env) {
  const googleRedirectUri = urlValida(
    texto(env, 'GOOGLE_REDIRECT_URI', { requerido: true }),
    'GOOGLE_REDIRECT_URI'
  );

  const apiKey = secreto(env, 'GYMCONTROL_API_KEY');
  const oauthAdminKey = secreto(env, 'OAUTH_ADMIN_KEY');
  const oauthStateSecret = secreto(env, 'OAUTH_STATE_SECRET');
  if (new Set([apiKey, oauthAdminKey, oauthStateSecret]).size !== 3) {
    throw new ErrorConfiguracion(
      'GYMCONTROL_API_KEY, OAUTH_ADMIN_KEY y OAUTH_STATE_SECRET deben ser valores diferentes.'
    );
  }

  return Object.freeze({
    entorno: texto(env, 'NODE_ENV', { valorPredeterminado: 'production' }),
    puerto: entero(env, 'PORT', 3000, 1, 65_535),
    confiarProxy: texto(env, 'TRUST_PROXY', { valorPredeterminado: '1' }) !== '0',
    apiKey,
    oauthAdminKey,
    oauthStateSecret,
    google: Object.freeze({
      clientId: texto(env, 'GOOGLE_CLIENT_ID', { requerido: true }),
      clientSecret: texto(env, 'GOOGLE_CLIENT_SECRET', { requerido: true }),
      redirectUri: googleRedirectUri,
      refreshToken: texto(env, 'GOOGLE_REFRESH_TOKEN'),
      driveFolderId: texto(env, 'GOOGLE_DRIVE_FOLDER_ID'),
      driveFolderName: texto(env, 'GOOGLE_DRIVE_FOLDER_NAME', {
        valorPredeterminado: 'GymControl - Respaldos'
      })
    }),
    maxBackupBytes: entero(env, 'MAX_BACKUP_MB', 64, 1, 256) * 1024 * 1024,
    oauthVigenciaSegundos: 600,
    limites: Object.freeze({
      ventanaMs: 60 * 60 * 1000,
      subidasPorVentana: entero(env, 'BACKUP_RATE_LIMIT', 30, 1, 500),
      correosPorVentana: entero(env, 'EMAIL_RATE_LIMIT', 10, 1, 200),
      oauthPorVentana: entero(env, 'OAUTH_RATE_LIMIT', 20, 1, 200)
    })
  });
}

module.exports = { ErrorConfiguracion, cargarConfiguracion };
