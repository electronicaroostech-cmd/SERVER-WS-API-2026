const express = require("express");
const axios = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

async function generateAiText(prompt) {
  const candidateModels = [GEMINI_MODEL, "gemini-2.5-flash-lite", "gemini-2.5-flash"];
  let lastError;

  for (const modelName of candidateModels) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      const text = result.response?.text?.();

      if (text) {
        return text;
      }

      throw new Error("Gemini no devolvio texto");
    } catch (error) {
      lastError = error;
      console.error(`Modelo Gemini no disponible: ${modelName}`);
    }
  }

  throw lastError;
}

// 1. RUTA DE INICIO (Para que no salga "Cannot GET /")
app.get("/", (req, res) => {
  res.status(200).send("API de Roostech activa en Render.");
});

// 2. RUTA DE VERIFICACIÓN PARA META (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado correctamente.");
    return res.status(200).send(challenge);
  } else {
    console.error("❌ Fallo en la verificación del token.");
    return res.sendStatus(403);
  }
});

// 3. RUTA DE RECEPCIÓN DE MENSAJES (POST)
app.post("/webhook", async (req, res) => {
  const entry = req.body.entry?.[0];
  const changes = entry?.changes?.[0];
  const message = changes?.value?.messages?.[0];

  if (message) {
    const from = message.from;
    const msgText = message.text?.body;

    console.log(`📩 Mensaje de ${from}: ${msgText}`);

    try {
      const aiResponse = await generateAiText(msgText);

      await axios.post(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
        messaging_product: "whatsapp",
        to: from,
        type: "text",
        text: { body: aiResponse }
      }, {
        headers: { 
          'Authorization': `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json' 
        }
      });
      console.log("🚀 Respuesta enviada con éxito");
    } catch (error) {
      console.error("💥 Error al enviar:", error.response?.data || error.message);
    }
  }
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔥 Senior API lista en el puerto ${PORT}`));
