const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const { google } = require('googleapis');

const { ErrorHttp, errorGoogle } = require('./errors');

function escaparConsultaDrive(valor) {
  return valor.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function escaparHtml(valor) {
  return String(valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

class ServicioGoogle {
  constructor(configuracion, { logger = console } = {}) {
    this.configuracion = configuracion;
    this.logger = logger;
    this.refreshToken = configuracion.google.refreshToken;
    this.oauth2 = new google.auth.OAuth2(
      configuracion.google.clientId,
      configuracion.google.clientSecret,
      configuracion.google.redirectUri
    );
    this.drive = google.drive({ version: 'v3', auth: this.oauth2 });
    this.gmail = google.gmail({ version: 'v1', auth: this.oauth2 });
    this.promesaCarpeta = null;
    this.promesaCarpetaCaja = null;
    this.bloqueosPorHwid = new Map();
    this.#aplicarCredenciales();
  }

  estaConfigurado() {
    return Boolean(this.refreshToken);
  }

  actualizarRefreshToken(refreshToken) {
    if (typeof refreshToken !== 'string' || !refreshToken.trim()) {
      throw new ErrorHttp(400, 'REFRESH_TOKEN_INVALIDO', 'El refresh token recibido no es válido.');
    }
    this.refreshToken = refreshToken.trim();
    this.#aplicarCredenciales();
  }

  async subirRespaldo(datos) {
    return this.#serializarPorHwid(datos.hwid, () => this.#subirRespaldoSerializado(datos));
  }

  async #serializarPorHwid(hwid, operacion) {
    const previo = this.bloqueosPorHwid.get(hwid) || Promise.resolve();
    let liberar;
    const turnoActual = new Promise((resolve) => { liberar = resolve; });
    const colaActual = previo.then(() => turnoActual);
    this.bloqueosPorHwid.set(hwid, colaActual);
    await previo;
    try {
      return await operacion();
    } finally {
      liberar();
      if (this.bloqueosPorHwid.get(hwid) === colaActual) {
        this.bloqueosPorHwid.delete(hwid);
      }
    }
  }

  async subirReporteCaja(datos) {
    return this.#serializarPorHwid(datos.hwid, () => this.#subirReporteCajaSerializado(datos));
  }

  async #subirReporteCajaSerializado({ hwid, periodo, estado, nombreArchivo, contenido, sha256 }) {
    this.#exigirConfiguracion();
    try {
      const carpetaId = await this.#obtenerCarpetaCajaId();
      const anteriores = await this.#buscarArchivos(carpetaId, nombreArchivo);
      const md5 = crypto.createHash('md5').update(contenido).digest('hex');
      const propiedades = { gymcontrolHwid: hwid, gymcontrolOrigen: 'GymControlCaja',
        gymcontrolPeriodo: periodo, gymcontrolEstado: estado };
      const media = { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        body: Readable.from([contenido]) };
      let archivoId = anteriores[0]?.id;
      if (archivoId) {
        await this.drive.files.update({ fileId: archivoId, supportsAllDrives: true,
          requestBody: { name: nombreArchivo, appProperties: propiedades }, media, fields: 'id' });
      } else {
        const creado = await this.drive.files.create({ supportsAllDrives: true,
          requestBody: { name: nombreArchivo, parents: [carpetaId],
            mimeType: media.mimeType, appProperties: propiedades }, media, fields: 'id' });
        archivoId = creado.data.id;
      }
      const metadatos = await this.#obtenerMetadatos(archivoId);
      if (Number(metadatos.size) !== contenido.length || metadatos.md5Checksum !== md5) {
        throw new ErrorHttp(502, 'REPORTE_NO_VERIFICADO',
          'Drive recibió el reporte, pero no fue posible verificar su integridad.');
      }
      let eliminados = 0;
      let fallosLimpieza = 0;
      let conservadoEnDrive = true;
      const eliminar = async (id) => {
        try {
          await this.drive.files.delete({ fileId: id, supportsAllDrives: true });
          eliminados += 1;
          return true;
        } catch (error) {
          fallosLimpieza += 1;
          this.logger.warn(`[GymControl API] No se pudo depurar reporte de caja ${id}: ${error.message}`);
          return false;
        }
      };
      for (const duplicado of anteriores.slice(1)) await eliminar(duplicado.id);
      if (estado === 'FINAL') {
        const archivos = await this.#listarReportesCaja(carpetaId, hwid);
        const finales = new Map();
        for (const archivo of [{ id: archivoId, name: nombreArchivo }, ...archivos]) {
          const match = archivo.name.match(/^ReporteCaja_(\d{4}-(?:0[1-9]|1[0-2]))_GYM-\d{4}-[A-Z]_(FINAL|PARCIAL)\.xlsx$/);
          if (!match || match[2] !== 'FINAL' ||
              archivo.name !== `ReporteCaja_${match[1]}_${hwid}_FINAL.xlsx`) continue;
          if (!finales.has(match[1])) finales.set(match[1], []);
          if (!finales.get(match[1]).some((item) => item.id === archivo.id)) {
            finales.get(match[1]).push(archivo);
          }
        }
        const meses = [...finales.keys()].sort().reverse();
        const mantener = new Set(meses.slice(0, 2));
        for (const [mes, items] of finales) {
          for (const item of items) {
            if (!mantener.has(mes) || (item.id !== archivoId && items.indexOf(item) > 0)) {
              const eliminado = await eliminar(item.id);
              if (item.id === archivoId && eliminado) conservadoEnDrive = false;
            }
          }
        }
        for (const archivo of archivos) {
          const match = archivo.name.match(/^ReporteCaja_(\d{4}-(?:0[1-9]|1[0-2]))_GYM-\d{4}-[A-Z]_PARCIAL\.xlsx$/);
          if (match && finales.has(match[1]) &&
              archivo.name === `ReporteCaja_${match[1]}_${hwid}_PARCIAL.xlsx`) {
            await eliminar(archivo.id);
          }
        }
      }
      return { archivoId, nombreArchivo, periodo, estado, tamanioBytes: contenido.length,
        sha256, eliminados, fallosLimpieza, conservadoEnDrive,
        generadoEn: new Date().toISOString() };
    } catch (error) {
      if (error instanceof ErrorHttp) throw error;
      throw errorGoogle('guardar el reporte de caja', error);
    }
  }

  async enviarReporteCajaPorCorreo(datos) {
    return this.#enviarAdjuntoMime({ destinatario: datos.destinatario,
      nombreArchivo: datos.nombreArchivo, contenido: datos.contenido,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      asunto: `GymControl - Balance de Caja ${datos.periodo} - ${datos.estado}`,
      html: `<p>Reporte mensual de caja: ${escaparHtml(datos.periodo)} (${escaparHtml(datos.estado)}).</p>` +
        `<p>Equipo: ${escaparHtml(datos.hwid)}</p>` });
  }

  async #subirRespaldoSerializado({ hwid, nombreArchivo, contenido, sha256 }) {
    this.#exigirConfiguracion();
    try {
      const carpetaId = await this.#obtenerCarpetaId();
      const archivos = await this.#buscarArchivos(carpetaId, nombreArchivo);
      const archivoPrincipal = archivos[0];
      const md5Local = crypto.createHash('md5').update(contenido).digest('hex');
      const media = {
        mimeType: 'application/x-sqlite3',
        body: Readable.from([contenido])
      };

      let creado = false;
      let archivoId;
      if (archivoPrincipal) {
        archivoId = archivoPrincipal.id;
        await this.drive.files.update({
          fileId: archivoId,
          supportsAllDrives: true,
          requestBody: {
            name: nombreArchivo,
            description: `Respaldo automático de ${hwid}`,
            appProperties: { gymcontrolHwid: hwid, gymcontrolOrigen: 'GymControl' }
          },
          media,
          fields: 'id'
        });
      } else {
        creado = true;
        const respuesta = await this.drive.files.create({
          supportsAllDrives: true,
          requestBody: {
            name: nombreArchivo,
            description: `Respaldo automático de ${hwid}`,
            mimeType: 'application/x-sqlite3',
            parents: [carpetaId],
            appProperties: { gymcontrolHwid: hwid, gymcontrolOrigen: 'GymControl' }
          },
          media,
          fields: 'id'
        });
        archivoId = respuesta.data.id;
      }

      const archivo = await this.#obtenerMetadatos(archivoId);
      if (Number(archivo.size) !== contenido.length || archivo.md5Checksum !== md5Local) {
        throw new ErrorHttp(502, 'RESPALDO_NO_VERIFICADO',
          'Drive recibió el archivo, pero no fue posible verificar su integridad.');
      }

      let duplicadosEliminados = 0;
      for (const duplicado of archivos.filter((item) => item.id !== archivoId)) {
        try {
          await this.drive.files.delete({ fileId: duplicado.id, supportsAllDrives: true });
          duplicadosEliminados += 1;
        } catch {
          this.logger.warn('[GymControl API] No se pudo eliminar un respaldo duplicado de Drive.');
        }
      }

      return {
        creado,
        archivoId,
        nombreArchivo,
        enlaceDescarga: this.#enlaceArchivo(archivoId, archivo),
        tamanioBytes: contenido.length,
        sha256,
        duplicadosEliminados,
        generadoEn: new Date().toISOString()
      };
    } catch (error) {
      if (error instanceof ErrorHttp) throw error;
      throw errorGoogle('guardar el respaldo', error);
    }
  }

  async enviarRespaldoPorCorreo({ hwid, nombreArchivo, destinatario }) {
    this.#exigirConfiguracion();
    try {
      const carpetaId = await this.#obtenerCarpetaId();
      const archivos = await this.#buscarArchivos(carpetaId, nombreArchivo);
      const archivo = archivos[0];
      if (!archivo) {
        throw new ErrorHttp(404, 'RESPALDO_NO_ENCONTRADO',
          'Todavía no existe un respaldo de este equipo en Drive.');
      }

      await this.#compartirCon(archivo.id, destinatario);
      const metadatos = await this.#obtenerMetadatos(archivo.id);
      const enlaceDescarga = this.#enlaceArchivo(archivo.id, metadatos);
      await this.#enviarCorreo({
        destinatario,
        hwid,
        nombreArchivo,
        enlaceDescarga,
        tamanioBytes: Number(metadatos.size || 0),
        modificadoEn: metadatos.modifiedTime
      });

      return {
        archivoId: archivo.id,
        nombreArchivo,
        destinatario,
        enlaceDescarga,
        tamanioBytes: Number(metadatos.size || 0),
        generadoEn: metadatos.modifiedTime,
        enviadoEn: new Date().toISOString()
      };
    } catch (error) {
      if (error instanceof ErrorHttp) throw error;
      throw errorGoogle('compartir el respaldo y enviar el correo', error);
    }
  }

  async enviarAdjuntoPorCorreo({ destinatario, hwid, nombreArchivo, contenido,
    mimeType, incluyeAccesos }) {
    const esExcel = mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const asunto = esExcel
      ? 'GymControl - Padrón de Socios' + (incluyeAccesos ? ' y Accesos' : '')
      : 'GymControl - Respaldo de Base de Datos';
    const descripcion = esExcel
      ? `Padrón operativo de socios${incluyeAccesos ? ' y accesos del último mes' : ''}.`
      : 'Copia completa de la base de datos para restauración.';
    return this.#enviarAdjuntoMime({ destinatario, nombreArchivo, contenido, mimeType,
      asunto, html: `<p>${escaparHtml(descripcion)}</p><p>Equipo: ${escaparHtml(hwid)}</p>` });
  }

  async #enviarAdjuntoMime({ destinatario, nombreArchivo, contenido, mimeType, asunto, html }) {
    this.#exigirConfiguracion();
    const frontera = `gymcontrol-${crypto.randomUUID()}`;
    const mensaje = [
      `To: ${destinatario}`,
      `Subject: =?UTF-8?B?${Buffer.from(asunto, 'utf8').toString('base64')}?=`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${frontera}"`,
      '',
      `--${frontera}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(html, 'utf8').toString('base64'),
      `--${frontera}`,
      `Content-Type: ${mimeType}; name="${nombreArchivo}"`,
      `Content-Disposition: attachment; filename="${nombreArchivo}"`,
      'Content-Transfer-Encoding: base64',
      '',
      contenido.toString('base64').replace(/.{76}/g, '$&\r\n'),
      `--${frontera}--`,
      ''
    ].join('\r\n');
    try {
      await this.gmail.users.messages.send({
        userId: 'me', requestBody: { raw: Buffer.from(mensaje, 'utf8').toString('base64url') }
      });
      return { destinatario, nombreArchivo, tamanioBytes: contenido.length,
        enviadoEn: new Date().toISOString() };
    } catch (error) {
      throw errorGoogle('enviar el archivo adjunto por Gmail', error);
    }
  }

  #aplicarCredenciales() {
    this.oauth2.setCredentials(this.refreshToken ? { refresh_token: this.refreshToken } : {});
  }

  #exigirConfiguracion() {
    if (!this.estaConfigurado()) {
      throw new ErrorHttp(503, 'GOOGLE_OAUTH_NO_CONFIGURADO',
        'El servidor todavía no tiene configurado GOOGLE_REFRESH_TOKEN.');
    }
  }

  async #obtenerCarpetaId() {
    if (!this.promesaCarpeta) {
      const obtener = this.configuracion.google.driveFolderId
        ? this.#validarCarpetaExplicita(this.configuracion.google.driveFolderId)
        : this.#buscarOCrearCarpeta();
      this.promesaCarpeta = obtener.catch((error) => {
        this.promesaCarpeta = null;
        throw error;
      });
    }
    return this.promesaCarpeta;
  }

  async #obtenerCarpetaCajaId() {
    if (!this.promesaCarpetaCaja) {
      this.promesaCarpetaCaja = (async () => {
        const padre = await this.#obtenerCarpetaId();
        const respuesta = await this.drive.files.list({
          q: `'${escaparConsultaDrive(padre)}' in parents and name = 'Reportes_Caja' and ` +
            "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
          spaces: 'drive', pageSize: 100, fields: 'nextPageToken,files(id,name)',
          supportsAllDrives: true, includeItemsFromAllDrives: true
        });
        if (respuesta.data.files?.length) return respuesta.data.files[0].id;
        const creada = await this.drive.files.create({ supportsAllDrives: true,
          requestBody: { name: 'Reportes_Caja', mimeType: 'application/vnd.google-apps.folder',
            parents: [padre] }, fields: 'id' });
        return creada.data.id;
      })().catch((error) => { this.promesaCarpetaCaja = null; throw error; });
    }
    return this.promesaCarpetaCaja;
  }

  async #listarReportesCaja(carpetaId, hwid) {
    const archivos = [];
    let pageToken;
    do {
      const respuesta = await this.drive.files.list({
        q: `'${escaparConsultaDrive(carpetaId)}' in parents and ` +
          "name contains 'ReporteCaja_' and trashed = false",
        spaces: 'drive', pageSize: 1000, pageToken,
        fields: 'nextPageToken,files(id,name,appProperties)',
        supportsAllDrives: true, includeItemsFromAllDrives: true
      });
      for (const archivo of respuesta.data.files || []) {
        if (archivo.name?.includes(`_${hwid}_`) &&
            (!archivo.appProperties || (archivo.appProperties.gymcontrolOrigen === 'GymControlCaja' &&
              archivo.appProperties.gymcontrolHwid === hwid))) archivos.push(archivo);
      }
      pageToken = respuesta.data.nextPageToken;
    } while (pageToken);
    return archivos;
  }

  async #validarCarpetaExplicita(carpetaId) {
    const respuesta = await this.drive.files.get({
      fileId: carpetaId,
      supportsAllDrives: true,
      fields: 'id,mimeType,trashed,capabilities(canAddChildren)'
    });
    const carpeta = respuesta.data;
    if (carpeta.trashed || carpeta.mimeType !== 'application/vnd.google-apps.folder' ||
        carpeta.capabilities?.canAddChildren === false) {
      throw new ErrorHttp(503, 'CARPETA_DRIVE_INVALIDA',
        'GOOGLE_DRIVE_FOLDER_ID no corresponde a una carpeta disponible para escritura.');
    }
    return carpeta.id;
  }

  async #buscarOCrearCarpeta() {
    const nombre = this.configuracion.google.driveFolderName;
    const respuesta = await this.drive.files.list({
      q: `name = '${escaparConsultaDrive(nombre)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      spaces: 'drive',
      pageSize: 10,
      orderBy: 'createdTime asc',
      fields: 'files(id,name,createdTime)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });
    if (respuesta.data.files?.length) return respuesta.data.files[0].id;

    const creada = await this.drive.files.create({
      requestBody: { name: nombre, mimeType: 'application/vnd.google-apps.folder' },
      fields: 'id'
    });
    return creada.data.id;
  }

  async #buscarArchivos(carpetaId, nombreArchivo) {
    const respuesta = await this.drive.files.list({
      q: `'${escaparConsultaDrive(carpetaId)}' in parents and name = '${escaparConsultaDrive(nombreArchivo)}' and trashed = false`,
      spaces: 'drive',
      pageSize: 100,
      orderBy: 'modifiedTime desc',
      fields: 'files(id,name,size,md5Checksum,webViewLink,webContentLink,modifiedTime)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });
    return respuesta.data.files || [];
  }

  async #obtenerMetadatos(archivoId) {
    const respuesta = await this.drive.files.get({
      fileId: archivoId,
      supportsAllDrives: true,
      fields: 'id,name,size,md5Checksum,webViewLink,webContentLink,modifiedTime'
    });
    return respuesta.data;
  }

  #enlaceArchivo(archivoId, metadatos) {
    return metadatos.webViewLink || metadatos.webContentLink ||
      `https://drive.google.com/file/d/${encodeURIComponent(archivoId)}/view`;
  }

  async #compartirCon(archivoId, destinatario) {
    const respuesta = await this.drive.permissions.list({
      fileId: archivoId,
      supportsAllDrives: true,
      fields: 'permissions(id,type,role,emailAddress,deleted)'
    });
    const yaTieneAcceso = (respuesta.data.permissions || []).some((permiso) =>
      !permiso.deleted && permiso.type === 'user' &&
      permiso.emailAddress?.toLowerCase() === destinatario.toLowerCase()
    );
    if (yaTieneAcceso) return;

    await this.drive.permissions.create({
      fileId: archivoId,
      supportsAllDrives: true,
      sendNotificationEmail: false,
      requestBody: { type: 'user', role: 'reader', emailAddress: destinatario },
      fields: 'id'
    });
  }

  async #enviarCorreo({
    destinatario, hwid, nombreArchivo, enlaceDescarga, tamanioBytes, modificadoEn
  }) {
    const asunto = `Respaldo de GymControl - ${hwid}`;
    const instante = modificadoEn ? new Date(modificadoEn) : new Date();
    const fechaHora = new Intl.DateTimeFormat('es-AR', {
      dateStyle: 'long', timeStyle: 'medium', timeZone: 'America/Argentina/Buenos_Aires'
    }).format(instante);
    const tamanio = tamanioBytes >= 1024 * 1024
      ? `${(tamanioBytes / (1024 * 1024)).toFixed(2)} MB`
      : `${(tamanioBytes / 1024).toFixed(2)} KB`;
    const html = [
      '<p>Se generó correctamente el respaldo solicitado de GymControl.</p>',
      `<p><strong>Equipo:</strong> ${escaparHtml(hwid)}<br>`,
      `<strong>Archivo:</strong> ${escaparHtml(nombreArchivo)}<br>`,
      `<strong>Fecha y hora:</strong> ${escaparHtml(fechaHora)}<br>`,
      `<strong>Tamaño:</strong> ${escaparHtml(tamanio)}</p>`,
      `<p><a href="${escaparHtml(enlaceDescarga)}">Abrir respaldo en Google Drive</a></p>`,
      '<p>Este enlace fue compartido únicamente con la dirección destinataria.</p>'
    ].join('');
    const mensaje = [
      `To: ${destinatario}`,
      `Subject: =?UTF-8?B?${Buffer.from(asunto, 'utf8').toString('base64')}?=`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(html, 'utf8').toString('base64')
    ].join('\r\n');

    await this.gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: Buffer.from(mensaje, 'utf8').toString('base64url') }
    });
  }
}

module.exports = { ServicioGoogle };
