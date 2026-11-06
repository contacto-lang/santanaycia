// worker.js — Santana & Cía Abogados
// Portal de pagos con Flow (https://www.flow.cl). El resto del sitio se sirve como archivos estáticos.
//
// Variables en Cloudflare (Workers → santanaycia → Settings → Variables and Secrets):
//   FLOW_API_KEY     (secreto)  — Flow → Integraciones → Credenciales
//   FLOW_SECRET_KEY  (secreto)  — Flow → Integraciones → Credenciales
//   FLOW_API_URL     (opcional) — https://www.flow.cl/api (producción, por defecto)
//                                  https://sandbox.flow.cl/api (pruebas, con credenciales de sandbox)
//
// Rutas:
//   POST /api/pagar               → crea la orden en Flow y devuelve la URL de pago
//   POST /api/flow/confirmacion   → Flow avisa el pago (servidor a servidor)
//   POST /api/flow/retorno        → Flow devuelve al cliente; se consulta el estado y se redirige a /pago-resultado

const MIN_AMOUNT = 350;          // mínimo que acepta Flow
const MAX_AMOUNT = 20_000_000;   // tope de seguridad para evitar errores de tipeo
const STATUS = { 1: 'pendiente', 2: 'pagado', 3: 'rechazado', 4: 'anulado' };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/pagar' && request.method === 'POST') return await crearPago(request, env, url);
      if (url.pathname === '/api/flow/confirmacion' && request.method === 'POST') return await confirmacion(request, env);
      if (url.pathname === '/api/flow/retorno') return await retorno(request, env);
      if (url.pathname.startsWith('/api/')) return json({ error: 'Ruta no encontrada' }, 404);
    } catch (err) {
      console.error('Error en', url.pathname, err && err.stack || err);
      if (url.pathname === '/api/flow/retorno') return Response.redirect(`${url.origin}/pago-resultado?estado=error`, 303);
      return json({ error: 'No pudimos iniciar el pago. Intente nuevamente o escríbanos por WhatsApp.' }, 500);
    }
    return env.ASSETS.fetch(request);
  },
};

// ───────────────────────── Flow ─────────────────────────
function apiBase(env) {
  return (env.FLOW_API_URL || 'https://www.flow.cl/api').replace(/\/+$/, '');
}

// Firma de Flow: claves ordenadas alfabéticamente, "clave"+"valor" concatenados, HMAC-SHA256 en hex
export async function firmar(params, secretKey) {
  const cadena = Object.keys(params).sort().map(k => k + params[k]).join('');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secretKey),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(cadena));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function credenciales(env) {
  if (!env.FLOW_API_KEY || !env.FLOW_SECRET_KEY) throw new Error('Faltan FLOW_API_KEY o FLOW_SECRET_KEY');
  return { apiKey: env.FLOW_API_KEY, secretKey: env.FLOW_SECRET_KEY };
}

async function flowPost(env, path, params) {
  const { apiKey, secretKey } = credenciales(env);
  const all = { apiKey, ...params };
  all.s = await firmar(all, secretKey);
  const res = await fetch(apiBase(env) + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
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

// ───────────────────────── Rutas ─────────────────────────
async function crearPago(request, env, url) {
  const b = await request.json().catch(() => null);
  if (!b) return json({ error: 'Solicitud inválida.' }, 400);

  const nombre = limpiar(b.nombre, 80);
  const email = limpiar(b.email, 120);
  const rut = limpiar(b.rut, 15);
  const codigo = limpiar(b.codigo, 20).toUpperCase().replace(/^#/, '');
  const concepto = limpiar(b.concepto, 60) || 'Honorarios';
  const monto = Math.round(Number(String(b.monto || '').replace(/[^\d]/g, '')));

  if (!nombre) return json({ error: 'Ingrese su nombre.' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Ingrese un correo válido.' }, 400);
  if (!Number.isFinite(monto) || monto < MIN_AMOUNT) return json({ error: `El monto mínimo es $${MIN_AMOUNT}.` }, 400);
  if (monto > MAX_AMOUNT) return json({ error: 'Para montos sobre $20.000.000 escríbanos y le enviamos un link de pago.' }, 400);
  if (!b.acepta) return json({ error: 'Debe aceptar los términos del pago.' }, 400);

  const orden = 'SC' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
  const subject = `${concepto}${codigo ? ' · #' + codigo : ''} — Santana & Cía Abogados`.slice(0, 120);
  const origin = url.origin; // el mismo dominio desde donde paga el cliente

  const data = await flowPost(env, '/payment/create', {
    commerceOrder: orden,
    subject,
    currency: 'CLP',
    amount: String(monto),
    email,
    paymentMethod: '9',
    urlConfirmation: `${origin}/api/flow/confirmacion`,
    urlReturn: `${origin}/api/flow/retorno`,
    optional: JSON.stringify({ nombre, rut: rut || '—', codigo: codigo ? '#' + codigo : '—', concepto }),
    timeout: '3600',
  });
  if (!data.url || !data.token) throw new Error('Respuesta inesperada de Flow: ' + JSON.stringify(data));
  console.log('Orden creada', orden, data.flowOrder, monto, concepto, codigo || '-');
  return json({ url: `${data.url}?token=${data.token}`, orden });
}

async function confirmacion(request, env) {
  const form = await request.formData().catch(() => null);
  const token = form && form.get('token');
  if (!token) return new Response('token requerido', { status: 400 });
  const st = await flowGet(env, '/payment/getStatus', { token: String(token) });
  console.log('Confirmación Flow', st.commerceOrder, st.flowOrder, STATUS[st.status] || st.status, st.amount, st.payer);
  return new Response('OK', { status: 200 });
}

async function retorno(request, env) {
  let token = new URL(request.url).searchParams.get('token');
  if (!token && request.method === 'POST') {
    const form = await request.formData().catch(() => null);
    token = form && form.get('token');
  }
  const origin = new URL(request.url).origin;
  if (!token) return Response.redirect(`${origin}/pago-resultado?estado=error`, 303);
  const st = await flowGet(env, '/payment/getStatus', { token: String(token) });
  const q = new URLSearchParams({
    estado: STATUS[st.status] || 'pendiente',
    orden: st.commerceOrder || '',
    monto: String(st.amount || ''),
  });
  return Response.redirect(`${origin}/pago-resultado?${q}`, 303);
}

// ───────────────────────── Utilidades ─────────────────────────
function limpiar(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
