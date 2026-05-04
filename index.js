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
const MAX_OPTIONS = Number(process.env.ROOSBOT_MAX_OPTIONS || 3);

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const userState = new Map();

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

function mapWooProduct(product) {
  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
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

async function queryWooProducts(baseUrl, searchTerm, limit) {
  const response = await axios.get(`${baseUrl}/wp-json/wc/v3/products`, {
    auth: {
      username: WC_CONSUMER_KEY,
      password: WC_CONSUMER_SECRET,
    },
    params: {
      per_page: limit || WC_SEARCH_LIMIT,
      status: "publish",
      search: searchTerm || undefined,
      orderby: "date",
      order: "desc",
    },
    timeout: 10000,
  });

  return (response.data || []).map(mapWooProduct);
}

function cleanSearchQuery(userQuery) {
  const stopWords = new Set([
    // Saludos
    "hola", "buenas", "dias", "tardes", "noches", "saludos", "hey", "buen", "buenas",
    // Intenciones
    "tiene", "tienes", "tenes", "tienen", "venden", "vendes", "vende", "busco", "busca",
    "necesito", "necesita", "quiero", "quiere", "quisiera", "quisiero",
    "vender", "comprar", "conseguir", "obtener",
    // Dudas comerciales
    "precio", "costo", "valor", "cuanto", "vale", "cuesta", "cuestan",
    "disponible", "disponibles", "stock", "hay", "info", "informacion",
    "oferta", "descuento", "rebaja",
    // Conectores y artículos
    "el", "la", "los", "las", "un", "una", "unos", "unas",
    "de", "del", "al", "en", "por", "con", "sin", "para", "que", "y", "o",
    "me", "te", "le", "se", "nos", "puedes", "puede", "podrias", "favor",
    // Interrogativos
    "que", "cual", "cuales", "como", "donde", "cuando", "quien",
  ]);

  return (userQuery || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length >= 2 && !stopWords.has(w))
    .join(" ");
}

function scoreProduct(product, cleanedPhrase, keywords) {
  const titleNorm = (product.name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const broadHaystack = [product.sku, product.categories, product.shortDescription]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  let score = 0;

  // +50 si la frase completa aparece en el titulo
  if (cleanedPhrase && titleNorm.includes(cleanedPhrase)) {
    score += 50;
  }

  for (const kw of keywords) {
    // +15 por palabra en titulo
    if (titleNorm.includes(kw)) {
      score += 15;
    }
    // +5 por palabra en SKU / categoria / descripcion
    if (broadHaystack.includes(kw)) {
      score += 5;
    }
  }

  // -20 si el titulo tiene palabras de "bundle" que el usuario no pidio
  const bundleWords = ["kit", "caja", "case", "estuche"];
  const userWantedBundle = keywords.some((kw) => bundleWords.includes(kw));
  if (!userWantedBundle) {
    for (const bw of bundleWords) {
      if (titleNorm.includes(bw)) {
        score -= 20;
        break;
      }
    }
  }

  return score;
}

async function fetchWooProducts(userQuery) {
  if (!hasWooCredentials()) {
    console.error("WooCommerce no configurado: faltan WC_BASE_URL, WC_CONSUMER_KEY o WC_CONSUMER_SECRET");
    return [];
  }

  const cleanedPhrase = cleanSearchQuery(userQuery);

  if (!cleanedPhrase) {
    console.log("Query limpio vacio, sin busqueda.");
    return [];
  }

  const keywords = cleanedPhrase.split(" ").filter((w) => w.length >= 2);
  console.log(`Query limpio: "${cleanedPhrase}" | Keywords: [${keywords.join(", ")}]`);

  try {
    const baseUrl = WC_BASE_URL.replace(/\/$/, "");

    // Busqueda hibrida: frase completa limpia como termino, pool amplio de 30 productos
    const candidates = await queryWooProducts(baseUrl, cleanedPhrase, 30);
    console.log(`WooCommerce devolvio ${candidates.length} candidatos para: "${cleanedPhrase}"`);

    // Scoring
    const scored = candidates
      .map((p) => ({ product: p, score: scoreProduct(p, cleanedPhrase, keywords) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score);

    if (!scored.length) {
      console.log("Scoring: ningun producto supero 0 puntos.");
      return [];
    }

    console.log(
      `Top scoring: ${scored
        .slice(0, 5)
        .map((s) => `${s.product.name}(${s.score}pts)`)
        .join(" | ")}`
    );

    return scored.slice(0, MAX_OPTIONS).map((s) => s.product);
  } catch (error) {
    console.error("Error consultando WooCommerce:", error.response?.status, error.response?.data || error.message);
    return [];
  }
}

function initialUserState() {
  return {
    lastOptions: [],
    cart: [],
    lastQuery: "",
  };
}

function getUserState(phone) {
  if (!userState.has(phone)) {
    userState.set(phone, initialUserState());
  }
  return userState.get(phone);
}

function extractSelectionIndex(text) {
  if (!text) {
    return null;
  }

  const match = text.match(/\b([1-9])\b/);
  if (!match) {
    return null;
  }

  return Number(match[1]) - 1;
}

function isAddIntent(text) {
  if (!text) {
    return false;
  }

  const normalized = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  return /\b(agrega|agregar|anade|anadir|sumar|llevar|me\s+llevo|apartar|reservar)\b/.test(normalized);
}

function resolveProductFromSelection(text, options) {
  if (!options?.length) {
    return null;
  }

  const byIndex = extractSelectionIndex(text);
  if (byIndex !== null && options[byIndex]) {
    return options[byIndex];
  }

  const normalized = (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  return options.find((product) => {
    const productName = (product.name || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    return productName && normalized.includes(productName);
  }) || null;
}

function handleAddToCartIntent(userMessage, state) {
  if (!isAddIntent(userMessage)) {
    return null;
  }

  if (!state.lastOptions.length) {
    return "Perfecto, te ayudo con eso. Primero dime que producto quieres y te paso opciones para agregar.";
  }

  const selected = resolveProductFromSelection(userMessage, state.lastOptions);
  if (!selected) {
    return "Listo. Dime cual deseas agregar: 1, 2 o 3 segun la ultima recomendacion, o escribe el nombre del producto.";
  }

  state.cart.push({
    id: selected.id,
    name: selected.name,
    price: selected.price,
    currency: selected.currency,
    url: selected.url,
  });

  const cartPreview = state.cart
    .slice(-3)
    .map((item, index) => `${index + 1}. ${item.name} (${item.price || "N/D"} ${item.currency || ""})`)
    .join("\n");

  return [
    `Listo, agregue ${selected.name} a tu lista.`,
    "Tu lista actual:",
    cartPreview,
    "Si quieres, te ayudo a agregar otro o te paso el enlace directo para comprar.",
  ].join("\n");
}

function isListIntent(text) {
  if (!text) {
    return false;
  }

  const normalized = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  return /\b(lista|carrito|agregados|que\s+agregue|que\s+tengo)\b/.test(normalized);
}

function handleListIntent(state) {
  if (!state.cart.length) {
    return "Aun no tienes productos agregados. Si quieres, te recomiendo opciones segun tu proyecto.";
  }

  const lines = state.cart
    .map((item, index) => `${index + 1}. ${item.name} - ${item.price || "N/D"} ${item.currency || ""}`)
    .join("\n");

  return [
    "Esta es tu lista actual:",
    lines,
    "Si deseas, te ayudo a agregar otro producto.",
  ].join("\n");
}

function buildRoosbotPrompt(userMessage, products) {
  const topProducts = products.slice(0, MAX_OPTIONS);
  const hayProductos = topProducts.length > 0;

  const productsBlock = hayProductos
    ? topProducts
      .map(
        (product, index) =>
          `${index + 1}. ${product.name} | Precio: ${product.price || "N/D"} ${product.currency || ""} | Stock: ${product.stockStatus || "N/D"} | Link: ${product.url || "N/D"}`
      )
      .join("\n")
    : "CATALOGO VACIO: no se encontraron productos para esta consulta.";

  const instruccionProductos = hayProductos
    ? [
      "HAY PRODUCTOS DISPONIBLES. DEBES mostrarlos directamente.",
      "Formato obligatorio:",
      "- Una linea por producto: nombre, precio y link.",
      "- Maximo 2 lineas de texto tuyo (no preguntes el proyecto, no pidas mas datos).",
      "- Si el cliente pide uno especifico y esta en el catalogo, muestra ese primero.",
      "- Puedes cerrar con UNA frase de ayuda como 'Escribe *agregar 1* para apartar'.",
    ].join("\n")
    : [
      "NO hay productos que coincidan exactamente.",
      "Di claramente que no tenemos ese producto.",
      "Si el catalogo tiene productos relacionados, menciona 1 o 2 como alternativa real.",
      "No preguntes el proyecto. No inventes productos.",
    ].join("\n");

  return [
    `Eres ${ROOSBOT_NAME}, vendedor de Roostech en WhatsApp. Responde como persona real, directo y sin rodeos.`,
    "REGLAS ABSOLUTAS:",
    "- NO digas 'Hola' ni saludos en cada mensaje.",
    "- NO hagas preguntas sobre el proyecto del cliente si ya pidio un producto especifico.",
    "- NO inventes precios, stock ni links. Solo usa los datos del catalogo.",
    "- Tu respuesta es SOLO la introduccion: maximo 1 sola frase corta.",
    "- NO listes productos, NO incluyas precios, NO incluyas links. Los productos se muestran aparte automaticamente.",
    "",
    instruccionProductos,
    "",
    "Catalogo disponible (solo para contexto, NO lo repitas en tu respuesta):",
    productsBlock,
    "",
    `Mensaje del cliente: ${userMessage}`,
    "",
    "Escribe UNA sola frase de introduccion (ejemplo: 'Tenemos esto para ti:' o 'No tenemos ese exacto, pero mira estas opciones:'):",
  ].join("\n");
}

// --- ENVÍO DE MENSAJES WHATSAPP ---

async function sendTextMessage(to, text) {
  await axios.post(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text, preview_url: false }
  }, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" }
  });
}

async function sendInteractiveButtons(to, bodyText, buttons) {
  // WhatsApp: max 3 botones, titulo max 20 chars
  const safeButtons = buttons.slice(0, 3).map((btn) => ({
    type: "reply",
    reply: {
      id: btn.id,
      title: btn.title.slice(0, 20)
    }
  }));

  await axios.post(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: { buttons: safeButtons }
    }
  }, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" }
  });
}

async function sendProductsResponse(to, products, aiIntro) {
  if (!products.length) {
    return await sendTextMessage(to, aiIntro);
  }

  // Formato profesional del cuerpo
  const productLines = products.slice(0, MAX_OPTIONS).map((p, i) => {
    const precio = p.price ? `$${p.price}` : "Precio N/D";
    return `*${i + 1}. ${p.name}*\n💰 ${precio} ${p.currency || ""}\n🔗 ${p.url || ""}`;
  }).join("\n\n");

  const bodyText = `${aiIntro}\n\n${productLines}`;

  // Botones según cantidad de productos
  const buttons = [];
  if (products[0]) buttons.push({ id: "agregar_1", title: `Agregar opción 1` });
  if (products[1]) buttons.push({ id: "agregar_2", title: `Agregar opción 2` });
  if (products[2]) buttons.push({ id: "agregar_3", title: `Agregar opción 3` });

  // Si solo hay 1 producto, botones más naturales
  if (products.length === 1) {
    buttons.length = 0;
    buttons.push({ id: "agregar_1", title: "Apartar este" });
    buttons.push({ id: "buscar_otro", title: "Buscar otro" });
    buttons.push({ id: "ver_lista", title: "Ver mi lista" });
  } else {
    buttons.push({ id: "ver_lista", title: "Ver mi lista" });
  }

  try {
    await sendInteractiveButtons(to, bodyText.slice(0, 1024), buttons);
  } catch {
    // Fallback a texto plano si el interactive falla (ej. número no registrado en WA Business)
    await sendTextMessage(to, bodyText + "\n\nEscribe *agregar 1*, *agregar 2* o *ver lista*.");
  }
}

app.get("/", (req, res) => {
  res.status(200).send("API de Roostech activa en Render.");
});

// Endpoint de diagnostico: muestra que devuelve WooCommerce para un termino
app.get("/debug-products", async (req, res) => {
  const query = req.query.q || "";
  if (!hasWooCredentials()) {
    return res.status(500).json({ error: "WooCommerce no configurado" });
  }
  try {
    const baseUrl = WC_BASE_URL.replace(/\/$/, "");
    const products = await queryWooProducts(baseUrl, query);
    res.json({ query, total: products.length, products });
  } catch (error) {
    res.status(500).json({ error: error.message, details: error.response?.data });
  }
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token === VERIFY_TOKEN) {
    console.log("Webhook verificado correctamente.");
    return res.status(200).send(challenge);
  }

  console.error("Fallo en la verificacion del token.");
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  const entry = req.body.entry?.[0];
  const changes = entry?.changes?.[0];
  const message = changes?.value?.messages?.[0];

  if (message) {
    const from = message.from;
    const state = getUserState(from);

    // Detectar si es clic de botón interactivo
    const buttonReplyId = message.interactive?.button_reply?.id;
    const msgText = buttonReplyId || message.text?.body || "";

    console.log(`Mensaje de ${from}: ${msgText}`);

    try {
      // Manejar clics de botones nativos
      if (buttonReplyId) {
        if (buttonReplyId === "ver_lista") {
          await sendTextMessage(from, handleListIntent(state));
        } else if (buttonReplyId === "buscar_otro") {
          await sendTextMessage(from, "Claro, dime que producto necesitas.");
        } else if (buttonReplyId.startsWith("agregar_")) {
          const index = Number(buttonReplyId.replace("agregar_", "")) - 1;
          const selected = state.lastOptions[index];
          if (selected) {
            state.cart.push({ id: selected.id, name: selected.name, price: selected.price, currency: selected.currency, url: selected.url });
            const cartPreview = state.cart.map((item, i) => `${i + 1}. ${item.name} — $${item.price || "N/D"} ${item.currency || ""}`).join("\n");
            await sendTextMessage(from, `✅ *${selected.name}* apartado.\n\n*Tu lista:*\n${cartPreview}\n\nEscribe el nombre de otro producto o *ver lista* para ver todo.`);
          } else {
            await sendTextMessage(from, "No encontre esa opcion. Dime el producto que quieres y te lo busco.");
          }
        }
        return res.sendStatus(200);
      }

      // Flujo normal por texto
      const addReply = handleAddToCartIntent(msgText, state);
      if (addReply) {
        await sendTextMessage(from, addReply);
      } else if (isListIntent(msgText)) {
        await sendTextMessage(from, handleListIntent(state));
      } else {
        const products = await fetchWooProducts(msgText);
        console.log(`WooCommerce devolvio ${products.length} producto(s) para: "${msgText}"`);
        if (products.length) {
          console.log("Productos:", products.map((p) => p.name).join(" | "));
        }
        state.lastOptions = products.slice(0, MAX_OPTIONS);
        state.lastQuery = msgText;

        const prompt = buildRoosbotPrompt(msgText, products);
        const aiIntro = await generateAiText(prompt);
        await sendProductsResponse(from, state.lastOptions, aiIntro);
      }

      console.log("Respuesta enviada con exito");
    } catch (error) {
      const errData = error.response?.data;
      if (errData?.error?.code === 190) {
        console.error("TOKEN WHATSAPP EXPIRADO. Actualiza ACCESS_TOKEN en Render.");
      } else {
        console.error("Error al enviar:", errData || error.message);
      }
    }
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Senior API lista en el puerto ${PORT}`));
