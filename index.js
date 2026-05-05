const express = require("express");
const axios = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const WC_BASE_URL = process.env.WC_BASE_URL;
const WC_CONSUMER_KEY = process.env.WC_CONSUMER_KEY;
const WC_CONSUMER_SECRET = process.env.WC_CONSUMER_SECRET;
const ROOSBOT_NAME = process.env.ROOSBOT_NAME || "Roosbot";
const WC_SEARCH_LIMIT = Number(process.env.WC_SEARCH_LIMIT || 8);
const MAX_OPTIONS = Math.max(5, Number(process.env.ROOSBOT_MAX_OPTIONS || 5));
const WC_TIMEOUT_MS = Number(process.env.WC_TIMEOUT_MS || 6000);
const SEARCH_CACHE_TTL_MS = Number(process.env.SEARCH_CACHE_TTL_MS || 60000);
const MESSAGE_DEDUP_TTL_MS = Number(process.env.MESSAGE_DEDUP_TTL_MS || 120000);
const ENABLE_GEMINI_INTRO = process.env.ENABLE_GEMINI_INTRO === "true";
const WELCOME_IMAGE_URL = process.env.WELCOME_IMAGE_URL || "https://roostech.co/wp-content/uploads/2026/05/rosboot.jpeg";

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const userState = new Map();
const searchCache = new Map();
const processedMessageIds = new Map();

function isDuplicateInboundMessage(messageId) {
  if (!messageId) {
    return false;
  }

  const now = Date.now();
  for (const [id, ts] of processedMessageIds.entries()) {
    if (now - ts > MESSAGE_DEDUP_TTL_MS) {
      processedMessageIds.delete(id);
    }
  }

  if (processedMessageIds.has(messageId)) {
    return true;
  }

  processedMessageIds.set(messageId, now);
  return false;
}

async function generateAiText(prompt) {
  const candidateModels = [...new Set([GEMINI_MODEL, "gemini-2.5-flash", "gemini-2.5-flash-lite"])]
    .filter(Boolean);
  let lastError;
  const failedModels = [];

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
      failedModels.push(modelName);
    }
  }

  console.error(`Gemini fallo con modelos: ${failedModels.join(", ")}`);
  throw lastError;
}

async function generateAiIntroSafe(userMessage, products, isFirstTurn = false) {
  const esPrimerMensaje = Boolean(isFirstTurn);
  const fallbackIntro = esPrimerMensaje
    ? "Hola! Soy Roosbot, tu asistente de Roostech. Escribe el nombre del producto que necesitas."
    : products.length
      ? "Sí, Encontramos estas opciones para ti, Elije una :"
      : "No veo coincidencias exactas ahora mismo. intenta con otra palabra similar o mas general.";

  if (!ENABLE_GEMINI_INTRO) {
    return fallbackIntro;
  }

  try {
    const prompt = buildRoosbotPrompt(userMessage, products, esPrimerMensaje);
    return await generateAiText(prompt);
  } catch (error) {
    console.error("Fallo Gemini, usando intro por defecto:", error.message);
    return fallbackIntro;
  }
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
    imageUrl: product.images?.[0]?.src || null,
    shortDescription: (product.short_description || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    url: product.permalink,
    stockStatus: product.stock_status,
    categories: (product.categories || []).map((category) => category.name).join(", "),
  };
}

function isProductAvailable(product) {
  return product?.stockStatus !== "outofstock";
}

function normalizeText(value) {
  return (value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
    timeout: WC_TIMEOUT_MS,
  });

  return (response.data || []).map(mapWooProduct);
}

function getCachedSearch(cleanedPhrase) {
  const cached = searchCache.get(cleanedPhrase);
  if (!cached) {
    return null;
  }
  if (Date.now() - cached.ts > SEARCH_CACHE_TTL_MS) {
    searchCache.delete(cleanedPhrase);
    return null;
  }
  return cached.data;
}

function setCachedSearch(cleanedPhrase, data) {
  searchCache.set(cleanedPhrase, { ts: Date.now(), data });
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

  return normalizeText(userQuery)
    .trim()
    .split(" ")
    .filter((w) => w.length >= 2 && !stopWords.has(w))
    .join(" ");
}

function scoreProduct(product, cleanedPhrase, keywords) {
  const titleNorm = normalizeText(product.name);
  const skuNorm = normalizeText(product.sku);
  const catNorm = normalizeText(product.categories);
  const descNorm = normalizeText(product.shortDescription);
  const broadHaystack = `${skuNorm} ${catNorm} ${descNorm}`.trim();

  let score = 0;
  let titleHits = 0;
  let broadHits = 0;

  if (!titleNorm) {
    return 0;
  }

  // Señales fuertes de intención
  if (titleNorm === cleanedPhrase) {
    score += 120;
  }

  if (cleanedPhrase && titleNorm.includes(cleanedPhrase)) {
    score += 80;
  }

  for (const kw of keywords) {
    const wholeWord = new RegExp(`(^|\\s)${kw}(\\s|$)`);

    if (wholeWord.test(titleNorm)) {
      score += 18;
      titleHits += 1;
    } else if (titleNorm.includes(kw)) {
      score += 10;
      titleHits += 1;
    }

    if (skuNorm.includes(kw)) {
      score += 8;
      broadHits += 1;
    } else if (catNorm.includes(kw)) {
      score += 6;
      broadHits += 1;
    } else if (descNorm.includes(kw)) {
      score += 4;
      broadHits += 1;
    } else if (broadHaystack.includes(kw)) {
      score += 5;
      broadHits += 1;
    }
  }

  // Bonus si todas las keywords aparecen en titulo
  if (keywords.length > 1 && keywords.every((kw) => titleNorm.includes(kw))) {
    score += 35;
  }

  // Penalizar accesorios/combos si usuario no los pidió
  const bundleWords = ["kit", "caja", "case", "estuche"];
  const userWantedBundle = keywords.some((kw) => bundleWords.includes(kw));
  if (!userWantedBundle) {
    for (const bw of bundleWords) {
      if (titleNorm.includes(bw)) {
        score -= 35;
        break;
      }
    }
  }

  // Filtro mínimo de relevancia para evitar falsos positivos
  const hasStrongSignal = cleanedPhrase && titleNorm.includes(cleanedPhrase);
  const hasConsistentMatch = titleHits >= 2 || (titleHits >= 1 && broadHits >= 1);
  if (!hasStrongSignal && !hasConsistentMatch) {
    return 0;
  }

  return score;
}

function buildSearchTerms(cleanedPhrase, keywords) {
  const terms = new Set();
  terms.add(cleanedPhrase);

  // Bigrama para consultas largas (ej. "arduino uno smd" => "arduino uno")
  if (keywords.length >= 2) {
    terms.add(`${keywords[0]} ${keywords[1]}`);
  }

  // Keywords por longitud para capturar más candidatos sin ruido excesivo
  keywords
    .slice()
    .sort((a, b) => b.length - a.length)
    .forEach((kw) => terms.add(kw));

  return [...terms].filter(Boolean).slice(0, 6);
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

  const cached = getCachedSearch(cleanedPhrase);
  if (cached) {
    console.log(`Cache hit para: "${cleanedPhrase}"`);
    return cached;
  }

  const keywords = cleanedPhrase.split(" ").filter((w) => w.length >= 2);
  console.log(`Query limpio: "${cleanedPhrase}" | Keywords: [${keywords.join(", ")}]`);

  try {
    const baseUrl = WC_BASE_URL.replace(/\/$/, "");
    const searchTerms = buildSearchTerms(cleanedPhrase, keywords);
    const candidateMap = new Map();

    const responses = await Promise.allSettled(
      searchTerms.map((term) => queryWooProducts(baseUrl, term, 30))
    );

    for (const resp of responses) {
      if (resp.status !== "fulfilled") {
        continue;
      }
      for (const product of resp.value) {
        candidateMap.set(product.id, product);
      }
    }

    const candidates = [...candidateMap.values()];
    console.log(`WooCommerce devolvio ${candidates.length} candidatos unicos para: "${cleanedPhrase}"`);

    // Scoring y ordenamiento
    const scored = candidates
      .map((p) => ({ product: p, score: scoreProduct(p, cleanedPhrase, keywords) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => {
        const availabilityDiff = Number(isProductAvailable(b.product)) - Number(isProductAvailable(a.product));
        if (availabilityDiff !== 0) {
          return availabilityDiff;
        }
        return b.score - a.score;
      });

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

    const ranked = scored.slice(0, MAX_OPTIONS).map((s) => s.product);
    setCachedSearch(cleanedPhrase, ranked);
    return ranked;
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
    hasSentWelcome: false,
    awaitingQuantity: false,
    pendingProduct: null,
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
    return `Listo. Dime cual deseas agregar: 1 a ${MAX_OPTIONS} segun la ultima recomendacion, o escribe el nombre del producto.`;
  }

  if (!isProductAvailable(selected)) {
    const alternatives = state.lastOptions.filter((product) => product.id !== selected.id && isProductAvailable(product));
    const alternativesText = alternatives.length
      ? ` Te recomiendo: ${alternatives.slice(0, 3).map((product) => product.name).join(", ")}.`
      : " Ahora mismo no veo otra opcion disponible en esta busqueda.";
    return `${selected.name} no tiene stock disponible.${alternativesText}`;
  }

  state.cart.push({
    id: selected.id,
    name: selected.name,
    quantity: 1,
    price: selected.price,
    currency: selected.currency,
    url: selected.url,
  });

  const cartPreview = state.cart
    .slice(-3)
    .map((item, index) => `${index + 1}. ${item.name} x${item.quantity || 1} (${item.price || "N/D"} ${item.currency || ""})`)
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

  const lines = buildCartPreview(state);
  const totals = buildCartTotalsText(state);

  return [
    "Esta es tu lista actual:",
    lines,
    "",
    totals,
    "Si deseas, te ayudo a agregar otro producto.",
  ].join("\n");
}

function buildRoosbotPrompt(userMessage, products, isFirstTurn = false) {
  const topProducts = products.slice(0, MAX_OPTIONS);
  const hayProductos = topProducts.length > 0;
  const esPrimerMensaje = Boolean(isFirstTurn);

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

    const reglaSaludo = esPrimerMensaje
      ? `- Es el PRIMER mensaje del usuario: inicia con una frase tipo 'Soy ${ROOSBOT_NAME}, tu asistente de Roostech.' y luego guia al cliente de forma breve.`
      : "- NO incluyas saludos. El usuario ya conoce el bot. Ve directo al punto.";

  return [
    `Eres ${ROOSBOT_NAME}, vendedor de Roostech en WhatsApp. Responde como persona real, directo y sin rodeos.`,
    "REGLAS ABSOLUTAS:",
      reglaSaludo,
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
    `Escribe UNA sola frase de introduccion. Si es el primer mensaje, usa un tono como: 'Soy ${ROOSBOT_NAME}, tu asistente de Roostech. Escribe el nombre del producto que necesitas.'`,
  ].join("\n");
}

// --- ENVÍO DE MENSAJES WHATSAPP ---

async function sendTextMessage(to, text, contextMessageId = null) {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text, preview_url: false }
  };

  if (contextMessageId) {
    payload.context = { message_id: contextMessageId };
  }

  const response = await axios.post(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, payload, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" }
  });

  return response.data?.messages?.[0]?.id || null;
}

async function sendImageMessage(to, imageUrl, caption = "", contextMessageId = null) {
  if (!imageUrl) return null;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: { link: imageUrl, caption: caption.slice(0, 1024) }
  };

  if (contextMessageId) {
    payload.context = { message_id: contextMessageId };
  }

  const response = await axios.post(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, payload, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" }
  });

  return response.data?.messages?.[0]?.id || null;
}

function buildSelectionConfirmationText(selected, cartPreview) {
  return [
    `Esta fue tu seleccion: ${selected.name}`,
    "",
    `✅ ${selected.name} x${selected.quantity || 1} agregado!.`,
    "",
    "Así va tu lista!:",
    cartPreview,
  ].join("\n");
}

function parsePriceNumber(value) {
  if (value === null || value === undefined || value === "") {
    return 0;
  }

  let raw = String(value).trim().replace(/[^\d,.-]/g, "");
  if (!raw) {
    return 0;
  }

  const commaPos = raw.lastIndexOf(",");
  const dotPos = raw.lastIndexOf(".");

  if (commaPos !== -1 && dotPos !== -1) {
    if (commaPos > dotPos) {
      raw = raw.replace(/\./g, "").replace(",", ".");
    } else {
      raw = raw.replace(/,/g, "");
    }
  } else if (commaPos !== -1) {
    raw = raw.replace(",", ".");
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatMoney(value) {
  const amount = Number(value) || 0;
  return amount.toFixed(2).replace(/\.00$/, "");
}

function trimAtWord(value, maxLen) {
  const text = String(value || "").trim();
  if (text.length <= maxLen) {
    return text;
  }

  const candidate = text.slice(0, maxLen);
  const lastSpace = candidate.lastIndexOf(" ");
  if (lastSpace > 8) {
    return candidate.slice(0, lastSpace).trim();
  }

  return candidate.trim();
}

function buildCatalogRow(product, index) {
  const fullName = (product.name || "Producto").replace(/\s+/g, " ").trim();
  const title = trimAtWord(fullName, 24);
  const remainingName = fullName.startsWith(title) ? fullName.slice(title.length).trim() : "";
  const priceText = (product.price ? `$${product.price} ${product.currency || ""}`.trim() : "Ver mas");
  const stockText = isProductAvailable(product) ? "Disponible" : "Sin stock";
  const descriptionBase = remainingName
    ? `${remainingName} | ${priceText} | ${stockText}`
    : `${priceText} | ${stockText}`;

  return {
    id: `select_${index + 1}`,
    title,
    description: descriptionBase.substring(0, 72),
  };
}

function buildCartPreview(state) {
  return state.cart
    .map((item, i) => {
      const qty = item.quantity || 1;
      const unitPrice = parsePriceNumber(item.price);
      const subtotal = unitPrice * qty;
      const currency = item.currency || "";
      const subtotalText = unitPrice > 0 ? ` | Subtotal: $${formatMoney(subtotal)} ${currency}` : "";
      return `${i + 1}. ${item.name} x${qty} — $${item.price || "N/D"} ${currency}${subtotalText}`;
    })
    .join("\n");
}

function buildCartTotalsText(state) {
  const totalsByCurrency = new Map();

  for (const item of state.cart) {
    const qty = item.quantity || 1;
    const unitPrice = parsePriceNumber(item.price);
    const subtotal = unitPrice * qty;
    const currency = item.currency || "";
    const current = totalsByCurrency.get(currency) || 0;
    totalsByCurrency.set(currency, current + subtotal);
  }

  const lines = [...totalsByCurrency.entries()]
    .filter(([, total]) => total > 0)
    .map(([currency, total]) => `Total: $${formatMoney(total)} ${currency}`.trim());

  return lines.length ? lines.join("\n") : "Total: N/D";
}

async function sendPostCartActions(to, contextMessageId = null) {
  const buttonsMessageId = await sendInteractiveButtons(to, "Que deseas hacer ahora?", [
    { id: "eliminar_ultimo", title: "Eliminar ultimo" },
    { id: "finalizar_compra", title: "Finalizar compra" },
  ], contextMessageId);
  await sendTextMessage(to, "O escribe el nombre de otro producto para seguir buscando.", buttonsMessageId);
}

async function sendOutOfStockRecommendation(to, state, selected) {
  const alternatives = state.lastOptions.filter((product) => product.id !== selected.id && isProductAvailable(product));

  if (!alternatives.length) {
    await sendTextMessage(to, `${selected.name} no tiene stock disponible ahora mismo. Escribe otro producto y te muestro opciones.`);
    return;
  }

  const intro = `${selected.name} no tiene stock disponible. Te recomiendo estas opciones que si tenemos:`;
  await sendInteractiveList(to, intro, alternatives.slice(0, MAX_OPTIONS));
}

function extractQuantity(text) {
  if (!text) {
    return null;
  }

  const match = String(text).match(/\b(\d{1,3})\b/);
  if (!match) {
    return null;
  }

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  return value;
}

async function finalizeProductSelectionWithQuantity(to, state, quantity) {
  const selected = state.pendingProduct;
  if (!selected) {
    state.awaitingQuantity = false;
    return sendTextMessage(to, "No encontre el producto pendiente. Elige uno de la lista nuevamente.");
  }

  const safeQty = Math.max(1, Math.min(999, Number(quantity) || 1));
  const cartItem = {
    id: selected.id,
    name: selected.name,
    quantity: safeQty,
    price: selected.price,
    currency: selected.currency,
    url: selected.url,
  };

  state.cart.push(cartItem);
  state.awaitingQuantity = false;
  state.pendingProduct = null;

  const cartPreview = buildCartPreview(state);
  const totals = buildCartTotalsText(state);
  const confirmationText = `${buildSelectionConfirmationText(cartItem, cartPreview)}\n\n${totals}`;

  let anchorMessageId = null;
  if (selected.imageUrl) {
    anchorMessageId = await sendImageMessage(to, selected.imageUrl, confirmationText.slice(0, 1024));
  } else {
    anchorMessageId = await sendTextMessage(to, confirmationText);
  }

  await sendPostCartActions(to, anchorMessageId);
}

async function sendInteractiveList(to, bodyText, products) {
  const rows = products.slice(0, 10).map((p, i) => buildCatalogRow(p, i));

  await axios.post(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: bodyText.substring(0, 1024) },
      action: {
        button: "Ver Catálogo",
        sections: [{ title: "Productos disponibles", rows }]
      }
    }
  }, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" }
  });
}

async function sendInteractiveButtons(to, bodyText, buttons, contextMessageId = null) {
  // WhatsApp: max 3 botones, titulo max 20 chars
  const safeButtons = buttons.slice(0, 3).map((btn) => ({
    type: "reply",
    reply: {
      id: btn.id,
      title: btn.title.slice(0, 20)
    }
  }));

  const interactivePayload = {
    type: "button",
    body: { text: bodyText },
    action: { buttons: safeButtons }
  };

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: interactivePayload
  };

  if (contextMessageId) {
    payload.context = { message_id: contextMessageId };
  }

  const response = await axios.post(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, payload, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" }
  });

  return response.data?.messages?.[0]?.id || null;
}

async function sendProductsResponse(to, products, aiIntro, showWelcomeImage = false) {
  if (!products.length) {
    if (showWelcomeImage && WELCOME_IMAGE_URL) {
      await sendImageMessage(to, WELCOME_IMAGE_URL, ROOSBOT_NAME).catch(() => {});
    }
    return await sendTextMessage(to, aiIntro);
  }

  try {
    if (showWelcomeImage && WELCOME_IMAGE_URL) {
      await sendImageMessage(to, WELCOME_IMAGE_URL, ROOSBOT_NAME).catch(() => {});
    }
    await sendInteractiveList(to, aiIntro, products);
  } catch (err) {
    console.error("sendInteractiveList fallo:", JSON.stringify(err.response?.data ?? err.message, null, 2));
    // Fallback a texto plano
    const fallback = products.slice(0, MAX_OPTIONS)
      .map((p, i) => `${i + 1}. *${p.name}* — ${p.price ? `$${p.price}` : "N/D"} ${p.currency || ""}\n${p.url || ""}`)
      .join("\n\n");
    await sendTextMessage(to, `${aiIntro}\n\n${fallback}\n\nEscribe *agregar 1* hasta *agregar ${MAX_OPTIONS}* o *ver lista*.`);
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
    const products = await queryWooProducts(baseUrl, query, 30);
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
    if (isDuplicateInboundMessage(message.id)) {
      console.log(`Mensaje duplicado ignorado: ${message.id}`);
      return res.sendStatus(200);
    }

    const from = message.from;
    const state = getUserState(from);

    // Detectar si es clic de botón o selección de lista
    const buttonReplyId = message.interactive?.button_reply?.id
      || message.interactive?.list_reply?.id;
    const msgText = buttonReplyId || message.text?.body || "";

    console.log(`Mensaje de ${from}: ${msgText}`);

    try {
      // Manejar clics de botones nativos y selecciones de lista
      if (buttonReplyId) {
        if (buttonReplyId === "ver_lista") {
          await sendTextMessage(from, handleListIntent(state));
        } else if (buttonReplyId === "buscar_otro") {
          await sendTextMessage(from, "Claro, dime que producto necesitas.");
        } else if (buttonReplyId === "eliminar_ultimo") {
          if (!state.cart.length) {
            await sendTextMessage(from, "Tu lista ya esta vacia. Dime que producto necesitas y te ayudo a elegir.");
          } else {
            const removed = state.cart.pop();
            if (!state.cart.length) {
              await sendTextMessage(from, `Elimine ${removed.name} de tu lista. Ahora no tienes productos agregados.`);
            } else {
              const totals = buildCartTotalsText(state);
              await sendTextMessage(
                from,
                `Elimine ${removed.name} de tu lista.\n\nEsta es tu lista actual:\n${buildCartPreview(state)}\n\n${totals}`
              );
              await sendPostCartActions(from);
            }
          }
        } else if (buttonReplyId === "finalizar_compra") {
          if (!state.cart.length) {
            await sendTextMessage(from, "Aun no tienes productos en la lista. Elige uno del catalogo y te ayudo a finalizar.");
          } else {
            const resumen = buildCartPreview(state);
            const totals = buildCartTotalsText(state);
            await sendTextMessage(
              from,
              `Perfecto, procedemos con tu compra.\n\nResumen de pedido:\n${resumen}\n\n${totals}\n\nComparte tu nombre y direccion para coordinar entrega y pago.`
            );
          }
        } else if (buttonReplyId === "qty_custom") {
          await sendTextMessage(from, "Perfecto. Escribe la cantidad que deseas (solo numero). Ejemplo: 4");
        } else if (buttonReplyId.startsWith("qty_")) {
          const quantity = Number(buttonReplyId.replace("qty_", ""));
          if (!state.awaitingQuantity || !state.pendingProduct) {
            await sendTextMessage(from, "No tengo un producto pendiente. Elige primero un producto del catalogo.");
          } else {
            await finalizeProductSelectionWithQuantity(from, state, quantity);
          }
        } else if (buttonReplyId.startsWith("agregar_") || buttonReplyId.startsWith("select_")) {
          const index = Number(buttonReplyId.replace("agregar_", "").replace("select_", "")) - 1;
          const selected = state.lastOptions[index];
          if (selected) {
            if (!isProductAvailable(selected)) {
              await sendOutOfStockRecommendation(from, state, selected);
              return res.sendStatus(200);
            }
            state.pendingProduct = selected;
            state.awaitingQuantity = true;
            await sendInteractiveButtons(from, `Elegiste: ${selected.name}\n\nQue cantidad deseas?`, [
              { id: "qty_1", title: "1 unidad" },
              { id: "qty_2", title: "2 unidades" },
              { id: "qty_custom", title: "Otra cantidad" },
            ]);
          } else {
            await sendTextMessage(from, "No encontre esa opcion. Dime el producto que quieres y te lo busco.");
          }
        }
        return res.sendStatus(200);
      }

      // Flujo normal por texto
      if (state.awaitingQuantity && state.pendingProduct) {
        const qty = extractQuantity(msgText);
        if (!qty) {
          await sendTextMessage(from, "No entendi la cantidad. Escribe solo un numero, por ejemplo: 3");
        } else {
          await finalizeProductSelectionWithQuantity(from, state, qty);
        }
      } else {
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

          const shouldSendWelcome = !state.hasSentWelcome;
          const aiIntro = await generateAiIntroSafe(msgText, products, shouldSendWelcome);
          await sendProductsResponse(from, state.lastOptions, aiIntro, shouldSendWelcome);
          if (shouldSendWelcome) {
            state.hasSentWelcome = true;
          }
        }
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
