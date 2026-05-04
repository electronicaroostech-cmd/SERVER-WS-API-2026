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
const WC_BASE_URL = process.env.WC_BASE_URL;
const WC_CONSUMER_KEY = process.env.WC_CONSUMER_KEY;
const WC_CONSUMER_SECRET = process.env.WC_CONSUMER_SECRET;
const ROOSBOT_NAME = process.env.ROOSBOT_NAME || "ROOSbot";
const WC_SEARCH_LIMIT = Number(process.env.WC_SEARCH_LIMIT || 8);

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

function hasWooCredentials() {
  return Boolean(WC_BASE_URL && WC_CONSUMER_KEY && WC_CONSUMER_SECRET);
}

function normalizeSearchTerms(userQuery) {
  if (!userQuery) {
    return [];
  }

  const clean = userQuery
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const stopWords = new Set([
    "hola", "buenas", "tienen", "tienes", "hay", "me", "puedes", "puede", "quiero",
    "necesito", "busco", "el", "la", "los", "las", "de", "del", "para", "con", "y",
    "por", "favor", "precio", "cuesta", "cuanto", "cuanto", "disponible", "stock", "un", "una"
  ]);

  const words = clean.split(" ").filter((word) => word.length >= 3 && !stopWords.has(word));
  const uniqueWords = [...new Set(words)];

  const terms = [];
  if (uniqueWords.length) {
    terms.push(uniqueWords.join(" "));
    uniqueWords.slice(0, 3).forEach((word) => terms.push(word));
  }

  if (!terms.length && clean) {
    terms.push(clean);
  }

  return [...new Set(terms)].slice(0, 4);
}

function mapWooProduct(product) {
  return {
    name: product.name,
    price: product.price,
    currency: product.currency,
    shortDescription: (product.short_description || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    url: product.permalink,
    stockStatus: product.stock_status,
    categories: (product.categories || []).map((category) => category.name).join(", "),
  };
}

async function queryWooProducts(baseUrl, searchTerm) {
  const response = await axios.get(`${baseUrl}/wp-json/wc/v3/products`, {
    auth: {
      username: WC_CONSUMER_KEY,
      password: WC_CONSUMER_SECRET,
    },
    params: {
      per_page: WC_SEARCH_LIMIT,
      status: "publish",
      search: searchTerm || undefined,
      orderby: "date",
      order: "desc",
    },
    timeout: 10000,
  });

  return (response.data || []).map(mapWooProduct);
}

async function fetchWooProducts(userQuery) {
  if (!hasWooCredentials()) {
    console.error("WooCommerce no configurado: faltan WC_BASE_URL, WC_CONSUMER_KEY o WC_CONSUMER_SECRET");
    return [];
  }

  try {
    const baseUrl = WC_BASE_URL.replace(/\/$/, "");

    const terms = normalizeSearchTerms(userQuery);
    for (const term of terms) {
      const products = await queryWooProducts(baseUrl, term);
      if (products.length) {
        return products;
      }
    }

    // Fallback: si no hubo match por texto, devuelve catalogo reciente para recomendar alternativas reales.
    return await queryWooProducts(baseUrl, "");
  } catch (error) {
    console.error("Error consultando WooCommerce:", error.response?.status, error.response?.data || error.message);
    return [];
  }
}

function buildRoosbotPrompt(userMessage, products) {
  const productsBlock = products.length
    ? products
        .map(
          (product, index) =>
            `${index + 1}. ${product.name} | Precio: ${product.price || "N/D"} ${product.currency || ""} | Stock: ${product.stockStatus || "N/D"} | Categorias: ${product.categories || "N/D"} | Link: ${product.url || "N/D"} | Descripcion: ${product.shortDescription || "N/D"}`
        )
        .join("\n")
    : "No hay productos coincidentes en este momento o WooCommerce no esta configurado.";

  return [
    `Eres ${ROOSBOT_NAME}, asistente comercial de Roostech por WhatsApp.`,
    "Responde en espanol natural, cercano y profesional, como una persona real.",
    "Objetivo: atender consultas, recomendar la mejor opcion segun la necesidad del cliente y cerrar venta sin sonar robotico.",
    "Reglas:",
    "- Respuestas cortas, utiles y claras para WhatsApp.",
    "- Si recomiendas productos, menciona 1 a 3 opciones maximo y por que convienen.",
    "- Si falta informacion, haz una pregunta breve para afinar recomendacion.",
    "- No inventes precios, stock ni enlaces. Usa solo la data disponible.",
    "- Si no hay productos para esa consulta, dilo con honestidad y ofrece alternativa.",
    "",
    "Catalogo WooCommerce disponible:",
    productsBlock,
    "",
    `Consulta del cliente: ${userMessage}`,
    "",
    "Genera una unica respuesta final lista para enviar por WhatsApp.",
  ].join("\n");
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
      const products = await fetchWooProducts(msgText);
      const prompt = buildRoosbotPrompt(msgText || "", products);
      const aiResponse = await generateAiText(prompt);

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
