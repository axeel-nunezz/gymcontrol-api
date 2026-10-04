const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ServicioGoogle } = require('../src/google-service');

function configuracion() {
  return {
    google: {
      clientId: 'cliente.apps.googleusercontent.com',
      clientSecret: 'secreto',
      redirectUri: 'https://api.example.com/oauth/google/callback',
      refreshToken: 'refresh-configurado',
      driveFolderId: 'carpeta-1',
      driveFolderName: 'GymControl - Respaldos'
    }
  };
}

test('serializa subidas del mismo HWID, crea una sola vez y conserva appProperties', async () => {
  const servicio = new ServicioGoogle(configuracion(), { logger: { warn() {} } });
  const contenido = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(64, 1)]);
  const md5 = crypto.createHash('md5').update(contenido).digest('hex');
  let existe = false;
  let creaciones = 0;
  let actualizaciones = 0;
  const propiedades = [];

  servicio.drive = {
    files: {
      get: async ({ fileId }) => fileId === 'carpeta-1'
        ? { data: { id: 'carpeta-1', mimeType: 'application/vnd.google-apps.folder', trashed: false,
          capabilities: { canAddChildren: true } } }
        : { data: { id: 'archivo-1', size: String(contenido.length), md5Checksum: md5,
          webViewLink: 'https://drive.google.com/archivo-1', modifiedTime: '2026-10-03T12:00:00.000Z' } },
      list: async () => ({ data: { files: existe ? [{ id: 'archivo-1' }] : [] } }),
      create: async ({ requestBody }) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        creaciones += 1;
        propiedades.push(requestBody.appProperties);
        existe = true;
        return { data: { id: 'archivo-1' } };
      },
      update: async ({ requestBody }) => {
        actualizaciones += 1;
        propiedades.push(requestBody.appProperties);
        return { data: { id: 'archivo-1' } };
      },
      delete: async () => ({})
    },
    permissions: { list: async () => ({ data: { permissions: [] } }) }
  };

  const datos = {
    hwid: 'GYM-1234-A',
    nombreArchivo: 'GymControl_Respaldo_GYM-1234-A.db',
    contenido,
    sha256: crypto.createHash('sha256').update(contenido).digest('hex')
  };
  await Promise.all([servicio.subirRespaldo(datos), servicio.subirRespaldo(datos)]);
  assert.equal(creaciones, 1);
  assert.equal(actualizaciones, 1);
  assert.deepEqual(propiedades, [
    { gymcontrolHwid: 'GYM-1234-A', gymcontrolOrigen: 'GymControl' },
    { gymcontrolHwid: 'GYM-1234-A', gymcontrolOrigen: 'GymControl' }
  ]);
});

test('el correo incluye equipo, fecha, hora y tamaño del respaldo', async () => {
  const servicio = new ServicioGoogle(configuracion(), { logger: { warn() {} } });
  let rawEnviado = '';
  servicio.drive = {
    files: {
      get: async ({ fileId }) => fileId === 'carpeta-1'
        ? { data: { id: 'carpeta-1', mimeType: 'application/vnd.google-apps.folder', trashed: false,
          capabilities: { canAddChildren: true } } }
        : { data: { id: 'archivo-1', size: String(2 * 1024 * 1024),
          webViewLink: 'https://drive.google.com/archivo-1', modifiedTime: '2026-10-03T15:30:00.000Z' } },
      list: async () => ({ data: { files: [{ id: 'archivo-1' }] } })
    },
    permissions: {
      list: async () => ({ data: { permissions: [] } }),
      create: async () => ({ data: { id: 'permiso-1' } })
    }
  };
  servicio.gmail = {
    users: { messages: { send: async ({ requestBody }) => { rawEnviado = requestBody.raw; } } }
  };

  const resultado = await servicio.enviarRespaldoPorCorreo({
    hwid: 'GYM-1234-A',
    nombreArchivo: 'GymControl_Respaldo_GYM-1234-A.db',
    destinatario: 'persona@ejemplo.com'
  });
  const mime = Buffer.from(rawEnviado, 'base64url').toString('utf8');
  const htmlCodificado = mime.split('\r\n\r\n')[1];
  const html = Buffer.from(htmlCodificado, 'base64').toString('utf8');
  assert.match(html, /GYM-1234-A/);
  assert.match(html, /Fecha y hora:/);
  assert.match(html, /Tamaño:<\/strong> 2\.00 MB/);
  assert.equal(resultado.tamanioBytes, 2 * 1024 * 1024);
  assert.equal(resultado.generadoEn, '2026-10-03T15:30:00.000Z');
});
