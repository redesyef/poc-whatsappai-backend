const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cors = require('cors');
const OpenAI = require('openai');
const { Server } = require('socket.io');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const http = require('http');
const { createServer } = require('node:http');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const app = express();
const port = 3000;
//const server = http.createServer(app);
const server = createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*', // Cambia '*' por el origen correcto si no es abierto
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

app.use(cors());
app.use(express.json()); // Para parsear el JSON en las solicitudes

let qrCode = null;
let isAuthenticated = false;

// Inicializa el cliente de WhatsApp
const client = new Client({
  authStrategy: new LocalAuth(),
});
io.on('connection', (socket) => {
  console.log('Cliente conectado:', socket.id);
  socket.emit('message', 'Bienvenido al servidor WebSocket!');
  // Envía el código QR al cliente si está disponible
  if (qrCode) {
    socket.emit('qr', { qrCode });
  }

  // Envía el estado de autenticación al conectar
  socket.emit('authenticated', isAuthenticated);

  // Desconexión del cliente
  socket.on('disconnect', () => {
    console.log('Cliente desconectado:', socket.id);
  });
});
// Inicializa OpenAI usando la variable de entorno
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
async function saveEmbedding(chat_id, embedding, usage, content) {
  const { data, error } = await supabase
    .from('messages')
    .insert([
      {
        chat_id,
        embedding,
        usage,
        content,
      },
    ])
    .select('*');

  if (error) {
    console.error('Error al guardar el embedding:', error);
  } else {
    console.log('Embedding guardado:', data);
  }
}
// Evento para manejar la generación del código QR
client.on('qr', (qr) => {
  qrcode.toDataURL(qr, (err, url) => {
    if (err) {
      console.error('Error al generar el código QR:', err);
    } else {
      qrCode = url;
      io.emit('qr', { qrCode });
    }
  });
});

// Evento para manejar la autenticación exitosa
client.on('authenticated', () => {
  console.log('Autenticación exitosa');
  qrCode = null;
  isAuthenticated = true;
  io.emit('authenticated', true);
});

// Evento para manejar la autenticación fallida
client.on('auth_failure', () => {
  console.log('Error de autenticación');
  isAuthenticated = false;
  io.emit('authenticated', false);
});

// Inicializa el cliente de WhatsApp
client.initialize();

// Endpoint para devolver el QR
app.get('/qr', (req, res) => {
  if (qrCode) {
    res.json({ qrCode, isAuthenticated });
    io.emit('authenticated', true);
  }
  if (isAuthenticated) {
    res.json({ isAuthenticated });
  } else {
    res.status(404).json({ message: 'QR no disponible o ya autenticado' });
  }
});
app.post('/logout', async (req, res) => {
  if (!isAuthenticated) {
    return res.status(400).json({ message: 'No hay una sesión activa.' });
  }

  try {
    await client.logout(); // Cerrar sesión
    isAuthenticated = false; // Actualizar el estado de autenticación
    qrCode = null; // Reiniciar el código QR
    io.emit('authenticated', false);
    // Reiniciar el cliente para que esté listo para una nueva autenticación
    client.initialize();

    res.json({ message: 'Sesión cerrada exitosamente. Cliente reiniciado.' });
  } catch (error) {
    console.error('Error al cerrar la sesión:', error);
    res
      .status(500)
      .json({ message: 'Error al cerrar la sesión.', error: error.message });
  }
});
// Endpoint para verificar si el cliente está autenticado
app.get('/status', (req, res) => {
  res.json({ authenticated: isAuthenticated });
});
app.get('/conversations', async (req, res) => {
  if (!isAuthenticated) {
    return res.status(401).json({ error: 'No autenticado' });
  }

  try {
    const chats = await client.getChats(); // Obtener todos los chats
    const recentConversations = chats.map((chat) => ({
      id: chat.id._serialized,
      name: chat.name || 'Desconocido',
      //lastMessage: chat.lastMessage ? chat.lastMessage : null, // Si no hay mensaje reciente
    }));

    if (recentConversations.length === 0) {
      return res.json({ message: 'No se encontraron conversaciones.' });
    } else {
      return res.json(recentConversations);
    }
  } catch (error) {
    console.error('Error al obtener las conversaciones:', error);
    return res.status(500).json({ error: error.message });
  }
});
// Endpoint para obtener mensajes de un chat específico
app.get('/messages/:chatId', async (req, res) => {
  if (!isAuthenticated) {
    return res.status(401).json({ error: 'No autenticado' });
  }

  const chatId = req.params.chatId;

  try {
    const chat = await client.getChatById(chatId); // Obtener el chat por ID
    const messages = await chat.fetchMessages({ limit: 10 }); // Obtener los últimos 10 mensajes

    const messageData = messages.map((message) => ({
      from: message.from,
      body: message.body,
      timestamp: message.timestamp,
    }));

    res.json({ chatId, messages: messageData });
  } catch (error) {
    console.error('Error al obtener mensajes:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Endpoint para generar embeddings de un chat específico
app.post('/generate-embedding/:chatId', async (req, res) => {
  if (!isAuthenticated) {
    return res.status(401).json({ error: 'No autenticado' });
  }

  const chatId = req.params.chatId;

  try {
    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 }); // Obtener los últimos 100 mensajes

    // Concatenar el cuerpo de los mensajes para crear un solo texto
    const concatenatedMessages = messages
      .map((message) => message.body)
      .join(' ');
    console.log(concatenatedMessages);
    //saveEmbedding(chatId, ['123,123'], [{ embedding: '5' }]);
    // Generar el embedding usando la API de OpenAI
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: concatenatedMessages,
      encoding_format: 'float',
    });
    console.log(embeddingResponse);

    // Aquí puedes guardar el embedding en Supabase si es necesario
    const embedding = embeddingResponse.data[0].embedding;
    const usage = embeddingResponse.usage;
    saveEmbedding(chatId, embedding, usage, concatenatedMessages);
    res.json({
      chatId,
    });
  } catch (error) {
    console.error('Error al generar el embedding:', error);
    return res.status(500).json({ error: error.message });
  }
});
// Endpoint para leer los embeddings de un chat y generar estadísticas
app.get('/chat-stats/:chatId', async (req, res) => {
  const chatId = req.params.chatId;

  try {
    // Recupera los embeddings almacenados en Supabase
    const { data, error } = await supabase
      .from('messages')
      .select('embedding, content')
      .eq('chat_id', decodeURIComponent(chatId));

    if (error) {
      throw new Error('Error al recuperar los embeddings:', error);
    }

    if (!data || data.length === 0) {
      return res
        .status(404)
        .json({ error: 'No se encontraron embeddings para este chat.' });
    }

    const embeddings = data.map((row) => row.embedding);
    const chatContent = data.map((row) => row.content).join(' ');

    const context = `Los siguientes embeddings fueron generados a partir de un chat de WhatsApp. Estos números representan la comprensión del contenido del chat. A continuación, te proporciono los embeddings:: ${JSON.stringify(
      embeddings
    )},Y aquí está la conversación original::${JSON.stringify(
      chatContent
    )} Por favor, analiza la información de la conversación y proporciona un análisis detallado creando un array de objetos que contenga título y descripción(nop incluyas testos exta al array de objetos),debes incluir, pero no limitarte a, lo siguiente:

Tema de conversación principal: Identifica el tema más relevante discutido en el chat.
Horarios picos: Determina las horas con la mayor cantidad de mensajes enviados y recibidos.
Tendencias de comunicación: Señala patrones importantes en la comunicación, como cambios en el tono o la emoción.
Participación: Indica quiénes son los participantes más activos en la conversación.
Sentimiento general: Analiza el sentimiento general de la conversación (positivo, negativo, neutral).
Entregame el análisis en formato JSON siempre entregando directamente el array con el objeto {'descripcion', 'titulo'} estructurado, fácil de interpretar y con valores cuantitativos importantes. `;
    // Usar OpenAI para analizar el contenido y generar estadísticas
    const analysisResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini', // Puedes usar el modelo más adecuado
      messages: [
        {
          role: 'system',
          content:
            'Te estoy pasando un chat de whatsapp y vas a ser un experto analizando la información de este chat',
        },
        {
          role: 'user',
          content: context,
        },
      ],
    });

    const analysis = analysisResponse.choices[0].message.content;

    // Respuesta con el análisis y las estadísticas
    res.json({
      chatId,
      analysis,
    });
  } catch (error) {
    console.error('Error al generar estadísticas del chat:', error);
    res.status(500).json({ error: error.message });
  }
});

// Inicia el servidor
server.listen(port, () => {
  console.log(`Servidor corriendo en http://localhost:${port}`);
});
