/**
 * TrueMark API — Cloudflare Workers + D1 + Workers AI
 * Version 6.0.0
 *
 * Database-first product identification and safety-information service.
 * IMPORTANT: catalogue matches are not proof of physical authenticity.
 * NAFDAC and SON are shown as unconnected unless an authorised API is configured.
 */

const VERSION = '6.0.0';
const DEFAULT_ORIGIN = 'https://eddysparkle.github.io';
const AI_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const MAX_JSON_BYTES = 1_000_000;
const MAX_IMAGE_CHARS = 7_500_000;
const CACHE_SECONDS = 60 * 60 * 24;

const CATEGORIES = [
  'Food & groceries',
  'Drinks & beverages',
  'Health & medicines',
  'Medical devices',
  'Beauty & cosmetics',
  'Personal care',
  'Household products',
  'Electronics',
  'Baby & children',
  'Pet products',
  'Automotive',
  'Agriculture',
  'Apparel & accessories',
  'Other'
];

const CATALOGUES = [
  {
    key: 'open_food_facts',
    name: 'Open Food Facts',
    base: 'https://world.openfoodfacts.org',
    category: 'Food & groceries'
  },
  {
    key: 'open_beauty_facts',
    name: 'Open Beauty Facts',
    base: 'https://world.openbeautyfacts.org',
    category: 'Beauty & cosmetics'
  },
  {
    key: 'open_products_facts',
    name: 'Open Products Facts',
    base: 'https://world.openproductsfacts.org',
    category: 'Other'
  },
  {
    key: 'open_pet_food_facts',
    name: 'Open Pet Food Facts',
    base: 'https://world.openpetfoodfacts.org',
    category: 'Pet products'
  }
];

const OFFICIAL_SOURCES = [
  {
    key: 'nafdac',
    name: 'NAFDAC',
    type: 'official_regulator',
    url: 'https://nafdac.gov.ng/',
    integration: 'manual_or_authorised_api'
  },
  {
    key: 'son',
    name: 'Standards Organisation of Nigeria',
    type: 'official_regulator',
    url: 'https://son.gov.ng/',
    integration: 'manual_or_authorised_api'
  },
  {
    key: 'us_fda',
    name: 'United States FDA openFDA',
    type: 'official_regulator',
    url: 'https://open.fda.gov/apis/',
    integration: 'public_api'
  }
];

/* -------------------------------------------------------------------------- */
/* HTTP, CORS, validation and shared helpers                                  */
/* -------------------------------------------------------------------------- */

function getAllowedOrigins(env) {
  const raw = env.ALLOWED_ORIGINS || DEFAULT_ORIGIN;
  return raw.split(',').map((value) => value.trim()).filter(Boolean);
}

function corsHeaders(origin, env) {
  const allowed = getAllowedOrigins(env);
  const acceptedOrigin = origin && allowed.includes(origin) ? origin : allowed[0];

  return {
    'Access-Control-Allow-Origin': acceptedOrigin || DEFAULT_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-TrueMark-Admin-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers
    }
  });
}

function textResponse(message, status = 200, headers = {}) {
  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers
    }
  });
}

function clean(value, maxLength = 240) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLength);
}

function normalize(value) {
  return clean(value, 300)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isoNow() {
  return new Date().toISOString();
}

function plusHours(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function safeInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function errorMessage(error, fallback = 'The request could not be completed.') {
  return clean(error && error.message ? error.message : fallback, 300);
}

async function readJson(request, maximumBytes = MAX_JSON_BYTES) {
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > maximumBytes) {
    throw new Error('Request body is too large.');
  }

  const raw = await request.text();
  if (raw.length > maximumBytes) {
    throw new Error('Request body is too large.');
  }

  if (!raw.trim()) return {};

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Request body must contain valid JSON.');
  }
}

async function fetchJson(url, options = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(options.headers || {})
      }
    });

    const raw = await response.text();
    let data;

    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error('The connected source returned an unreadable response.');
    }

    if (!response.ok) {
      throw new Error(`External source returned HTTP ${response.status}.`);
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function requireDatabase(env) {
  if (!env.DB) {
    throw new Error('D1 binding DB is missing. Bind your truemark-db database using variable name DB.');
  }
  return env.DB;
}

function makeResult(status, title, message, sources = [], extra = {}) {
  return {
    success: true,
    status,
    title,
    message,
    sources,
    checked_at: isoNow(),
    disclaimer: 'A catalogue or registration-number match does not prove that the physical item is genuine. Check the seller, packaging, batch details and applicable official guidance.',
    ...extra
  };
}

function sourceInfo(name, url, type, retrievedAt = isoNow()) {
  return { name, url, type, retrieved_at: retrievedAt };
}

function safeJsonParse(value, fallback = {}) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/* -------------------------------------------------------------------------- */
/* D1 database operations                                                     */
/* -------------------------------------------------------------------------- */

async function getProductById(db, productId) {
  return db.prepare('SELECT * FROM products WHERE id = ? LIMIT 1')
    .bind(productId)
    .first();
}

async function getProductByBarcode(db, barcode) {
  return db.prepare(`
    SELECT p.*, i.identifier_value AS barcode, i.source AS identifier_source
    FROM product_identifiers i
    INNER JOIN products p ON p.id = i.product_id
    WHERE i.identifier_type = 'barcode'
      AND i.identifier_value = ?
    LIMIT 1
  `).bind(barcode).first();
}

async function searchProducts(db, query, limit = 15) {
  const term = normalize(query);
  if (term.length < 2) return [];

  const like = `%${term}%`;
  const result = await db.prepare(`
    SELECT p.*
    FROM products p
    WHERE p.normalized_name LIKE ?
       OR lower(COALESCE(p.brand, '')) LIKE ?
       OR lower(COALESCE(p.manufacturer, '')) LIKE ?
    ORDER BY p.updated_at DESC
    LIMIT ?
  `).bind(like, like, like, limit).all();

  return result.results || [];
}

async function upsertProduct(db, product, identifiers = [], source = null) {
  const productId = clean(product.id || crypto.randomUUID(), 80);
  const name = clean(product.name || product.product_name || 'Unknown product', 240);
  const timestamp = isoNow();

  await db.prepare(`
    INSERT INTO products (
      id, name, normalized_name, brand, manufacturer, category,
      description, image_url, country_of_origin, confidence,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      normalized_name = excluded.normalized_name,
      brand = excluded.brand,
      manufacturer = excluded.manufacturer,
      category = excluded.category,
      description = excluded.description,
      image_url = excluded.image_url,
      country_of_origin = excluded.country_of_origin,
      confidence = excluded.confidence,
      updated_at = excluded.updated_at
  `).bind(
    productId,
    name,
    normalize(name),
    clean(product.brand, 160),
    clean(product.manufacturer, 200),
    clean(product.category, 120),
    clean(product.description, 1800),
    clean(product.image_url, 1000),
    clean(product.country_of_origin, 120),
    clean(product.confidence || 'catalogue'),
    timestamp,
    timestamp
  ).run();

  for (const identifier of identifiers) {
    const value = clean(identifier.value, 140);
    const type = clean(identifier.type, 40);
    if (!value || !type) continue;

    await db.prepare(`
      INSERT INTO product_identifiers (
        id, product_id, identifier_type, identifier_value, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(identifier_type, identifier_value) DO UPDATE SET
        product_id = excluded.product_id,
        source = excluded.source
    `).bind(
      crypto.randomUUID(),
      productId,
      type,
      value,
      clean(identifier.source || 'TrueMark', 120),
      timestamp
    ).run();
  }

  if (source) {
    await recordProductSource(db, productId, source);
  }

  return getProductById(db, productId);
}

async function recordProductSource(db, productId, source) {
  await db.prepare(`
    INSERT INTO product_sources (
      id, product_id, source_key, source_name, source_url,
      source_type, retrieved_at, evidence_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_id, source_key) DO UPDATE SET
      source_name = excluded.source_name,
      source_url = excluded.source_url,
      source_type = excluded.source_type,
      retrieved_at = excluded.retrieved_at,
      evidence_json = excluded.evidence_json
  `).bind(
    crypto.randomUUID(),
    productId,
    clean(source.key || normalize(source.name).replace(/ /g, '_'), 100),
    clean(source.name, 160),
    clean(source.url, 1000),
    clean(source.type || 'public_catalogue', 60),
    isoNow(),
    JSON.stringify(source.evidence || {})
  ).run();
}

async function saveVerification(db, details) {
  const id = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO verification_history (
      id, product_id, product_name, barcode, category,
      status, source_summary_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    details.product_id || null,
    clean(details.product_name, 240),
    clean(details.barcode, 100),
    clean(details.category, 120),
    clean(details.status, 60),
        JSON.stringify(details.sources || []),
    isoNow()
  ).run();
  return id;
}

async function getCached(db, key) {
  const row = await db.prepare(`
    SELECT payload_json, expires_at
    FROM api_cache
    WHERE cache_key = ? AND expires_at > ?
    LIMIT 1
  `).bind(key, isoNow()).first();

  if (!row) return null;
  return safeJsonParse(row.payload_json, null);
}

async function putCached(db, key, payload, ttlHours = 24) {
  await db.prepare(`
    INSERT INTO api_cache (cache_key, payload_json, expires_at, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      payload_json = excluded.payload_json,
      expires_at = excluded.expires_at,
      created_at = excluded.created_at
  `).bind(key, JSON.stringify(payload), plusHours(ttlHours), isoNow()).run();
}

async function updateSourceStatus(db, sourceKey, status, error = '') {
  await db.prepare(`
    UPDATE source_registry
    SET last_status = ?, last_checked_at = ?, last_error = ?
    WHERE source_key = ?
  `).bind(status, isoNow(), clean(error, 300), sourceKey).run();
}

/* -------------------------------------------------------------------------- */
/* Public catalogue connectors                                                */
/* -------------------------------------------------------------------------- */

function catalogueProduct(source, raw, barcode) {
  return {
    name: raw.product_name || raw.product_name_en || raw.product_name_fr || '',
    brand: raw.brands || '',
    manufacturer: raw.manufacturing_places || '',
    category: raw.categories || source.category,
    description: raw.ingredients_text || raw.generic_name || '',
    image_url: raw.image_url || '',
    country_of_origin: raw.manufacturing_places || raw.countries || '',
    barcode,
    confidence: 'public_catalogue'
  };
}

async function lookupCatalogue(source, barcode) {
  const fields = [
    'code', 'product_name', 'product_name_en', 'product_name_fr',
    'brands', 'categories', 'quantity', 'image_url',
    'manufacturing_places', 'countries', 'ingredients_text', 'generic_name'
  ].join(',');

  const url = `${source.base}/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${fields}`;
  const data = await fetchJson(url, {}, 7500);

  if (data.status !== 1 || !data.product) return null;

  return {
    source,
    product: catalogueProduct(source, data.product, barcode),
    url: `${source.base}/product/${encodeURIComponent(barcode)}`
  };
}

async function lookupAllCatalogues(barcode) {
  const attempts = await Promise.allSettled(
    CATALOGUES.map((source) => lookupCatalogue(source, barcode))
  );

  return attempts
    .filter((item) => item.status === 'fulfilled' && item.value)
    .map((item) => item.value);
}

async function verifyBarcode(barcodeValue, env) {
  const barcode = clean(barcodeValue, 80);

  if (!/^[0-9A-Za-z-]{6,80}$/.test(barcode)) {
    return makeResult('needs_check', 'Barcode needs checking', 'Enter a valid barcode and try again.');
  }

  const db = requireDatabase(env);
  const existing = await getProductByBarcode(db, barcode);

  if (existing) {
    const sources = await getProductSources(db, existing.id);
    const result = makeResult(
      'catalogue_match',
      'Product found in TrueMark',
      'A previously indexed catalogue record matches this barcode. This does not authenticate the physical item.',
      sources,
      { product: existing, record_type: 'catalogue' }
    );
    await saveVerification(db, {
      product_id: existing.id,
      product_name: existing.name,
      barcode,
      category: existing.category,
      status: result.status,
      sources
    });
    return result;
  }

  const cached = await getCached(db, `barcode:${barcode}`);
  const matches = cached || await lookupAllCatalogues(barcode);

  if (!cached) {
    await putCached(db, `barcode:${barcode}`, matches, 12);
  }

  if (!matches.length) {
    const result = makeResult(
      'not_found',
      'No catalogue match found',
      'TrueMark could not find this barcode in the connected public catalogues. This does not mean the product is fake, unsafe or unregistered.'
    );
    await saveVerification(db, {
      product_name: '', barcode, category: '', status: result.status, sources: []
    });
    return result;
  }

  const first = matches[0];
  const product = await upsertProduct(
    db,
    first.product,
    [{ type: 'barcode', value: barcode, source: first.source.name }],
    {
      key: first.source.key,
      name: first.source.name,
      url: first.url,
      type: 'public_catalogue',
      evidence: { barcode }
    }
  );

  for (const match of matches.slice(1)) {
    await recordProductSource(db, product.id, {
      key: match.source.key,
      name: match.source.name,
      url: match.url,
      type: 'public_catalogue',
      evidence: { barcode }
    });
  }

  const sources = matches.map((match) => sourceInfo(
    match.source.name,
    match.url,
    'public_catalogue'
  ));

  const result = makeResult(
    'catalogue_match',
    'Product identified',
    'A public product catalogue contains a matching barcode. Regulatory approval, safety and physical authenticity have not been established.',
    sources,
    { product, record_type: 'catalogue' }
  );

  await saveVerification(db, {
    product_id: product.id,
    product_name: product.name,
    barcode,
    category: product.category,
    status: result.status,
    sources
  });

  return result;
}

async function getProductSources(db, productId) {
  const result = await db.prepare(`
    SELECT source_name AS name, source_url AS url,
           source_type AS type, retrieved_at
    FROM product_sources
    WHERE product_id = ?
    ORDER BY retrieved_at DESC
  `).bind(productId).all();
  return result.results || [];
}

/* -------------------------------------------------------------------------- */
/* Product search and catalogue persistence                                  */
/* -------------------------------------------------------------------------- */

async function searchProductsRoute(url, env) {
  const query = clean(url.searchParams.get('q'), 120);
  const limit = safeInteger(url.searchParams.get('limit'), 12, 1, 30);

  if (query.length < 2) {
    return jsonResponse({ success: true, products: [], message: 'Enter at least two characters.' });
  }

  const db = requireDatabase(env);
  const products = await searchProducts(db, query, limit);
  return jsonResponse({ success: true, products });
}

async function productDetailsRoute(productId, env) {
  const db = requireDatabase(env);
  const product = await getProductById(db, clean(productId, 100));

  if (!product) {
    return jsonResponse({ success: false, error: 'Product not found.' }, 404);
  }

  const [identifiers, sources, regulatory] = await Promise.all([
    db.prepare('SELECT identifier_type, identifier_value, source FROM product_identifiers WHERE product_id = ?')
      .bind(product.id).all(),
    getProductSources(db, product.id),
    db.prepare(`SELECT agency, jurisdiction, scheme, registration_number,
      status, source_url, source_type, evidence_json, checked_at
      FROM regulatory_records WHERE product_id = ? ORDER BY checked_at DESC LIMIT 20`)
      .bind(product.id).all()
  ]);

  return jsonResponse({
    success: true,
    product,
    identifiers: identifiers.results || [],
    sources,
    regulatory_records: (regulatory.results || []).map((row) => ({
      ...row,
      evidence: safeJsonParse(row.evidence_json, {})
    }))
  });
}

/* -------------------------------------------------------------------------- */
/* AI image recognition                                                       */
/* -------------------------------------------------------------------------- */

function decodeImageDataUrl(value) {
  const image = clean(value, MAX_IMAGE_CHARS);
  const match = image.match(/^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/i);

  if (!match) {
    throw new Error('Provide a JPEG, PNG or WebP image as a base64 data URL.');
  }

  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function extractJsonObject(value) {
  const raw = String(value || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');

  if (start < 0 || end <= start) return null;

  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function recognizeProduct(body, env) {
  if (!env.AI) {
    return jsonResponse({
      success: false,
      error: 'Workers AI binding AI is not configured.'
    }, 503);
  }

  let imageBytes;

  try {
    imageBytes = decodeImageDataUrl(body.image);
  } catch (error) {
    return jsonResponse({
      success: false,
      error: errorMessage(error)
    }, 400);
  }

  const prompt = [
    'You are assisting with consumer product identification for Nigeria and international markets.',
    'Inspect the supplied product image carefully.',
    'Extract only details that are clearly and visibly readable on the packaging.',
    '',
    'CRITICAL FIELD RULES:',
    '1. brand = the commercial brand or trade name only (e.g. Nixoderm).',
    '   NEVER use marketing words as brand: Perfumed, Medicated, Original, Premium, For skin problems, Herbal, Natural, Advanced, Formula.',
    '2. product_name = the main product title on the pack.',
    '3. strength_or_size = net content or strength only (e.g. 15g, 30ml, 5%, 2%).',
    '4. batch_number = only text labelled Batch, Lot, B.No, L.No, Batch No, Lot No.',
    '   Do NOT put size (15g) into batch_number.',
    '5. nafdac_number = any visible NAFDAC registration text.',
    '   Look for: NAFDAC REG NO, NAFDAC REG. No., NAFDAC No, NRN, A1-, A4-, B1-, B4-, 04- patterns.',
    '   Copy the number exactly as printed. Do not invent one.',
    '6. manufacturer = company name only if clearly labelled as manufacturer / manufactured by.',
    '7. expiry_date and manufacturing_date = only if dates are clearly readable.',
    '',
    'Return one JSON object with exactly these keys:',
    'product_name, brand, category, manufacturer, strength_or_size, barcode, nafdac_number, batch_number, manufacturing_date, expiry_date, country_of_origin, confidence, notes.',
    'Use empty strings for unreadable fields.',
    'confidence must be one of: high, medium, low.',
    'Never invent or guess numbers, dates, brands or manufacturers.',
    'Do not decide whether the item is genuine, safe, approved or counterfeit.',
    'This is identification assistance only.',
    'Return valid JSON without Markdown formatting.'
  ].join(' ');

  try {
    const response = await env.AI.run(AI_MODEL, {
      prompt: prompt,
      image: Array.from(imageBytes),
      max_tokens: 600
    });

    const raw = response.response || response.description || '';

    const product = extractJsonObject(raw) || {
      product_name: '',
      brand: '',
      category: '',
      manufacturer: '',
      strength_or_size: '',
      barcode: '',
      nafdac_number: '',
      batch_number: '',
      manufacturing_date: '',
      expiry_date: '',
      country_of_origin: '',
      confidence: 'low',
      notes: clean(raw, 1000)
    };

    return jsonResponse({
      success: true,
      recognized: true,
      product,
      disclaimer: 'AI may misread labels. Confirm every extracted detail against the physical packaging. Recognition is not authenticity verification.'
    });

  } catch (error) {
    console.error(
      'TrueMark AI recognition failed:',
      errorMessage(error)
    );

    return jsonResponse({
      success: false,
      error: 'Image recognition is temporarily unavailable.',
      detail: errorMessage(error)
    }, 502);
  }
}

/* -------------------------------------------------------------------------- */
/* Nigerian regulator integrations                                            */
/* -------------------------------------------------------------------------- */

async function configuredRegulatorCheck(body, env, config) {
  const registrationNumber = clean(
    body.registration_number || body.nafdac_number || body.son_number || body.number,
    120
  );

  if (!registrationNumber) {
    return makeResult(
      'needs_check',
      'Registration number required',
      'Enter the registration or certificate number shown on the product.'
    );
  }

  if (!env[config.urlVariable] || !env[config.keyVariable]) {
    return makeResult(
      'needs_check',
      `${config.name} live connection not configured`,
      `TrueMark does not currently have an authorised ${config.name} API connection. Check the number directly with the regulator. A number printed on packaging is not proof of registration.`,
      [sourceInfo(config.name, config.officialUrl, 'official_regulator')],
      { registration_number: registrationNumber, integration: 'not_configured' }
    );
  }

  try {
    const data = await fetchJson(env[config.urlVariable], {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env[config.keyVariable]}`
      },
      body: JSON.stringify({ registration_number: registrationNumber })
    }, 10000);

    const explicitlyValid = data.valid === true || data.status === 'valid';
    const explicitlyInvalid = data.valid === false || data.status === 'invalid';
    const status = explicitlyValid ? 'record_found' : explicitlyInvalid ? 'official_invalid' : 'needs_check';

    return makeResult(
      status,
      explicitlyValid ? 'Official record response found' : 'Official response needs review',
      clean(data.message || 'Review the returned official-source record and its scope.', 500),
      [sourceInfo(config.name, env[config.urlVariable], 'configured_official_api')],
      { registration_number: registrationNumber, record: data }
    );
  } catch (error) {
    return makeResult(
      'source_unavailable',
      `${config.name} source unavailable`,
      'The configured regulator service did not respond. Try again later.',
      [sourceInfo(config.name, config.officialUrl, 'official_regulator')],
      { detail: errorMessage(error) }
    );
  }
}

function normalizeNafdacNumber(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/NAFDAC(REG)?\.?(NO|NUMBER)?[:.]?/gi, '')
    .replace(/[^A-Z0-9\-]/g, '')
    .trim();
}

function isLikelyNafdacFormat(value) {
  const n = normalizeNafdacNumber(value);
  if (!n || n.length < 4 || n.length > 24) return false;
  return /^(?:[A-Z]\d{1,2}-)?\d{2,6}(?:-\d{1,6})?[A-Z]?$/.test(n) ||
         /^\d{2,8}$/.test(n);
}

async function verifyNAFDAC(body, env) {
  const raw =
    body?.nafdac_number ||
    body?.registration_number ||
    body?.number ||
    body?.certificate_number ||
    '';

  const nafdac = normalizeNafdacNumber(raw);

  if (!nafdac) {
    return jsonResponse({
      success: false,
      status: 'no_number',
      error: 'Provide a NAFDAC number.'
    }, 400);
  }

  // If you later get an authorised API, keep using it when configured
  if (env.NAFDAC_API_URL && env.NAFDAC_API_KEY) {
    return configuredRegulatorCheck(body, env, {
      name: 'NAFDAC',
      urlVariable: 'NAFDAC_API_URL',
      keyVariable: 'NAFDAC_API_KEY',
      officialUrl: 'https://registration.nafdac.gov.ng/'
    });
  }

  const format_valid = isLikelyNafdacFormat(nafdac);

  return jsonResponse({
    success: true,
    status: format_valid ? 'official_check_required' : 'format_uncertain',
    nafdac_number: nafdac,
    format_valid,
    title: format_valid
      ? 'NAFDAC number ready to check'
      : 'NAFDAC number needs review',
    message: format_valid
      ? 'TrueMark prepared this registration number for an official check. Confirm it on NAFDAC channels. A registration match does not prove the physical item is genuine.'
      : 'This value may not match a typical NAFDAC number format. Confirm the digits on the pack, then check on official NAFDAC channels.',
    official_links: {
      napams: 'https://registration.nafdac.gov.ng/',
      greenbook: 'https://greenbook.nafdac.gov.ng/'
    },
    how_to_check: [
      'Open NAPAMS → Verify Product',
      'Enter the number exactly as printed (often without spaces)',
      'Compare product name and manufacturer with the pack',
      'For medicines, also search Greenbook by number or product name'
    ],
    disclaimer:
      'TrueMark does not claim live automated access to NAFDAC private systems. Official confirmation is done on NAFDAC portals. Registration evidence is not pack authenticity certification.',
    checked_at: new Date().toISOString()
  });
}

async function verifySON(body, env) {
  return configuredRegulatorCheck(body, env, {
    name: 'SON',
    urlVariable: 'SON_API_URL',
    keyVariable: 'SON_API_KEY',
    officialUrl: 'https://son.gov.ng/'
  });
}

/* -------------------------------------------------------------------------- */
/* United States FDA openFDA connectors                                       */
/* -------------------------------------------------------------------------- */

function fdaApiKeyQuery(env) {
  return env.FDA_API_KEY ? `&api_key=${encodeURIComponent(env.FDA_API_KEY)}` : '';
}

async function lookupFdaNdc(value, env) {
  const query = clean(value, 100);
  if (!query) return [];

  const url = `https://api.fda.gov/drug/ndc.json?search=product_ndc:%22${encodeURIComponent(query)}%22&limit=10${fdaApiKeyQuery(env)}`;

  try {
    const data = await fetchJson(url, {}, 9000);
    return (data.results || []).map((item) => ({
      brand_name: item.brand_name || '',
      generic_name: item.generic_name || '',
      labeler_name: item.labeler_name || '',
      product_ndc: item.product_ndc || '',
      marketing_status: item.marketing_status || '',
      listing_expiration_date: item.listing_expiration_date || ''
    }));
  } catch {
    return [];
  }
}

async function lookupFdaRecalls(env, productTerm = '') {
  const term = clean(productTerm, 100);
  const search = term
    ? `&search=product_description:%22${encodeURIComponent(term)}%22`
    : '';
  const url = `https://api.fda.gov/drug/enforcement.json?limit=20${search}${fdaApiKeyQuery(env)}`;

  try {
    const data = await fetchJson(url, {}, 9000);
    return (data.results || []).map((item) => ({
      source: 'US FDA',
      product_name: item.product_description || '',
      reason: item.reason_for_recall || '',
      classification: item.classification || '',
      status: item.status || '',
      recall_date: item.recall_initiation_date || '',
      recalling_firm: item.recalling_firm || '',
      source_url: 'https://open.fda.gov/apis/drug/enforcement/'
    }));
  } catch {
    return [];
  }
}

async function verifyFdaNdc(body, env) {
  const ndc = clean(body.ndc || body.product_ndc || body.number || body.product_name || body.name, 100);
  if (!ndc) {
    return makeResult('needs_check', 'NDC required', 'Enter a US National Drug Code to search.');
  }

  const records = await lookupFdaNdc(ndc, env);
  const found = records.length > 0;

  return makeResult(
    found ? 'record_found' : 'needs_check',
    found ? 'FDA NDC listing found' : 'No matching NDC listing returned',
    found
      ? 'The FDA NDC database returned a listing. An NDC listing alone does not mean that FDA has approved the drug.'
      : 'No matching NDC listing was returned. This does not by itself establish that the product is counterfeit.',
    [sourceInfo('US FDA openFDA NDC', 'https://open.fda.gov/apis/drug/ndc/', 'official_regulator')],
    { records }
  );
}

/* -------------------------------------------------------------------------- */
/* General verification and history                                          */
/* -------------------------------------------------------------------------- */

async function verifyGeneral(body, env) {
  const barcode = clean(body.barcode || body.code, 80);
  if (barcode) return verifyBarcode(barcode, env);

  const category = clean(body.category || body.product_category, 120);
  const categoryLower = category.toLowerCase();
  const nafdacNumber = body.nafdac_number || body.registration_number;

  if (/medicine|drug|pharma|medical/.test(categoryLower) && nafdacNumber) {
    return verifyNAFDAC(body, env);
  }

  if (/food|drink|beverage|cosmetic|beauty|personal care/.test(categoryLower) && nafdacNumber) {
    return verifyNAFDAC(body, env);
  }

  const name = clean(body.product_name || body.name, 240);
  if (!name) {
    return makeResult(
      'needs_check',
      'Product information required',
      'Provide a product name, barcode or registration number.'
    );
  }

  const db = requireDatabase(env);
  const matches = await searchProducts(db, name, 10);

  if (!matches.length) {
    const result = makeResult(
      'not_found',
      'No matching product record',
      'TrueMark has no matching product in its current database. This is not proof that the product is fake.'
    );

    await saveVerification(db, {
      product_name: name,
      category,
      status: result.status,
      sources: []
    });

    return result;
  }

  const sources = [];
  for (const match of matches) {
    const productSources = await getProductSources(db, match.id);
    sources.push(...productSources);
  }

  const result = makeResult(
    'catalogue_match',
    'Possible product matches found',
    'These database records may match the supplied product. Compare the brand, packaging, manufacturer and identifiers carefully.',
    sources,
    { products: matches }
  );

  await saveVerification(db, {
    product_name: name,
    category,
    status: result.status,
    sources
  });

  return result;
}

/* -------------------------------------------------------------------------- */
/* Recall information                                                         */
/* -------------------------------------------------------------------------- */

async function recallsRoute(url, env) {
  const query = clean(url.searchParams.get('q'), 100);
  const recalls = await lookupFdaRecalls(env, query);

  return jsonResponse({
    success: true,
    source: 'US FDA openFDA',
    recalls,
    count: recalls.length,
    message: 'This endpoint currently checks US FDA drug enforcement recalls, not every product recall worldwide.'
  });
}

/* -------------------------------------------------------------------------- */
/* Source registry                                                            */
/* -------------------------------------------------------------------------- */

async function sourcesRoute(env) {
  const db = requireDatabase(env);

  const result = await db.prepare(`
    SELECT source_key, source_name, source_type, source_url,
           last_status, last_checked_at, last_error
    FROM source_registry
    ORDER BY source_name
  `).all();

  return jsonResponse({
    success: true,
    sources: result.results || [],
    additional_sources: OFFICIAL_SOURCES
  });
}

/* -------------------------------------------------------------------------- */
/* API request routing                                                        */
/* -------------------------------------------------------------------------- */

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  if (path === '/' && method === 'GET') {
    return jsonResponse({
      success: true,
      service: 'TrueMark API',
      version: VERSION,
      message: 'Product identification and safety-information API',
      endpoints: [
        'GET /health',
        'GET /categories',
        'GET /sources',
        'POST /recognize',
        'POST /verify',
        'POST /verify/nafdac',
        'POST /verify/son',
        'POST /verify/fda-ndc',
        'POST /verify/barcode',
        'GET /recalls',
        'GET /products/search?q=product',
        'GET /products/:id',
        'GET /admin/sync/status'
      ]
    });
  }

  if (path === '/health' && method === 'GET') {
    let database = 'not_configured';

    if (env.DB) {
      try {
        await env.DB.prepare('SELECT 1 AS ok').first();
        database = 'connected';
      } catch {
        database = 'error';
      }
    }

    return jsonResponse({
      success: database === 'connected',
      service: 'TrueMark API',
      version: VERSION,
      database,
      ai: env.AI ? 'configured' : 'not_configured',
      timestamp: isoNow()
    });
  }

  if (path === '/categories' && method === 'GET') {
    return jsonResponse({ success: true, categories: CATEGORIES });
  }

  if (path === '/sources' && method === 'GET') {
    return sourcesRoute(env);
  }

  
  


      
  if (path === '/recognize' && method === 'POST') {
    const body = await readJson(request, MAX_IMAGE_CHARS + 10000);
    return recognizeProduct(body, env);
  }

  if (path === '/verify' && method === 'POST') {
    const body = await readJson(request);
    const result = await verifyGeneral(body, env);
    return jsonResponse(result);
  }

  if (path === '/verify/nafdac' && method === 'POST') {
    const body = await readJson(request);
    return jsonResponse(await verifyNAFDAC(body, env));
  }

  if (path === '/verify/son' && method === 'POST') {
    const body = await readJson(request);
    return jsonResponse(await verifySON(body, env));
  }

  if (path === '/verify/fda-ndc' && method === 'POST') {
    const body = await readJson(request);
    return jsonResponse(await verifyFdaNdc(body, env));
  }

  if (path === '/verify/barcode' && method === 'POST') {
    const body = await readJson(request);
    return jsonResponse(await verifyBarcode(body.barcode || body.code, env));
  }

  if (path === '/recalls' && method === 'GET') {
    return recallsRoute(url, env);
  }

  if (path === '/products/search' && method === 'GET') {
    return searchProductsRoute(url, env);
  }

if (path.startsWith('/products/barcode/') && method === 'GET') {
  const barcode = decodeURIComponent(
    path.slice('/products/barcode/'.length)
  );
  return jsonResponse(await verifyBarcode(barcode, env));
}

  
  const productMatch = path.match(/^\/products\/([^/]+)$/);
  if (productMatch && method === 'GET') {
    return productDetailsRoute(decodeURIComponent(productMatch[1]), env);
  }

  if (path === '/admin/sync/status' && method === 'GET') {
    return jsonResponse({
      success: true,
      message: 'Automated regulator synchronisation is not configured.',
      sources: OFFICIAL_SOURCES
    });
  }

  return jsonResponse({
    success: false,
    error: 'Endpoint not found.',
    path
  }, 404);
}

/* -------------------------------------------------------------------------- */
/* Worker entry point                                                         */
/* -------------------------------------------------------------------------- */

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowedOrigins = getAllowedOrigins(env);

    if (origin && !allowedOrigins.includes(origin)) {
      return jsonResponse({
        success: false,
        error: 'Origin not authorised.'
      }, 403, corsHeaders(origin, env));
    }

    const headers = corsHeaders(origin, env);

    try {
      const response = await handleRequest(request, env);
      const mergedHeaders = new Headers(response.headers);

      for (const [key, value] of Object.entries(headers)) {
        mergedHeaders.set(key, value);
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: mergedHeaders
      });
    } catch (error) {
      const status = /valid JSON|too large|Provide a JPEG/i.test(errorMessage(error)) ? 400 : 500;

      return jsonResponse({
        success: false,
        error: errorMessage(error),
        service: 'TrueMark API',
        version: VERSION
      }, status, headers);
    }
  }
};

