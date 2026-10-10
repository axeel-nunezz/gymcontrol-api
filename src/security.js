const crypto = require('node:crypto');
const { ErrorHttp } = require('./errors');

function compararSeguro(valorRecibido, valorEsperado) {
  const hashRecibido = crypto.createHash('sha256').update(valorRecibido || '').digest();
  const hashEsperado = crypto.createHash('sha256').update(valorEsperado || '').digest();
  return crypto.timingSafeEqual(hashRecibido, hashEsperado);
}

function extraerBearer(autorizacion) {
  if (typeof autorizacion !== 'string') return '';
  const coincidencia = autorizacion.match(/^Bearer\s+([^\s]+)$/i);
  return coincidencia ? coincidencia[1] : '';
}

function autenticarBearer(secretoEsperado, codigoError = 'NO_AUTORIZADO') {
  return (req, _res, next) => {
    const token = extraerBearer(req.get('authorization'));
    if (!token || !compararSeguro(token, secretoEsperado)) {
      next(new ErrorHttp(401, codigoError, 'La credencial de acceso no es válida.'));
      return;
    }
    next();
  };
}

function recibirCredencialCliente(req, _res, next) {
    const token = extraerBearer(req.get('authorization'));
    const hwid = req.params.hwid;
    if (!validarHwid(hwid) || token.length < 32 || token.length > 256 ||
        !/^[A-Za-z0-9+/=_-]+$/.test(token)) {
      next(new ErrorHttp(401, 'API_KEY_INVALIDA', 'La credencial de acceso no es válida.'));
      return;
    }
    if (req.get('x-hwid') !== hwid) {
      next(new ErrorHttp(403, 'HWID_NO_AUTORIZADO', 'El identificador del equipo no coincide con la credencial.'));
      return;
    }
    req.hwidAutenticado = hwid;
    req.credencialCliente = token;
    next();
}

function autenticarCliente(servicioGoogle) {
  return [recibirCredencialCliente, async (req, _res, next) => {
    try {
      const clienteId = await servicioGoogle.autenticarCliente(
        req.hwidAutenticado, req.credencialCliente);
      if (!clienteId) {
        throw new ErrorHttp(401, 'API_KEY_INVALIDA', 'La credencial de acceso no es válida.');
      }
      req.clienteId = clienteId;
      next();
    } catch (error) {
      next(error);
    }
  }];
}

function validarHwid(hwid) {
  return typeof hwid === 'string' && /^GYM-\d{4}-[A-Z]$/.test(hwid);
}

function validarCorreo(correo) {
  if (typeof correo !== 'string' || correo.length > 254 || correo.includes('\r') || correo.includes('\n')) {
    return false;
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(correo);
}

module.exports = { autenticarBearer, autenticarCliente, recibirCredencialCliente,
  compararSeguro, validarCorreo, validarHwid };
