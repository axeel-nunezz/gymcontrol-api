const test = require('node:test');
const assert = require('node:assert/strict');

const { ErrorConfiguracion, cargarConfiguracion } = require('../src/config');

function entornoValido() {
  return {
    GOOGLE_CLIENT_ID: 'cliente.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'secreto-google',
    GOOGLE_REDIRECT_URI: 'https://gymcontrol-api.onrender.com/oauth/google/callback',
    GYMCONTROL_API_KEY: 'a'.repeat(48),
    OAUTH_ADMIN_KEY: 'b'.repeat(48),
    OAUTH_STATE_SECRET: 'c'.repeat(48)
  };
}

test('permite iniciar sin refresh token para realizar el bootstrap', () => {
  const configuracion = cargarConfiguracion(entornoValido());
  assert.equal(configuracion.google.refreshToken, '');
  assert.equal(configuracion.google.driveFolderName, 'GymControl - Respaldos');
  assert.equal(configuracion.maxBackupBytes, 64 * 1024 * 1024);
});

test('rechaza secretos cortos sin incluir su valor en el error', () => {
  const env = { ...entornoValido(), GYMCONTROL_API_KEY: 'corta' };
  assert.throws(() => cargarConfiguracion(env), (error) => {
    assert.equal(error instanceof ErrorConfiguracion, true);
    assert.match(error.message, /GYMCONTROL_API_KEY/);
    assert.equal(error.message.includes('corta'), false);
    return true;
  });
});

test('valida límites de tamaño configurables', () => {
  assert.throws(() => cargarConfiguracion({ ...entornoValido(), MAX_BACKUP_MB: '300' }),
    /MAX_BACKUP_MB/);
  assert.equal(cargarConfiguracion({ ...entornoValido(), MAX_BACKUP_MB: '20' }).maxBackupBytes,
    20 * 1024 * 1024);
});

test('exige HTTPS en el redirect salvo durante desarrollo local', () => {
  assert.throws(() => cargarConfiguracion({
    ...entornoValido(),
    GOOGLE_REDIRECT_URI: 'http://api.example.com/oauth/google/callback'
  }), /HTTPS/);

  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const configuracion = cargarConfiguracion({
      ...entornoValido(),
      GOOGLE_REDIRECT_URI: `http://${host}:3000/oauth/google/callback`
    });
    assert.match(configuracion.google.redirectUri, /^http:/);
  }
});

test('limpia comillas y formato markdown accidental en redirect URI', () => {
  const mdUri = '[https://gymcontrol-api.onrender.com/oauth/google/callback](https://gymcontrol-api.onrender.com/oauth/google/callback)';
  const conf1 = cargarConfiguracion({ ...entornoValido(), GOOGLE_REDIRECT_URI: mdUri });
  assert.equal(conf1.google.redirectUri, 'https://gymcontrol-api.onrender.com/oauth/google/callback');

  const quotedUri = '"https://gymcontrol-api.onrender.com/oauth/google/callback"';
  const conf2 = cargarConfiguracion({ ...entornoValido(), GOOGLE_REDIRECT_URI: quotedUri });
  assert.equal(conf2.google.redirectUri, 'https://gymcontrol-api.onrender.com/oauth/google/callback');
});
