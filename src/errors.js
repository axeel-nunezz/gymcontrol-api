class ErrorHttp extends Error {
  constructor(estado, codigo, mensaje, causa) {
    super(mensaje, causa ? { cause: causa } : undefined);
    this.name = 'ErrorHttp';
    this.estado = estado;
    this.codigo = codigo;
    this.esOperacional = true;
  }
}

function errorGoogle(accion, causa) {
  const estadoGoogle = Number(causa?.response?.status || causa?.code || 0);
  if (estadoGoogle === 401 || estadoGoogle === 403) {
    return new ErrorHttp(502, 'GOOGLE_AUTORIZACION_RECHAZADA',
      `Google rechazó la autorización al ${accion}. Revisa el refresh token y los permisos configurados.`, causa);
  }
  if (estadoGoogle === 429) {
    return new ErrorHttp(503, 'GOOGLE_LIMITE_TEMPORAL',
      'Google limitó temporalmente las solicitudes. Intenta nuevamente en unos minutos.', causa);
  }
  return new ErrorHttp(502, 'GOOGLE_NO_DISPONIBLE',
    `No se pudo ${accion} mediante Google en este momento.`, causa);
}

module.exports = { ErrorHttp, errorGoogle };
