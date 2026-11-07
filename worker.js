// worker.js — Santana & Cía Abogados
// Cobros personalizados con Flow (https://www.flow.cl). El resto del sitio se sirve como archivos estáticos.
//
// Cómo funciona:
//   1. El abogado entra a /cobros (protegido con contraseña) y genera un enlace con el nombre del
//      cliente, su correo, el caso, el código, el concepto y el monto.
//   2. El enlace va cifrado y autenticado (AES-GCM): no se pueden leer sus datos y, si alguien lo
//      modifica, deja de funcionar.
//   3. El cliente abre /pagar?c=..., ve sus datos y el monto, y paga en Flow (Webpay).
//
// Secretos en Cloudflare (Workers → santanaycia → Settings → Variables and Secrets):
//   FLOW_API_KEY     — Flow → Integraciones → Credenciales
//   FLOW_SECRET_KEY  — Flow → Integraciones → Credenciales (también firma los enlaces de cobro)
//   ADMIN_KEY        — contraseña para generar cobros en /cobros
//   FLOW_API_URL     — opcional: https://sandbox.flow.cl/api para pruebas
//
// Rutas:
//   POST /api/cobro/crear        → (abogado) genera el enlace firmado
//   GET  /api/cobro/ver?c=...    → (cliente) datos del cobro para mostrar en /pagar
//   POST /api/cobro/pagar        → (cliente) crea la orden en Flow y devuelve la URL de pago
//   POST /api/flow/confirmacion  → Flow avisa el pago (servidor a servidor)
//   POST /api/flow/retorno       → Flow devuelve al cliente; se consulta el estado y se redirige a /pago-resultado

const MIN_AMOUNT = 350;          // mínimo que acepta Flow
const MAX_AMOUNT = 50_000_000;
const STATUS = { 1: 'pendiente', 2: 'pagado', 3: 'rechazado', 4: 'anulado' };
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I, igual que los códigos de consulta

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p === '/api/cobro/crear' && request.method === 'POST') return await crearCobro(request, env, url);
      if (p === '/api/cobro/ver' && request.method === 'GET') return await verCobro(env, url);
      if (p === '/api/cobro/pagar' && request.method === 'POST') return await pagarCobro(request, env, url);
      if (p === '/api/flow/confirmacion' && request.method === 'POST') return await confirmacion(request, env);
      if (p === '/api/flow/retorno') return await retorno(request, env, url);
      if (p.startsWith('/api/')) return json({ error: 'Ruta no encontrada' }, 404);
    } catch (err) {
      console.error('Error en', p, (err && err.stack) || err);
      if (p === '/api/flow/retorno') return Response.redirect(`${url.origin}/pago-resultado?estado=error`, 303);
      return json({ error: 'No pudimos procesar la solicitud. Intente nuevamente o escríbanos por WhatsApp.' }, 500);
    }
    return env.ASSETS.fetch(request);
  },
};

// ───────────────────────── Firma ─────────────────────────
const enc = new TextEncoder();
async function hmacRaw(keyBytes, data) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const b64u = b => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Firma de Flow: claves ordenadas alfabéticamente, "clave"+"valor" concatenados, HMAC-SHA256 en hex
export async function firmar(params, secretKey) {
  const cadena = Object.keys(params).sort().map(k => k + params[k]).join('');
  return hex(await hmacRaw(enc.encode(secretKey), cadena));
}

// Llave propia para los enlaces de cobro, derivada de la Secret Key de Flow
async function llaveCobros(env) {
  if (!env.FLOW_SECRET_KEY) throw new Error('Falta FLOW_SECRET_KEY');
  return hmacRaw(enc.encode(env.FLOW_SECRET_KEY), 'santanaycia-cobros-v1');
}
async function llaveAes(env) {
  return crypto.subtle.importKey('raw', await llaveCobros(env), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
// El enlace va cifrado y autenticado (AES-GCM): nadie puede leer ni modificar sus datos
export async function firmarCobro(datos, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await llaveAes(env), enc.encode(JSON.stringify(datos))));
  const out = new Uint8Array(iv.length + ct.length); out.set(iv); out.set(ct, iv.length);
  return b64u(out);
}
async function leerCobro(token, env) {
  let d;
  try {
    const raw = Uint8Array.from(atob(String(token || '').replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    if (raw.length < 29) return { error: 'invalido' };
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, await llaveAes(env), raw.slice(12));
    d = JSON.parse(new TextDecoder().decode(pt));
  } catch { return { error: 'invalido' }; }
  if (d.x && new Date(d.x + 'T23:59:59-03:00') < new Date()) return { error: 'vencido', datos: d };
  return { datos: d };
}
function iguales(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ───────────────────────── Flow ─────────────────────────
function apiBase(env) { return (env.FLOW_API_URL || 'https://www.flow.cl/api').replace(/\/+$/, ''); }
function credenciales(env) {
  if (!env.FLOW_API_KEY || !env.FLOW_SECRET_KEY) throw new Error('Faltan FLOW_API_KEY o FLOW_SECRET_KEY');
  return { apiKey: env.FLOW_API_KEY, secretKey: env.FLOW_SECRET_KEY };
}
async function flowPost(env, path, params) {
  const { apiKey, secretKey } = credenciales(env);
  const all = { apiKey, ...params };
  all.s = await firmar(all, secretKey);
  const res = await fetch(apiBase(env) + path, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(all).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Flow ${path} ${res.status}: ${JSON.stringify(data)}`);
  return data;
}
async function flowGet(env, path, params) {
  const { apiKey, secretKey } = credenciales(env);
  const all = { apiKey, ...params };
  all.s = await firmar(all, secretKey);
  const res = await fetch(apiBase(env) + path + '?' + new URLSearchParams(all).toString());
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Flow ${path} ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

// ───────────────────────── Cobros ─────────────────────────
async function crearCobro(request, env, url) {
  const b = await request.json().catch(() => null);
  if (!b) return json({ error: 'Solicitud inválida.' }, 400);
  if (!env.ADMIN_KEY) return json({ error: 'Falta configurar ADMIN_KEY en Cloudflare.' }, 500);
  // Comparación en tiempo constante de la contraseña
  const k = await llaveCobros(env);
  if (!iguales(hex(await hmacRaw(k, String(b.clave || ''))), hex(await hmacRaw(k, env.ADMIN_KEY)))) {
    return json({ error: 'Contraseña incorrecta.' }, 401);
  }

  const nombre = limpiar(b.nombre, 80);
  const email = limpiar(b.email, 120);
  const caso = limpiar(b.caso, 90);
  let codigo = limpiar(b.codigo, 12).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const concepto = limpiar(b.concepto, 60) || 'Honorarios';
  const monto = Math.round(Number(String(b.monto || '').replace(/[^\d]/g, '')));
  const dias = Math.min(Math.max(parseInt(b.dias, 10) || 30, 1), 180);

  if (!nombre) return json({ error: 'Falta el nombre del cliente.' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'El correo del cliente no es válido (Flow le envía el comprobante).' }, 400);
  if (!Number.isFinite(monto) || monto < MIN_AMOUNT || monto > MAX_AMOUNT) return json({ error: `El monto debe estar entre $${MIN_AMOUNT} y $${MAX_AMOUNT.toLocaleString('es-CL')}.` }, 400);
  if (!codigo) codigo = [...crypto.getRandomValues(new Uint8Array(5))].map(n => CODE_CHARS[n % 32]).join('');

  const expira = new Date(Date.now() + dias * 86400000 - 3 * 3600000).toISOString().slice(0, 10);
  const datos = { n: nombre, e: email, c: caso, k: codigo, t: concepto, m: monto, x: expira };
  const token = await firmarCobro(datos, env);
  console.log('Cobro creado', codigo, monto, concepto, caso || '-', 'vence', expira);
  return json({ link: `${url.origin}/pagar?c=${token}`, codigo, expira, monto });
}

async function verCobro(env, url) {
  const r = await leerCobro(url.searchParams.get('c'), env);
  if (r.error === 'invalido') return json({ error: 'invalido' }, 400);
  const d = r.datos;
  return json({
    estado: r.error === 'vencido' ? 'vencido' : 'vigente',
    nombre: d.n, caso: d.c || '', codigo: d.k, concepto: d.t, monto: d.m, expira: d.x,
  });
}

async function pagarCobro(request, env, url) {
  const b = await request.json().catch(() => null);
  const r = await leerCobro(b && b.c, env);
  if (r.error === 'invalido') return json({ error: 'Este enlace de pago no es válido. Pida uno nuevo al estudio.' }, 400);
  if (r.error === 'vencido') return json({ error: 'Este enlace de pago venció. Pida uno nuevo al estudio.' }, 400);
  const d = r.datos;

  const orden = `SC-${d.k}-${Date.now().toString(36).toUpperCase().slice(-5)}`;
  const subject = (d.t || 'Honorarios').slice(0, 120);
  // Filas extra del comprobante de Flow (sin repetir el concepto)
  const extras = { Cliente: d.n };
  if (d.c) extras.Caso = d.c;
  extras['Código'] = '#' + d.k;
  const data = await flowPost(env, '/payment/create', {
    commerceOrder: orden,
    subject,
    currency: 'CLP',
    amount: String(d.m),
    email: d.e,
    paymentMethod: '9',
    urlConfirmation: `${url.origin}/api/flow/confirmacion`,
    urlReturn: `${url.origin}/api/flow/retorno`,
    optional: JSON.stringify(extras),
    timeout: '3600',
  });
  if (!data.url || !data.token) throw new Error('Respuesta inesperada de Flow: ' + JSON.stringify(data));
  console.log('Orden creada', orden, data.flowOrder, d.m, d.k);
  return json({ url: `${data.url}?token=${data.token}` });
}

async function confirmacion(request, env) {
  const form = await request.formData().catch(() => null);
  const token = form && form.get('token');
  if (!token) return new Response('token requerido', { status: 400 });
  const st = await flowGet(env, '/payment/getStatus', { token: String(token) });
  console.log('Confirmación Flow', st.commerceOrder, st.flowOrder, STATUS[st.status] || st.status, st.amount, st.payer);
  return new Response('OK', { status: 200 });
}

async function retorno(request, env, url) {
  let token = url.searchParams.get('token');
  if (!token && request.method === 'POST') {
    const form = await request.formData().catch(() => null);
    token = form && form.get('token');
  }
  if (!token) return Response.redirect(`${url.origin}/pago-resultado?estado=error`, 303);
  const st = await flowGet(env, '/payment/getStatus', { token: String(token) });
  let extra = {};
  try { extra = typeof st.optional === 'string' ? JSON.parse(st.optional) : (st.optional || {}); } catch {}
  const q = new URLSearchParams({
    estado: STATUS[st.status] || 'pendiente',
    orden: st.commerceOrder || '',
    monto: String(st.amount || ''),
    caso: (extra.Caso || (extra.caso !== '—' && extra.caso) || ''),
    codigo: extra['Código'] || extra.codigo || '',
  });
  return Response.redirect(`${url.origin}/pago-resultado?${q}`, 303);
}

// ───────────────────────── Utilidades ─────────────────────────
function limpiar(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
