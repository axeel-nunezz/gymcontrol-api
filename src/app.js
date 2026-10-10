const crypto = require('node:crypto');

const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const { ErrorHttp } = require('./errors');
const { autenticarBearer, autenticarCliente, recibirCredencialCliente,
  compararSeguro, validarCorreo, validarHwid } = require('./security');

const CABECERA_SQLITE = Buffer.from('SQLite format 3\0', 'ascii');
const CABECERA_ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const MAX_ADJUNTO_BYTES = 18 * 1024 * 1024;

function validarReporteCaja(req, requiereCorreo = false) {
  const { hwid, period: periodo, state: estado } = req.params;
  if (!validarHwid(hwid) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(periodo) ||
      !['PARCIAL', 'FINAL'].includes(estado)) {
    throw new ErrorHttp(400, 'REPORTE_INVALIDO', 'Equipo, período o estado de reporte inválido.');
  }
  const partesFecha = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit'
  }).formatToParts(new Date());
  const anio = partesFecha.find((parte) => parte.type === 'year').value;
  const mes = partesFecha.find((parte) => parte.type === 'month').value;
  const mesActual = `${anio}-${mes}`;
  if (periodo > mesActual || (estado === 'FINAL' && periodo === mesActual)) {
    throw new ErrorHttp(400, 'PERIODO_NO_CERRADO', 'El período solicitado todavía no está cerrado.');
  }
  if (!req.is('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) {
    throw new ErrorHttp(415, 'TIPO_CONTENIDO_INVALIDO', 'El reporte debe enviarse como XLSX.');
  }
  if (!Buffer.isBuffer(req.body) || req.body.length <= CABECERA_ZIP.length ||
      !req.body.subarray(0, CABECERA_ZIP.length).equals(CABECERA_ZIP)) {
    throw new ErrorHttp(422, 'EXCEL_INVALIDO', 'El archivo enviado no es un XLSX válido.');
  }
  const sha256 = req.get('X-Content-SHA256');
  if (!sha256 || !/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new ErrorHttp(400, 'SHA256_AUSENTE', 'Debes enviar una huella SHA-256 válida.');
  }
  const calculado = crypto.createHash('sha256').update(req.body).digest('hex');
  if (!compararSeguro(sha256.toLowerCase(), calculado)) {
    throw new ErrorHttp(422, 'SHA256_NO_COINCIDE', 'La huella SHA-256 no coincide con el reporte.');
  }
  const destinatario = req.get('X-Recipient-Email')?.trim() || '';
  if (requiereCorreo && !validarCorreo(destinatario)) {
    throw new ErrorHttp(400, 'CORREO_INVALIDO', 'La dirección de correo no tiene un formato válido.');
  }
  return { hwid, periodo, estado, destinatario, sha256: calculado,
    nombreArchivo: `ReporteCaja_${periodo}_${hwid}_${estado}.xlsx`, contenido: req.body };
}

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

function respuestaHtml(titulo, mensaje, contenidoCopiable = '', codigoEntrega = '') {
  const bloqueCopia = contenidoCopiable
    ? `<div style="background:#f1f5f9;border:1px solid #cbd5e1;padding:16px;border-radius:8px;margin-top:20px;text-align:left;">
         <label style="font-weight:600;display:block;margin-bottom:8px;color:#1e293b;">GOOGLE_REFRESH_TOKEN (Copia este valor completo):</label>
         <textarea readonly onclick="this.select()" style="width:100%;height:80px;padding:10px;font-family:monospace;font-size:13px;border:1px solid #94a3b8;border-radius:6px;box-sizing:border-box;resize:none;">${contenidoCopiable}</textarea>
         <p style="color:#475569;font-size:13px;margin:10px 0 0 0;">👉 Pega este texto en <strong>Render &gt; Environment &gt; GOOGLE_REFRESH_TOKEN</strong> y presiona <strong>Save Changes</strong>.</p>
       </div>`
    : '';
  const bloqueCodigo = codigoEntrega
    ? `<p style="color:#64748b;font-size:12px;margin-top:12px;">Código de canje alternativo: <code>${codigoEntrega}</code></p>`
    : '';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${titulo}</title></head>` +
    `<body style="font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:620px;margin:50px auto;padding:24px;line-height:1.5;color:#1e293b;">` +
    `<main><h1 style="color:#0f172a;margin-bottom:8px;font-size:24px;">${titulo}</h1><p style="margin:0;color:#334155;">${mensaje}</p>${bloqueCopia}${bloqueCodigo}</main></body></html>`;
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

  const autenticarApi = autenticarCliente(servicioGoogle);
  const autenticarAdmin = autenticarBearer(configuracion.oauthAdminKey, 'ADMIN_KEY_INVALIDA');
  const limitarSubidas = crearLimitador(configuracion, configuracion.limites.subidasPorVentana);
  const limitarCorreos = crearLimitador(configuracion, configuracion.limites.correosPorVentana);
  const limitarOAuth = crearLimitador(configuracion, configuracion.limites.oauthPorVentana);
  const limitarRegistros = crearLimitador(configuracion, 30);

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
      res.type('html').send(respuestaHtml('Autorización completada con éxito',
        'Tu cuenta de Google fue vinculada correctamente con GymControl.',
        resultado.refreshToken,
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

  app.post('/api/v1/clients/:hwid/register', limitarRegistros, recibirCredencialCliente,
    async (req, res, next) => {
      try {
        const resultado = await servicioGoogle.registrarCliente(
          req.hwidAutenticado, req.credencialCliente);
        res.status(resultado.creado ? 201 : 200).json({ ok: true, ...resultado });
      } catch (error) {
        next(error);
      }
    });

  app.put('/api/v1/backups/:hwid', limitarSubidas, autenticarApi,
    express.raw({ type: ['application/x-sqlite3', 'application/vnd.sqlite3', 'application/octet-stream'],
      limit: configuracion.maxBackupBytes }), async (req, res, next) => {
      try {
        const hwid = req.hwidAutenticado;
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
          hwid, clienteId: req.clienteId, nombreArchivo,
          contenido: req.body, sha256: sha256Calculado
        });
        res.status(resultado.creado ? 201 : 200).json({ ok: true, ...resultado });
      } catch (error) {
        next(error);
      }
    });

  app.post('/api/v1/backups/:hwid/email', limitarCorreos, autenticarApi,
    express.json({ limit: '16kb', strict: true }), async (req, res, next) => {
      try {
        const hwid = req.hwidAutenticado;
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
          hwid, clienteId: req.clienteId, nombreArchivo, destinatario
        });
        res.json({ ok: true, ...resultado });
      } catch (error) {
        next(error);
      }
    });

  app.post('/api/v1/backups/:hwid/email-attachment', limitarCorreos, autenticarApi,
    express.raw({ type: ['application/x-sqlite3',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    limit: Math.min(configuracion.maxBackupBytes, MAX_ADJUNTO_BYTES) }), async (req, res, next) => {
      try {
        const hwid = req.hwidAutenticado;
        if (!validarHwid(hwid)) {
          throw new ErrorHttp(400, 'HWID_INVALIDO', 'El identificador del equipo no tiene un formato válido.');
        }
        const destinatario = req.get('X-Recipient-Email')?.trim() || '';
        if (!validarCorreo(destinatario)) {
          throw new ErrorHttp(400, 'CORREO_INVALIDO', 'La dirección de correo no tiene un formato válido.');
        }
        const esExcel = req.is('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        const esSqlite = req.is('application/x-sqlite3');
        if (!esExcel && !esSqlite) {
          throw new ErrorHttp(415, 'TIPO_CONTENIDO_INVALIDO', 'El adjunto debe ser SQLite o Excel.');
        }
        const cabecera = esExcel ? CABECERA_ZIP : CABECERA_SQLITE;
        if (!Buffer.isBuffer(req.body) || req.body.length <= cabecera.length ||
            !req.body.subarray(0, cabecera.length).equals(cabecera)) {
          throw new ErrorHttp(422, 'ADJUNTO_INVALIDO', 'El archivo adjunto no coincide con su formato.');
        }
        const sha256 = req.get('X-Content-SHA256');
        if (!sha256 || !/^[a-f0-9]{64}$/i.test(sha256)) {
          throw new ErrorHttp(400, 'SHA256_AUSENTE', 'Debes enviar una huella SHA-256 válida.');
        }
        const calculado = crypto.createHash('sha256').update(req.body).digest('hex');
        if (!compararSeguro(sha256.toLowerCase(), calculado)) {
          throw new ErrorHttp(422, 'SHA256_NO_COINCIDE', 'La huella SHA-256 no coincide con el adjunto.');
        }
        const accesos = req.get('X-Report-Accesses');
        if (esExcel && !['true', 'false'].includes(accesos)) {
          throw new ErrorHttp(400, 'OPCION_ACCESOS_INVALIDA', 'Indica si el Excel incluye accesos.');
        }
        const nombreArchivo = esExcel
          ? `GymControl_Socios_${hwid}.xlsx`
          : `GymControl_Respaldo_${hwid}.db`;
        const resultado = await servicioGoogle.enviarAdjuntoPorCorreo({
          destinatario, hwid, nombreArchivo, contenido: req.body,
          mimeType: esExcel
            ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            : 'application/x-sqlite3',
          incluyeAccesos: esExcel && accesos === 'true'
        });
        
        let drive = { sincronizado: esSqlite ? false : null, error: null };
        if (esSqlite) {
          try {
             await servicioGoogle.subirRespaldo({ hwid, clienteId: req.clienteId,
               nombreArchivo, contenido: req.body, sha256: calculado });
            drive = { sincronizado: true, error: null };
          } catch (e) {
            logger.error(`[GymControl API] ${req.idSolicitud} no se pudo sincronizar Drive después del correo.`);
            drive = { sincronizado: false, error: {
              codigo: e instanceof ErrorHttp ? e.codigo : 'DRIVE_NO_SINCRONIZADO',
              mensaje: e instanceof ErrorHttp ? e.message : 'No se pudo sincronizar el respaldo en Drive.'
            } };
          }
        }
        res.json({ ok: true, ...resultado, email: { enviado: true }, drive });
      } catch (error) {
        next(error);
      }
    });

  const tipoExcel = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  app.put('/api/v1/reports/cash/:hwid/:period/:state', limitarSubidas, autenticarApi,
    express.raw({ type: tipoExcel, limit: configuracion.maxBackupBytes }), async (req, res, next) => {
      try {
        const datos = validarReporteCaja(req);
        const resultado = await servicioGoogle.subirReporteCaja({ ...datos, clienteId: req.clienteId });
        res.json({ ok: true, ...resultado });
      } catch (error) {
        next(error);
      }
    });

  app.post('/api/v1/reports/cash/:hwid/:period/:state/email', limitarCorreos, autenticarApi,
    express.raw({ type: tipoExcel, limit: Math.min(configuracion.maxBackupBytes, MAX_ADJUNTO_BYTES) }),
    async (req, res, next) => {
      try {
        const datos = validarReporteCaja(req, true);
        const resultado = await servicioGoogle.enviarReporteCajaPorCorreo(datos);
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
