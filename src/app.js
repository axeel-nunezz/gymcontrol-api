const crypto = require('node:crypto');

const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const { ErrorHttp } = require('./errors');
const { autenticarBearer, compararSeguro, validarCorreo, validarHwid } = require('./security');

const CABECERA_SQLITE = Buffer.from('SQLite format 3\0', 'ascii');

function crearLimitador(configuracion, limite) {
  return rateLimit({
    windowMs: configuracion.limites.ventanaMs,
    limit: limite,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new ErrorHttp(429, 'LIMITE_SOLICITUDES',
      'Se alcanzó el límite temporal de solicitudes. Intenta nuevamente más tarde.'))
  });
}

function respuestaHtml(titulo, mensaje, codigoEntrega = '') {
  const codigo = codigoEntrega
    ? `<p>Código de entrega de un solo uso:</p><pre>${codigoEntrega}</pre>`
    : '';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${titulo}</title></head>` +
    `<body><main><h1>${titulo}</h1><p>${mensaje}</p>${codigo}</main></body></html>`;
}

function crearAplicacion({ configuracion, servicioGoogle, servicioOAuth, logger = console }) {
  const app = express();
  app.disable('x-powered-by');
  if (configuracion.confiarProxy) app.set('trust proxy', 1);
  app.use(helmet());
  app.use((req, res, next) => {
    req.idSolicitud = crypto.randomUUID();
    res.setHeader('X-Request-Id', req.idSolicitud);
    next();
  });

  const autenticarApi = autenticarBearer(configuracion.apiKey, 'API_KEY_INVALIDA');
  const autenticarAdmin = autenticarBearer(configuracion.oauthAdminKey, 'ADMIN_KEY_INVALIDA');
  const limitarSubidas = crearLimitador(configuracion, configuracion.limites.subidasPorVentana);
  const limitarCorreos = crearLimitador(configuracion, configuracion.limites.correosPorVentana);
  const limitarOAuth = crearLimitador(configuracion, configuracion.limites.oauthPorVentana);

  app.get('/', (_req, res) => {
    res.json({ ok: true, servicio: 'GymControl API' });
  });

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      estado: 'operativo',
      googleOAuthConfigurado: servicioGoogle.estaConfigurado(),
      generadoEn: new Date().toISOString()
    });
  });

  app.post('/oauth/google/start', limitarOAuth, autenticarAdmin, (_req, res, next) => {
    try {
      const resultado = servicioOAuth.iniciarAutorizacion();
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, ...resultado });
    } catch (error) {
      next(error);
    }
  });

  app.get('/oauth/google/callback', limitarOAuth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (typeof req.query.error === 'string') {
      res.status(400).type('html').send(respuestaHtml('Autorización cancelada',
        'Google no concedió los permisos solicitados. Puedes cerrar esta ventana.'));
      return;
    }
    try {
      const resultado = await servicioOAuth.completarAutorizacion({
        codigo: req.query.code,
        state: req.query.state
      });
      res.type('html').send(respuestaHtml('Autorización completada',
        `Copia este código y canjéalo dentro de ${resultado.expiresInSeconds} segundos.`,
        resultado.codigoEntrega));
    } catch (error) {
      const estado = error instanceof ErrorHttp ? error.estado : 500;
      const mensaje = error instanceof ErrorHttp
        ? error.message
        : 'No fue posible completar la autorización con Google.';
      if (estado >= 500) {
        const codigo = error instanceof ErrorHttp ? error.codigo : 'ERROR_INTERNO';
        logger.error(`[GymControl API] ${req.idSolicitud} ${codigo} (${estado}).`);
      }
      res.status(estado).type('html').send(respuestaHtml('Error de autorización', mensaje));
    }
  });

  app.post('/oauth/google/refresh-token', limitarOAuth, autenticarAdmin,
    express.json({ limit: '16kb', strict: true }), (req, res, next) => {
      try {
        if (!req.body || Array.isArray(req.body) || typeof req.body !== 'object' ||
            Object.keys(req.body).some((clave) => clave !== 'codigo')) {
          throw new ErrorHttp(400, 'CUERPO_INVALIDO',
            'El cuerpo debe contener únicamente el campo codigo.');
        }
        const refreshToken = servicioOAuth.entregarRefreshToken(req.body?.codigo);
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ok: true, refreshToken });
      } catch (error) {
        next(error);
      }
    });

  app.put('/api/v1/backups/:hwid', limitarSubidas, autenticarApi,
    express.raw({ type: ['application/x-sqlite3', 'application/vnd.sqlite3', 'application/octet-stream'],
      limit: configuracion.maxBackupBytes }), async (req, res, next) => {
      try {
        const { hwid } = req.params;
        if (!validarHwid(hwid)) {
          throw new ErrorHttp(400, 'HWID_INVALIDO', 'El identificador del equipo no tiene un formato válido.');
        }
        if (!req.is(['application/x-sqlite3', 'application/vnd.sqlite3', 'application/octet-stream'])) {
          throw new ErrorHttp(415, 'TIPO_CONTENIDO_INVALIDO',
            'El respaldo debe enviarse como application/x-sqlite3.');
        }
        if (!Buffer.isBuffer(req.body) || req.body.length <= CABECERA_SQLITE.length ||
            !req.body.subarray(0, CABECERA_SQLITE.length).equals(CABECERA_SQLITE)) {
          throw new ErrorHttp(422, 'SQLITE_INVALIDO', 'El archivo enviado no es una base de datos SQLite válida.');
        }
        const sha256Recibido = req.get('X-Content-SHA256');
        if (!sha256Recibido || !/^[a-f0-9]{64}$/i.test(sha256Recibido)) {
          throw new ErrorHttp(400, 'SHA256_AUSENTE', 'Debes enviar una huella SHA-256 válida.');
        }
        const sha256Calculado = crypto.createHash('sha256').update(req.body).digest('hex');
        if (!compararSeguro(sha256Recibido.toLowerCase(), sha256Calculado)) {
          throw new ErrorHttp(422, 'SHA256_NO_COINCIDE',
            'La huella SHA-256 no coincide con el archivo recibido.');
        }

        const nombreArchivo = `GymControl_Respaldo_${hwid}.db`;
        const resultado = await servicioGoogle.subirRespaldo({
          hwid, nombreArchivo, contenido: req.body, sha256: sha256Calculado
        });
        res.status(resultado.creado ? 201 : 200).json({ ok: true, ...resultado });
      } catch (error) {
        next(error);
      }
    });

  app.post('/api/v1/backups/:hwid/email', limitarCorreos, autenticarApi,
    express.json({ limit: '16kb', strict: true }), async (req, res, next) => {
      try {
        const { hwid } = req.params;
        if (!validarHwid(hwid)) {
          throw new ErrorHttp(400, 'HWID_INVALIDO', 'El identificador del equipo no tiene un formato válido.');
        }
        if (!req.body || Array.isArray(req.body) || typeof req.body !== 'object' ||
            Object.keys(req.body).some((clave) => clave !== 'destinatario')) {
          throw new ErrorHttp(400, 'CUERPO_INVALIDO',
            'El cuerpo debe contener únicamente el campo destinatario.');
        }
        const destinatario = typeof req.body?.destinatario === 'string'
          ? req.body.destinatario.trim()
          : '';
        if (!validarCorreo(destinatario)) {
          throw new ErrorHttp(400, 'CORREO_INVALIDO', 'La dirección de correo no tiene un formato válido.');
        }
        const nombreArchivo = `GymControl_Respaldo_${hwid}.db`;
        const resultado = await servicioGoogle.enviarRespaldoPorCorreo({
          hwid, nombreArchivo, destinatario
        });
        res.json({ ok: true, ...resultado });
      } catch (error) {
        next(error);
      }
    });

  app.use((_req, _res, next) => next(new ErrorHttp(404, 'RUTA_NO_ENCONTRADA',
    'La ruta solicitada no existe.')));

  app.use((error, req, res, _next) => {
    let errorHttp = error;
    if (error?.type === 'entity.too.large') {
      errorHttp = new ErrorHttp(413, 'RESPALDO_DEMASIADO_GRANDE',
        'El archivo supera el tamaño máximo permitido.');
    } else if (error instanceof SyntaxError && error?.type === 'entity.parse.failed') {
      errorHttp = new ErrorHttp(400, 'JSON_INVALIDO', 'El cuerpo JSON no es válido.');
    } else if (!(error instanceof ErrorHttp)) {
      errorHttp = new ErrorHttp(500, 'ERROR_INTERNO', 'Ocurrió un error interno inesperado.');
    }

    if (errorHttp.estado >= 500) {
      logger.error(`[GymControl API] ${req.idSolicitud} ${errorHttp.codigo} (${errorHttp.estado}).`);
    }
    res.status(errorHttp.estado).json({
      ok: false,
      error: { codigo: errorHttp.codigo, mensaje: errorHttp.message },
      idSolicitud: req.idSolicitud
    });
  });

  return app;
}

module.exports = { crearAplicacion };
