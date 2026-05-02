const express = require("express");
const app = express();
app.use(express.json());

const VERIFY_TOKEN = "ANYELVER_PRO_2026";

// Ruta raíz para confirmar que el servidor vive
app.get("/", (req, res) => {
  res.send("Servidor de Anyelver activo y listo");
});

// Ruta de validación mejorada
app.get("/webhook", (req, res) => {
  console.log("--- INTENTO DE VALIDACIÓN RECIBIDO ---");
  console.log("Query Params:", req.query);

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("¡VALIDACIÓN EXITOSA!");
    return res.status(200).send(challenge);
  }

  console.log("Fallo en la validación: Token o modo incorrecto");
  res.sendStatus(403);
});

app.post("/webhook", (req, res) => {
  console.log("--- MENSAJE RECIBIDO ---");
  console.log(JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
