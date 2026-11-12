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

function numeroStock(value) {
  const numero = Number(value);
  return Number.isFinite(numero) ? numero : 0;
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
      stockTotal: numeroStock(row[6]) + numeroStock(row[7]) + numeroStock(row[8]),
    }));

    res.json(productos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/inventario/:fila', async (req, res) => {
  const fila = Number(req.params.fila);
  const { stockDeposito, stockPalets, stockPicking } = req.body || {};
  const cantidades = [stockDeposito, stockPalets, stockPicking];

  if (!Number.isInteger(fila) || fila < 2) {
    return res.status(400).json({ error: 'La fila del producto no es válida.' });
  }

  if (cantidades.some(cantidad => typeof cantidad !== 'number' || !Number.isFinite(cantidad) || cantidad < 0)) {
    return res.status(400).json({ error: 'Las cantidades deben ser números válidos iguales o mayores que cero.' });
  }

  const stockTotal = cantidades.reduce((total, cantidad) => total + cantidad, 0);
  if (!Number.isFinite(stockTotal)) {
    return res.status(400).json({ error: 'La suma de las cantidades no es válida.' });
  }

  try {
    const sheets = await getSheets();
    const producto = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `Productos!A${fila}:A${fila}`,
    });

    if (!producto.data.values || !producto.data.values[0] || !producto.data.values[0][0]) {
      return res.status(404).json({ error: 'No se encontró el producto indicado.' });
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `Productos!G${fila}:J${fila}`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[stockDeposito, stockPalets, stockPicking, stockTotal]],
      },
    });

    res.json({ stockDeposito, stockPalets, stockPicking, stockTotal });
  } catch (error) {
    console.error('Error al actualizar el inventario:', error);
    res.status(500).json({ error: 'No se pudieron guardar las cantidades en la planilla.' });
  }
});

app.use(express.static('public'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`));