const test = require('node:test');
const assert = require('node:assert/strict');

const { ServicioOAuthBootstrap } = require('../src/oauth-service');

function configuracion(refreshToken = '') {
  return {
    oauthStateSecret: 'estado-'.padEnd(48, 's'),
    oauthVigenciaSegundos: 600,
    google: {
      clientId: 'cliente.apps.googleusercontent.com',
      clientSecret: 'secreto',
      redirectUri: 'https://api.example.com/oauth/google/callback',
      refreshToken
    }
  };
}

test('state es de un solo uso y el refresh token solo se entrega una vez', async () => {
  let tokenAplicado = '';
  const servicio = new ServicioOAuthBootstrap(configuracion(), {
    alObtenerRefreshToken: (token) => { tokenAplicado = token; }
  });
  servicio.cliente.getToken = async () => ({ tokens: { refresh_token: 'refresh-seguro' } });

  const inicio = servicio.iniciarAutorizacion();
  const state = new URL(inicio.authorizationUrl).searchParams.get('state');
  const completado = await servicio.completarAutorizacion({ codigo: 'codigo-google', state });
  assert.equal(tokenAplicado, 'refresh-seguro');
  assert.equal(servicio.entregarRefreshToken(completado.codigoEntrega), 'refresh-seguro');
  assert.throws(() => servicio.entregarRefreshToken(completado.codigoEntrega), /inválido|venció|utilizado/);
  assert.throws(() => servicio.iniciarAutorizacion(), (error) => error.codigo === 'OAUTH_YA_CONFIGURADO');
});

test('bloquea un nuevo bootstrap cuando ya existe GOOGLE_REFRESH_TOKEN', () => {
  const servicio = new ServicioOAuthBootstrap(configuracion('ya-configurado'));
  assert.throws(() => servicio.iniciarAutorizacion(), (error) => error.codigo === 'OAUTH_YA_CONFIGURADO');
});
