const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

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
      await axios.post(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
        messaging_product: "whatsapp",
        to: from,
        type: "text",
        text: { body: `Ingeniero Anyelver, recibí tu mensaje: "${msgText}". El servidor está funcionando al 100%.` }
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
