const express = require('express');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('GymControl API en línea');
});

// Configuración del cliente OAuth2 con variables de entorno
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// 1. Ruta para iniciar la autorización (Visitar esta URL para autorizar)
app.get('/oauth/google/connect', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/gmail.send'
    ]
  });
  res.redirect(url);
});

// 2. Ruta de retorno (Google redirige aquí con el código)
app.get('/oauth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send('No se recibió código de autorización.');
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    console.log('====================================');
    console.log('NUEVO REFRESH TOKEN OBTENIDO:');
    console.log(tokens.refresh_token);
    console.log('====================================');

    res.send('<h1>¡Autorización exitosa!</h1><p>El refresh token fue generado y registrado en los logs del servidor.</p>');
  } catch (error) {
    console.error('Error al canjear el token:', error);
    res.status(500).send('Error al procesar la autorización con Google.');
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor activo en el puerto ${PORT}`);
});