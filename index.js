const express = require("express");
const axios = require("axios"); // Importante para enviar la respuesta
const app = express();
app.use(express.json());

const VERIFY_TOKEN = "ANYELVER_PRO_2026";
const ACCESS_TOKEN = "EAALodUAV6RgBRSCGGUk1w6B0OZCZA2QSmhevoTixLVaQROcCLjw3FdTRk53QMFJcVrxZBCQKKj2lGgZC6fkbiEEFcGbeOMFlqVsJ3JK40A5eBoPnAOvpcZB09UZAaIUnXCzlEgFWhN9A1DJjSfZAsi50AgwVOzOmYi43EVXZBqzCX7Vz69LS5lyBYn1F26TpZAPnunAw7WqBw2u40YGyvpp6o6q5KAoEV4VpTBN0mbadhxrTtDPjDGlQxtdMYvlbg5J9qjDaaYMWghXEuEzTtIOGZAp2Dc"; // El que dura 24h
const PHONE_NUMBER_ID = "1066218519907665";

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
