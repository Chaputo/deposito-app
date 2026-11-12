const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// CONFIGURACIÓN DE GOOGLE SHEETS
const SPREADSHEET_ID = '1LqJSoz0hKBU9Xzeabtsn7TOdFoTIhWICzT6CtW74mEw'; // <-- Tu ID real
const credentialsJson = process.env.GOOGLE_CREDENTIALS 
  ? JSON.parse(process.env.GOOGLE_CREDENTIALS) 
  : require('./credentials.json');

const auth = new google.auth.GoogleAuth({
  credentials: credentialsJson,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

async function getSheets() {
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

// OBTENER LA LISTA DE PRODUCTOS TAL CUAL TU PLANILLA
app.get('/api/inventario', async (req, res) => {
  try {
    const sheets = await getSheets();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Productos!A2:J', // Leemos desde la A hasta la J
    });
    
    const rows = response.data.values || [];
    const productos = rows.map((row, index) => ({
      fila: index + 2,
      id: row[0],             // A: ID
      codigoBarra: row[1],    // B: COD_BARRA
      articulo: row[2],       // C: ARTICULO
      presentacion: row[3],   // D: PRESENTACION
      subfamilia: row[4],     // E: SUBFAMILIA_DENOM
      ubicacion: row[5],      // F: UBICACIÓN
      stockDeposito: row[6],  // G: STOCK DEPO
      stockPalets: row[7],    // H: STOCK PALETS
      stockPicking: row[8],   // I: STOCK PICKING
      stockTotal: row[9],     // J: STOCK TOTAL
    }));

    res.json(productos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`));