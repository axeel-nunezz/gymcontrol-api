require('dotenv').config();

const { cargarConfiguracion } = require('./src/config');
const { crearAplicacion } = require('./src/app');
const { ServicioGoogle } = require('./src/google-service');
const { ServicioOAuthBootstrap } = require('./src/oauth-service');

let servidor;

try {
  const configuracion = cargarConfiguracion(process.env);
  const servicioGoogle = new ServicioGoogle(configuracion);
  const servicioOAuth = new ServicioOAuthBootstrap(configuracion, {
    alObtenerRefreshToken: (refreshToken) => servicioGoogle.actualizarRefreshToken(refreshToken)
  });

  const aplicacion = crearAplicacion({ configuracion, servicioGoogle, servicioOAuth, logger: console });
  servidor = aplicacion.listen(configuracion.puerto, '0.0.0.0', () => {
    console.info(`[GymControl API] Servidor activo en el puerto ${configuracion.puerto}.`);
  });
} catch (error) {
  console.error(`[GymControl API] No se pudo iniciar: ${error.message}`);
  process.exitCode = 1;
}

function apagarServidor(senal) {
  if (!servidor) {
    process.exit(0);
    return;
  }
  console.info(`[GymControl API] Señal ${senal} recibida. Cerrando conexiones.`);
  servidor.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => apagarServidor('SIGTERM'));
process.on('SIGINT', () => apagarServidor('SIGINT'));
