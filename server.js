const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const { randomUUID } = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// CONFIGURACIÓN DE GOOGLE SHEETS
const SPREADSHEET_ID = '1LqJSoz0hKBU9Xzeabtsn7TOdFoTIhWICzT6CtW74mEw'; // <-- Tu ID real
const PALETS_SHEET = 'Croquis_Palets';
const ENCABEZADOS_CROQUIS = ['ID', 'Seccion', 'Producto', 'Cantidad', 'Notas'];
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

function nombreNormalizado(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

function ubicacionValida(value) {
  const coincidencia = /^([A-C][1-5])-(\d{2})$/.exec(value);
  if (!coincidencia) return false;
  const subsector = Number(coincidencia[2]);
  return subsector >= 1 && subsector <= 16;
}

function columnaA1(numero) {
  let columna = '';
  while (numero > 0) {
    const resto = (numero - 1) % 26;
    columna = String.fromCharCode(65 + resto) + columna;
    numero = Math.floor((numero - 1) / 26);
  }
  return columna;
}

function rangoHoja(titulo, rango) {
  return `'${titulo.replace(/'/g, "''")}'!${rango}`;
}

async function getPaletsSheet() {
  const sheets = await getSheets();
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: 'sheets.properties',
  });
  const hojas = spreadsheet.data.sheets.map(sheet => sheet.properties);
  const encabezadosPorHoja = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: SPREADSHEET_ID,
    ranges: hojas.map(hoja => rangoHoja(hoja.title, 'A1:Z1')),
  });
  let propiedades;
  let encabezados;

  hojas.forEach((hoja, index) => {
    const valores = encabezadosPorHoja.data.valueRanges[index].values;
    if (!propiedades && valores && valores[0]) {
      const normalizados = valores[0].map(nombreNormalizado);
      const requeridos = ['id', 'seccion', 'producto', 'cantidad', 'notas'];
      if (requeridos.every(nombre => normalizados.includes(nombre))) {
        propiedades = hoja;
        encabezados = valores[0];
      }
    }
  });

  if (!propiedades && hojas.some(hoja => hoja.title === PALETS_SHEET)) {
    throw new Error(`La pestaña "${PALETS_SHEET}" existe, pero no tiene las columnas ID, Seccion, Producto, Cantidad y Notas.`);
  }

  if (!propiedades) {
    const response = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: PALETS_SHEET } } }],
      },
    });
    propiedades = response.data.replies[0].addSheet.properties;
    encabezados = ENCABEZADOS_CROQUIS;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: rangoHoja(PALETS_SHEET, `A1:${columnaA1(ENCABEZADOS_CROQUIS.length)}1`),
      valueInputOption: 'RAW',
      requestBody: {
        values: [ENCABEZADOS_CROQUIS],
      },
    });
  }

  const columnas = {};
  encabezados.forEach((nombre, index) => {
    columnas[nombreNormalizado(nombre)] = index;
  });
  return {
    sheets,
    sheetId: propiedades.sheetId,
    titulo: propiedades.title,
    columnas,
    ancho: encabezados.length,
  };
}

async function leerCroquis({ sheets, titulo, columnas, ancho }) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: rangoHoja(titulo, `A2:${columnaA1(ancho)}`),
  });
  const filas = response.data.values || [];
  const secciones = new Set();
  const palets = [];
  const productos = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Productos!A2:J',
  });
  const catalogo = (productos.data.values || []).map((fila, index) => ({
    fila: index + 2,
    id: fila[0],
    codigoBarra: fila[1],
    articulo: fila[2],
  }));
  const indice = nombre => columnas[nombre];

  filas.forEach((fila, index) => {
    const id = fila[indice('id')] || '';
    const seccion = fila[indice('seccion')] || '';
    if (id.startsWith('__SECCION__:')) return;
    if (!id) return;

    const productoTexto = String(fila[indice('producto')] || '');
    const productoClave = nombreNormalizado(productoTexto);
    const producto = catalogo.find(item =>
      [item.id, item.codigoBarra, item.articulo]
        .some(valor => nombreNormalizado(valor) === productoClave)
    );
    const filaNumerica = Number(productoTexto);
    palets.push({
      fila: index + 2,
      id,
      seccion,
      productoFila: producto ? producto.fila :
        (Number.isInteger(filaNumerica) && filaNumerica >= 2 ? filaNumerica : null),
      cantidad: numeroStock(fila[indice('cantidad')]),
      nota: fila[indice('notas')] || '',
    });
    if (seccion) secciones.add(seccion);
  });

  return {
    secciones: Array.from(secciones),
    palets,
  };
}

function validarPalet({ seccion, productoFila, cantidad, nota }) {
  if (typeof seccion !== 'string' || !ubicacionValida(seccion)) {
    return 'El lugar debe ser un subsector válido del plano (por ejemplo, A1-01).';
  }
  if (productoFila !== null && productoFila !== undefined &&
      (!Number.isInteger(productoFila) || productoFila < 2)) {
    return 'El producto indicado no es válido.';
  }
  if (typeof cantidad !== 'number' || !Number.isFinite(cantidad) || cantidad < 0) {
    return 'La cantidad debe ser un número válido igual o mayor que cero.';
  }
  if (typeof nota !== 'string' || nota.length > 500) {
    return 'La nota no puede superar los 500 caracteres.';
  }
  return null;
}

async function obtenerProducto(sheets, fila) {
  if (fila === null || fila === undefined) return null;
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `Productos!A${fila}:C${fila}`,
  });
  const valores = response.data.values && response.data.values[0];
  if (!valores || !(valores[0] || valores[2])) return undefined;
  return { id: valores[0], articulo: valores[2] || valores[0] };
}

function filaCroquis(columnas, ancho, datos, existente = []) {
  const fila = Array.from({ length: ancho }, (_, index) => existente[index] || '');
  fila[columnas.id] = datos.id;
  fila[columnas.seccion] = datos.seccion;
  fila[columnas.producto] = datos.producto || '';
  fila[columnas.cantidad] = datos.cantidad;
  fila[columnas.notas] = datos.nota;
  return fila;
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

app.get('/api/croquis', async (req, res) => {
  try {
    const hoja = await getPaletsSheet();
    res.json(await leerCroquis(hoja));
  } catch (error) {
    console.error('Error al cargar el croquis:', error);
    res.status(500).json({ error: error.message || 'No se pudo cargar el croquis del depósito.' });
  }
});

app.post('/api/palets', async (req, res) => {
  const datos = req.body || {};
  const errorValidacion = validarPalet(datos);
  if (errorValidacion) return res.status(400).json({ error: errorValidacion });

  try {
    const hoja = await getPaletsSheet();
    const croquis = await leerCroquis(hoja);
    const ocupados = croquis.palets.filter(palet => palet.seccion === datos.seccion).length;
    if (ocupados >= 2) {
      return res.status(409).json({ error: 'Ese lugar ya tiene dos palets apilados.' });
    }
    const producto = await obtenerProducto(hoja.sheets, datos.productoFila);
    if (producto === undefined) {
      return res.status(404).json({ error: 'No se encontró el producto indicado.' });
    }

    const palet = {
      id: randomUUID(),
      seccion: datos.seccion.trim(),
      productoFila: datos.productoFila || null,
      cantidad: datos.cantidad,
      nota: datos.nota,
    };
    await hoja.sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: rangoHoja(hoja.titulo, `A:${columnaA1(hoja.ancho)}`),
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [filaCroquis(hoja.columnas, hoja.ancho, {
          id: palet.id,
          seccion: palet.seccion,
          producto: producto ? producto.articulo : '',
          cantidad: palet.cantidad,
          nota: palet.nota,
        })],
      },
    });
    res.status(201).json(palet);
  } catch (error) {
    console.error('Error al crear el palet:', error);
    res.status(500).json({ error: error.message || 'No se pudo crear el palet.' });
  }
});

app.put('/api/palets/:id', async (req, res) => {
  const datos = req.body || {};
  const errorValidacion = validarPalet(datos);
  if (errorValidacion) return res.status(400).json({ error: errorValidacion });

  try {
    const hoja = await getPaletsSheet();
    const croquis = await leerCroquis(hoja);
    const palet = croquis.palets.find(item => item.id === req.params.id);
    if (!palet) return res.status(404).json({ error: 'No se encontró el palet indicado.' });
    const ocupados = croquis.palets.filter(item =>
      item.seccion === datos.seccion && item.id !== palet.id
    ).length;
    if (ocupados >= 2) {
      return res.status(409).json({ error: 'El lugar elegido ya tiene dos palets apilados.' });
    }
    const producto = await obtenerProducto(hoja.sheets, datos.productoFila);
    if (producto === undefined) {
      return res.status(404).json({ error: 'No se encontró el producto indicado.' });
    }

    const filaExistente = await hoja.sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: rangoHoja(hoja.titulo, `A${palet.fila}:${columnaA1(hoja.ancho)}${palet.fila}`),
    });
    await hoja.sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: rangoHoja(hoja.titulo, `A${palet.fila}:${columnaA1(hoja.ancho)}${palet.fila}`),
      valueInputOption: 'RAW',
      requestBody: {
        values: [filaCroquis(hoja.columnas, hoja.ancho, {
          id: palet.id,
          seccion: datos.seccion.trim(),
          producto: producto ? producto.articulo : '',
          cantidad: datos.cantidad,
          nota: datos.nota,
        }, filaExistente.data.values && filaExistente.data.values[0])],
      },
    });
    res.json({ ...palet, ...datos, seccion: datos.seccion.trim(), productoFila: datos.productoFila || null });
  } catch (error) {
    console.error('Error al actualizar el palet:', error);
    res.status(500).json({ error: error.message || 'No se pudo guardar el palet.' });
  }
});

app.delete('/api/palets/:id', async (req, res) => {
  try {
    const hoja = await getPaletsSheet();
    const croquis = await leerCroquis(hoja);
    const palet = croquis.palets.find(item => item.id === req.params.id);
    if (!palet) return res.status(404).json({ error: 'No se encontró el palet indicado.' });

    await hoja.sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: { sheetId: hoja.sheetId, dimension: 'ROWS', startIndex: palet.fila - 1, endIndex: palet.fila },
          },
        }],
      },
    });
    res.status(204).end();
  } catch (error) {
    console.error('Error al quitar el palet:', error);
    res.status(500).json({ error: error.message || 'No se pudo quitar el palet.' });
  }
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: `No existe la ruta ${req.method} ${req.originalUrl}.` });
});

app.use(express.static('public'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`));