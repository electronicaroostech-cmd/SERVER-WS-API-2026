const express = require("express");
const axios = require("axios"); // Importante para enviar la respuesta
const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

app.post("/webhook", async (req, res) => {
  const entry = req.body.entry?.[0];
  const changes = entry?.changes?.[0];
  const message = changes?.value?.messages?.[0];

  if (message) {
    const from = message.from; // El número que te escribió
    const msgText = message.text?.body; // Lo que te escribió

    console.log(`Respondiendo a ${from}...`);

    try {
      // Petición a la API de Graph de Meta
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
      console.log("Respuesta enviada con éxito");
    } catch (error) {
      console.error("Error al enviar respuesta:", error.response?.data || error.message);
    }
  }

  res.sendStatus(200); // Siempre responde 200 a Meta para evitar reintentos
});

// Mantén tus rutas GET / y GET /webhook como están
app.listen(process.env.PORT || 3000, () => console.log("Servidor listo"));
