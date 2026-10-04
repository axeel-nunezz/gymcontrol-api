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

function validarHwid(hwid) {
  return typeof hwid === 'string' && /^GYM-\d{4}-[A-Z]$/.test(hwid);
}

function validarCorreo(correo) {
  if (typeof correo !== 'string' || correo.length > 254 || correo.includes('\r') || correo.includes('\n')) {
    return false;
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(correo);
}

module.exports = { autenticarBearer, compararSeguro, validarCorreo, validarHwid };
