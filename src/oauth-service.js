const crypto = require('node:crypto');
const { google } = require('googleapis');
const { ErrorHttp } = require('./errors');
const { compararSeguro } = require('./security');

const SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/gmail.send'
]);

class ServicioOAuthBootstrap {
  constructor(configuracion, { alObtenerRefreshToken = () => {}, reloj = () => Date.now() } = {}) {
    this.configuracion = configuracion;
    this.alObtenerRefreshToken = alObtenerRefreshToken;
    this.reloj = reloj;
    this.oauthYaConfigurado = Boolean(configuracion.google.refreshToken);
    this.noncesPendientes = new Map();
    this.tokensParaEntregar = new Map();
    this.cliente = new google.auth.OAuth2(
      configuracion.google.clientId,
      configuracion.google.clientSecret,
      configuracion.google.redirectUri
    );
  }

  iniciarAutorizacion() {
    if (this.oauthYaConfigurado) {
      throw new ErrorHttp(409, 'OAUTH_YA_CONFIGURADO',
        'Google OAuth ya está configurado. Para rotarlo, retira temporalmente GOOGLE_REFRESH_TOKEN y vuelve a desplegar.');
    }
    this.#depurarExpirados();
    const nonce = crypto.randomBytes(24).toString('base64url');
    const expiraEn = Math.floor(this.reloj() / 1000) + this.configuracion.oauthVigenciaSegundos;
    const carga = Buffer.from(JSON.stringify({ nonce, expiraEn }), 'utf8').toString('base64url');
    const state = `${carga}.${this.#firmar(carga)}`;
    this.noncesPendientes.set(nonce, expiraEn);
    return {
      authorizationUrl: this.cliente.generateAuthUrl({
        access_type: 'offline', prompt: 'consent', include_granted_scopes: true,
        scope: SCOPES, state
      }),
      expiresInSeconds: this.configuracion.oauthVigenciaSegundos
    };
  }

  async completarAutorizacion({ codigo, state }) {
    this.#consumirState(state);
    if (typeof codigo !== 'string' || !codigo.trim()) {
      throw new ErrorHttp(400, 'OAUTH_CODIGO_AUSENTE', 'Google no devolvió un código de autorización.');
    }
    let tokens;
    try {
      ({ tokens } = await this.cliente.getToken(codigo));
    } catch (error) {
      throw new ErrorHttp(502, 'OAUTH_CANJE_FALLIDO',
        'Google no pudo completar la autorización. Inicia el proceso nuevamente.', error);
    }
    const refreshToken = tokens?.refresh_token;
    if (!refreshToken) {
      throw new ErrorHttp(409, 'OAUTH_REFRESH_TOKEN_AUSENTE',
        'Google no entregó un refresh token. Revoca el acceso previo de GymControl y vuelve a autorizar.');
    }
    this.alObtenerRefreshToken(refreshToken);
    this.oauthYaConfigurado = true;
    const codigoEntrega = crypto.randomBytes(32).toString('base64url');
    const expiraEn = Math.floor(this.reloj() / 1000) + this.configuracion.oauthVigenciaSegundos;
    this.tokensParaEntregar.set(codigoEntrega, { refreshToken, expiraEn });
    return { codigoEntrega, expiresInSeconds: this.configuracion.oauthVigenciaSegundos };
  }

  entregarRefreshToken(codigoEntrega) {
    this.#depurarExpirados();
    if (typeof codigoEntrega !== 'string' || !codigoEntrega) {
      throw new ErrorHttp(400, 'CODIGO_ENTREGA_AUSENTE', 'Debes indicar el código de entrega.');
    }
    const registro = this.tokensParaEntregar.get(codigoEntrega);
    this.tokensParaEntregar.delete(codigoEntrega);
    if (!registro) {
      throw new ErrorHttp(400, 'CODIGO_ENTREGA_INVALIDO',
        'El código de entrega es inválido, venció o ya fue utilizado.');
    }
    return registro.refreshToken;
  }

  #consumirState(state) {
    this.#depurarExpirados();
    if (typeof state !== 'string' || state.length > 1000) {
      throw new ErrorHttp(400, 'OAUTH_STATE_INVALIDO', 'La solicitud OAuth no es válida o venció.');
    }
    const partes = state.split('.');
    if (partes.length !== 2 || !compararSeguro(partes[1], this.#firmar(partes[0]))) {
      throw new ErrorHttp(400, 'OAUTH_STATE_INVALIDO', 'La solicitud OAuth no es válida o venció.');
    }
    let carga;
    try {
      carga = JSON.parse(Buffer.from(partes[0], 'base64url').toString('utf8'));
    } catch {
      throw new ErrorHttp(400, 'OAUTH_STATE_INVALIDO', 'La solicitud OAuth no es válida o venció.');
    }
    const expiraRegistrado = this.noncesPendientes.get(carga.nonce);
    this.noncesPendientes.delete(carga.nonce);
    const ahora = Math.floor(this.reloj() / 1000);
    if (!expiraRegistrado || carga.expiraEn !== expiraRegistrado || carga.expiraEn < ahora) {
      throw new ErrorHttp(400, 'OAUTH_STATE_INVALIDO', 'La solicitud OAuth no es válida o venció.');
    }
  }

  #firmar(carga) {
    return crypto.createHmac('sha256', this.configuracion.oauthStateSecret)
      .update(carga).digest('base64url');
  }

  #depurarExpirados() {
    const ahora = Math.floor(this.reloj() / 1000);
    for (const [nonce, expiraEn] of this.noncesPendientes) {
      if (expiraEn < ahora) this.noncesPendientes.delete(nonce);
    }
    for (const [codigo, registro] of this.tokensParaEntregar) {
      if (registro.expiraEn < ahora) this.tokensParaEntregar.delete(codigo);
    }
  }
}

module.exports = { SCOPES, ServicioOAuthBootstrap };
