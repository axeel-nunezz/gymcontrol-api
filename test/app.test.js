const crypto = require('node:crypto');
const { once } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

const { crearAplicacion } = require('../src/app');

const API_KEY = 'api-'.padEnd(48, 'a');
const ADMIN_KEY = 'admin-'.padEnd(48, 'b');

function crearConfiguracion() {
  return {
    apiKey: API_KEY,
    oauthAdminKey: ADMIN_KEY,
    confiarProxy: false,
    maxBackupBytes: 1024 * 1024,
    limites: {
      ventanaMs: 60_000,
      subidasPorVentana: 100,
      correosPorVentana: 100,
      oauthPorVentana: 100
    }
  };
}

function crearDobles() {
  const llamadas = { subidas: [], correos: [] };
  const servicioGoogle = {
    estaConfigurado: () => false,
    subirRespaldo: async (datos) => {
      llamadas.subidas.push(datos);
      return {
        creado: true,
        archivoId: 'archivo-1',
        nombreArchivo: datos.nombreArchivo,
        enlaceDescarga: 'https://drive.google.com/archivo-1',
        tamanioBytes: datos.contenido.length,
        generadoEn: '2026-10-03T12:00:00.000Z'
      };
    },
    enviarRespaldoPorCorreo: async (datos) => {
      llamadas.correos.push(datos);
      return {
        archivoId: 'archivo-1',
        nombreArchivo: datos.nombreArchivo,
        destinatario: datos.destinatario,
        enlaceDescarga: 'https://drive.google.com/archivo-1',
        enviadoEn: '2026-10-03T12:01:00.000Z'
      };
    }
  };
  const servicioOAuth = {
    iniciarAutorizacion: () => ({
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=seguro',
      expiresInSeconds: 600
    }),
    completarAutorizacion: async () => ({ codigoEntrega: 'codigo-unico', expiresInSeconds: 600 }),
    entregarRefreshToken: (codigo) => {
      if (codigo !== 'codigo-unico') throw new Error('Código inesperado');
      return 'refresh-token-secreto';
    }
  };
  return { llamadas, servicioGoogle, servicioOAuth };
}

async function iniciarServidor(t, dobles = crearDobles(), cambiosConfiguracion = {}) {
  const logger = { error() {}, warn() {}, info() {} };
  const base = crearConfiguracion();
  const configuracion = {
    ...base,
    ...cambiosConfiguracion,
    limites: { ...base.limites, ...cambiosConfiguracion.limites }
  };
  const app = crearAplicacion({
    configuracion,
    servicioGoogle: dobles.servicioGoogle,
    servicioOAuth: dobles.servicioOAuth,
    logger
  });
  const servidor = app.listen(0, '127.0.0.1');
  await once(servidor, 'listening');
  t.after(() => new Promise((resolve) => servidor.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${servidor.address().port}`, ...dobles };
}

function crearSQLite() {
  return Buffer.concat([Buffer.from('SQLite format 3\0', 'ascii'), Buffer.alloc(256, 7)]);
}

test('health informa disponibilidad OAuth sin revelar configuración', async (t) => {
  const { baseUrl } = await iniciarServidor(t);
  const respuesta = await fetch(`${baseUrl}/health`);
  const cuerpo = await respuesta.json();
  assert.equal(respuesta.status, 200);
  assert.equal(cuerpo.ok, true);
  assert.equal(cuerpo.googleOAuthConfigurado, false);
  assert.equal(JSON.stringify(cuerpo).includes(API_KEY), false);
});

test('las rutas de aplicación rechazan una API key ausente', async (t) => {
  const { baseUrl } = await iniciarServidor(t);
  const respuesta = await fetch(`${baseUrl}/api/v1/backups/GYM-1234-A`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/x-sqlite3' },
    body: crearSQLite()
  });
  const cuerpo = await respuesta.json();
  assert.equal(respuesta.status, 401);
  assert.equal(cuerpo.error.codigo, 'API_KEY_INVALIDA');
});

test('los intentos con API key inválida consumen el límite de la ruta', async (t) => {
  const { baseUrl } = await iniciarServidor(t, crearDobles(), {
    limites: { subidasPorVentana: 2 }
  });
  const opciones = {
    method: 'PUT',
    headers: { 'Content-Type': 'application/x-sqlite3' },
    body: crearSQLite()
  };
  assert.equal((await fetch(`${baseUrl}/api/v1/backups/GYM-1234-A`, opciones)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/v1/backups/GYM-1234-A`, opciones)).status, 401);
  const limitada = await fetch(`${baseUrl}/api/v1/backups/GYM-1234-A`, opciones);
  assert.equal(limitada.status, 429);
  assert.equal((await limitada.json()).error.codigo, 'LIMITE_SOLICITUDES');
});

test('sube SQLite íntegro y deriva el nombre solamente desde el HWID', async (t) => {
  const dobles = crearDobles();
  const { baseUrl, llamadas } = await iniciarServidor(t, dobles);
  const sqlite = crearSQLite();
  const sha256 = crypto.createHash('sha256').update(sqlite).digest('hex');
  const respuesta = await fetch(`${baseUrl}/api/v1/backups/GYM-1234-A`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/x-sqlite3',
      'X-Content-SHA256': sha256
    },
    body: sqlite
  });
  const cuerpo = await respuesta.json();
  assert.equal(respuesta.status, 201);
  assert.equal(cuerpo.nombreArchivo, 'GymControl_Respaldo_GYM-1234-A.db');
  assert.equal(llamadas.subidas.length, 1);
  assert.equal(llamadas.subidas[0].contenido.equals(sqlite), true);
  assert.equal(llamadas.subidas[0].sha256, sha256);
});

test('rechaza una huella incorrecta antes de invocar Drive', async (t) => {
  const dobles = crearDobles();
  const { baseUrl, llamadas } = await iniciarServidor(t, dobles);
  const respuesta = await fetch(`${baseUrl}/api/v1/backups/GYM-1234-A`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/x-sqlite3',
      'X-Content-SHA256': '0'.repeat(64)
    },
    body: crearSQLite()
  });
  const cuerpo = await respuesta.json();
  assert.equal(respuesta.status, 422);
  assert.equal(cuerpo.error.codigo, 'SHA256_NO_COINCIDE');
  assert.equal(llamadas.subidas.length, 0);
});

test('valida el cuerpo de correo y delega solo destinatario, HWID y nombre estable', async (t) => {
  const dobles = crearDobles();
  const { baseUrl, llamadas } = await iniciarServidor(t, dobles);
  const headers = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

  const invalida = await fetch(`${baseUrl}/api/v1/backups/GYM-1234-A/email`, {
    method: 'POST', headers, body: JSON.stringify({ destinatario: 'persona@ejemplo.com', archivoId: 'forzado' })
  });
  assert.equal(invalida.status, 400);
  assert.equal((await invalida.json()).error.codigo, 'CUERPO_INVALIDO');

  const valida = await fetch(`${baseUrl}/api/v1/backups/GYM-1234-A/email`, {
    method: 'POST', headers, body: JSON.stringify({ destinatario: ' persona@ejemplo.com ' })
  });
  assert.equal(valida.status, 200);
  assert.deepEqual(llamadas.correos[0], {
    hwid: 'GYM-1234-A',
    nombreArchivo: 'GymControl_Respaldo_GYM-1234-A.db',
    destinatario: 'persona@ejemplo.com'
  });
});

test('protege el bootstrap OAuth con la clave administrativa', async (t) => {
  const { baseUrl } = await iniciarServidor(t);
  const sinClave = await fetch(`${baseUrl}/oauth/google/start`, { method: 'POST' });
  assert.equal(sinClave.status, 401);

  const headers = { Authorization: `Bearer ${ADMIN_KEY}` };
  const inicio = await fetch(`${baseUrl}/oauth/google/start`, { method: 'POST', headers });
  assert.equal(inicio.status, 200);
  assert.match((await inicio.json()).authorizationUrl, /^https:\/\/accounts\.google\.com/);

  const canje = await fetch(`${baseUrl}/oauth/google/refresh-token`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ codigo: 'codigo-unico' })
  });
  assert.equal(canje.status, 200);
  assert.equal((await canje.json()).refreshToken, 'refresh-token-secreto');
});
