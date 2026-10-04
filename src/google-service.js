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
    const previo = this.bloqueosPorHwid.get(datos.hwid) || Promise.resolve();
    let liberar;
    const turnoActual = new Promise((resolve) => { liberar = resolve; });
    const colaActual = previo.then(() => turnoActual);
    this.bloqueosPorHwid.set(datos.hwid, colaActual);
    await previo;
    try {
      return await this.#subirRespaldoSerializado(datos);
    } finally {
      liberar();
      if (this.bloqueosPorHwid.get(datos.hwid) === colaActual) {
        this.bloqueosPorHwid.delete(datos.hwid);
      }
    }
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
