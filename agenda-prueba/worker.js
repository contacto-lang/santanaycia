// Agenda propia (prueba) — Santana & Cía Abogados
// Muestra horarios libres del Google Calendar del abogado y crea la cita con enlace de Google Meet.
// Bindings: AGENDA (KV). Secretos: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.

const TZ = 'America/Santiago';
const CONFIG = {
  duracion: 30,                 // minutos por cita
  bloques: {                    // 1 = lunes … 5 = viernes; [inicio, fin] en hora de Chile
    1: [['09:00', '13:00'], ['15:00', '18:00']],
    2: [['09:00', '13:00'], ['15:00', '18:00']],
    3: [['09:00', '13:00'], ['15:00', '18:00']],
    4: [['09:00', '13:00'], ['15:00', '18:00']],
    5: [['09:00', '13:00'], ['15:00', '17:00']]
  },
  anticipacionHoras: 3,         // no se puede agendar con menos de esto
  diasHorizonte: 21,            // cuántos días hacia adelante se muestran
  calendario: 'primary',
  feriados: 'es.cl#holiday@group.v.calendar.google.com',
  titulo: 'Consulta legal',
  maxReservasPorHora: 4         // por IP
};
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.readonly'
].join(' ');

// ─── utilidades de fecha (hora de Chile) ─────────────────────────
function partesEn(fecha) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short' });
  const o = {}; for (const p of f.formatToParts(fecha)) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, min: +o.minute, s: +o.second, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday) };
}
// Fecha/hora local de Chile → instante UTC (maneja horario de verano)
function chileAUtc(y, m, d, h, min) {
  let t = Date.UTC(y, m - 1, d, h, min);
  for (let i = 0; i < 2; i++) {
    const p = partesEn(new Date(t));
    const local = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    t += Date.UTC(y, m - 1, d, h, min) - local;
  }
  return new Date(t);
}
const iso = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const ymd = p => `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;

// ─── Google OAuth ────────────────────────────────────────────────
async function tokenAcceso(env) {
  const cache = await env.AGENDA.get('access_token', 'json');
  if (cache && cache.exp > Date.now() + 60000) return cache.token;
  const refresh = await env.AGENDA.get('refresh_token');
  if (!refresh) throw new Error('sin_conexion');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refresh, grant_type: 'refresh_token' })
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('token: ' + (j.error || r.status));
  await env.AGENDA.put('access_token', JSON.stringify({ token: j.access_token, exp: Date.now() + j.expires_in * 1000 }), { expirationTtl: Math.max(60, j.expires_in - 60) });
  return j.access_token;
}
async function gcal(env, path, opts = {}) {
  const t = await tokenAcceso(env);
  const r = await fetch('https://www.googleapis.com/calendar/v3' + path, { ...opts, headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json', ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('gcal ' + r.status + ': ' + JSON.stringify(j.error || j).slice(0, 300));
  return j;
}

// ─── Disponibilidad ──────────────────────────────────────────────
async function disponibilidad(env) {
  const ahora = new Date();
  const limite = new Date(ahora.getTime() + CONFIG.anticipacionHoras * 3600e3);
  const hoy = partesEn(ahora);
  const desde = chileAUtc(hoy.y, hoy.m, hoy.d, 0, 0);
  const hasta = new Date(desde.getTime() + (CONFIG.diasHorizonte + 1) * 86400e3);

  const [fb, fer] = await Promise.all([
    gcal(env, '/freeBusy', { method: 'POST', body: JSON.stringify({ timeMin: iso(desde), timeMax: iso(hasta), timeZone: TZ, items: [{ id: CONFIG.calendario }] }) }),
    gcal(env, `/calendars/${encodeURIComponent(CONFIG.feriados)}/events?` + new URLSearchParams({ timeMin: iso(desde), timeMax: iso(hasta), singleEvents: 'true', maxResults: '100' })).catch(() => ({ items: [] }))
  ]);
  const ocupado = ((fb.calendars || {})[CONFIG.calendario] || {}).busy || [];
  const busy = ocupado.map(b => [Date.parse(b.start), Date.parse(b.end)]);
  // Solo feriados oficiales (no «celebraciones»)
  const feriados = new Set((fer.items || []).filter(e => e.start && e.start.date && !/celebraci|observance/i.test(e.description || '')).map(e => e.start.date));

  const dias = [];
  for (let i = 0; i <= CONFIG.diasHorizonte; i++) {
    const base = partesEn(new Date(desde.getTime() + i * 86400e3 + 12 * 3600e3));
    const fecha = ymd(base);
    const bloques = CONFIG.bloques[base.wd];
    if (!bloques || feriados.has(fecha)) continue;
    const horas = [];
    for (const [a, b] of bloques) {
      const [ah, am] = a.split(':').map(Number), [bh, bm] = b.split(':').map(Number);
      for (let t = ah * 60 + am; t + CONFIG.duracion <= bh * 60 + bm; t += CONFIG.duracion) {
        const ini = chileAUtc(base.y, base.m, base.d, Math.floor(t / 60), t % 60);
        const fin = new Date(ini.getTime() + CONFIG.duracion * 60e3);
        if (ini < limite) continue;
        if (busy.some(([s, e]) => ini.getTime() < e && fin.getTime() > s)) continue;
        horas.push({ inicio: iso(ini), hora: `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}` });
      }
    }
    if (horas.length) dias.push({ fecha, dow: base.wd, horas });
  }
  return { duracion: CONFIG.duracion, dias };
}

// ─── Reserva ─────────────────────────────────────────────────────
const correoOk = s => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s || '');
const limpio = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

async function reservar(env, req) {
  const b = await req.json().catch(() => ({}));
  if (b.web) return { ok: true }; // honeypot
  const nombre = limpio(b.nombre, 120), correo = limpio(b.correo, 160).toLowerCase(), telefono = limpio(b.telefono, 40);
  const materia = limpio(b.materia, 60), detalle = limpio(b.detalle, 1200);
  if (nombre.length < 3) return { ok: false, error: 'Ingresa tu nombre.' };
  if (!correoOk(correo)) return { ok: false, error: 'Revisa tu correo electrónico.' };
  if (!b.inicio) return { ok: false, error: 'Elige un horario.' };

  const ip = req.headers.get('cf-connecting-ip') || 'x';
  const k = 'rl:' + ip + ':' + new Date().toISOString().slice(0, 13);
  const n = +(await env.AGENDA.get(k) || 0);
  if (n >= CONFIG.maxReservasPorHora) return { ok: false, error: 'Demasiadas solicitudes. Intenta más tarde.' };

  const disp = await disponibilidad(env);
  const libre = disp.dias.some(d => d.horas.some(h => h.inicio === b.inicio));
  if (!libre) return { ok: false, error: 'Ese horario ya no está disponible. Elige otro.', ocupado: true };

  const ini = new Date(b.inicio), fin = new Date(ini.getTime() + CONFIG.duracion * 60e3);
  const ev = await gcal(env, `/calendars/${encodeURIComponent(CONFIG.calendario)}/events?conferenceDataVersion=1&sendUpdates=all`, {
    method: 'POST',
    body: JSON.stringify({
      summary: `${CONFIG.titulo} · ${nombre}`,
      description: [`Cita agendada desde la web.`, ``, `Nombre: ${nombre}`, `Correo: ${correo}`, telefono && `Teléfono: ${telefono}`, materia && `Materia: ${materia}`, detalle && `\nDetalle:\n${detalle}`].filter(Boolean).join('\n'),
      start: { dateTime: iso(ini), timeZone: TZ },
      end: { dateTime: iso(fin), timeZone: TZ },
      attendees: [{ email: correo, displayName: nombre }],
      conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      reminders: { useDefault: true },
      guestsCanModify: false, guestsCanInviteOthers: false
    })
  });
  await env.AGENDA.put(k, String(n + 1), { expirationTtl: 3700 });
  return { ok: true, inicio: iso(ini), meet: ev.hangoutLink || null };
}

// ─── Conexión con Google (una sola vez) ──────────────────────────
async function oauthInicio(env, url) {
  if (await env.AGENDA.get('refresh_token')) return new Response('La agenda ya está conectada.', { status: 403 });
  const state = crypto.randomUUID();
  await env.AGENDA.put('oauth_state:' + state, '1', { expirationTtl: 600 });
  const q = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: url.origin + '/oauth/callback', response_type: 'code', scope: SCOPES, access_type: 'offline', prompt: 'consent', state });
  return Response.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + q, 302);
}
async function oauthCallback(env, url) {
  const state = url.searchParams.get('state'), code = url.searchParams.get('code');
  if (!state || !(await env.AGENDA.get('oauth_state:' + state))) return pagina('Enlace vencido', '<p>Vuelve a abrir el enlace de conexión.</p>');
  await env.AGENDA.delete('oauth_state:' + state);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: url.origin + '/oauth/callback', grant_type: 'authorization_code' })
  });
  const j = await r.json();
  if (!j.refresh_token) return pagina('No se pudo conectar', `<p>Google no entregó la autorización (${limpio(j.error || r.status, 80)}). Intenta de nuevo.</p>`);
  await env.AGENDA.put('refresh_token', j.refresh_token);
  return pagina('Agenda conectada', '<p>Listo: la agenda quedó conectada a tu Google Calendar. Ya puedes cerrar esta pestaña y probar en <a href="/">la página de la agenda</a>.</p>');
}
function pagina(t, html) {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${t}</title><body style="font-family:system-ui;max-width:520px;margin:15vh auto;padding:0 20px;color:#14263a"><h1 style="font-weight:500">${t}</h1>${html}</body>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/' && req.method === 'GET') return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex' } });
      if (url.pathname === '/api/disponibilidad') return json(await disponibilidad(env));
      if (url.pathname === '/api/reservar' && req.method === 'POST') return json(await reservar(env, req));
      if (url.pathname === '/oauth/start') return oauthInicio(env, url);
      if (url.pathname === '/oauth/callback') return oauthCallback(env, url);
      if (url.pathname === '/api/estado') return json({ conectada: !!(await env.AGENDA.get('refresh_token')) });
      return new Response('No encontrado', { status: 404 });
    } catch (e) {
      console.error(e);
      if (String(e.message).includes('sin_conexion')) return json({ ok: false, error: 'La agenda aún no está conectada.' }, 503);
      return json({ ok: false, error: 'No pudimos procesar la solicitud. Intenta nuevamente.' }, 500);
    }
  }
};

const HTML = `<!doctype html>
<html lang="es-CL">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Agenda una consulta | Santana &amp; Cía Abogados</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root { --navy:#0e2740; --ink:#14263a; --muted:#5c7186; --celeste:#2f7fc4; --celeste-d:#1d5f99; --celeste-l:#e9f3fb; --border:rgba(16,31,51,.12); --bg:#f4f6f9; --white:#fff; --ok:#1f9d6b;
          --serif:'Cormorant Garamond', Georgia, serif; --sans:'Manrope', system-ui, -apple-system, sans-serif; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--ink); font-family:var(--sans); font-size:15px; line-height:1.6; min-height:100vh; display:flex; flex-direction:column; }
  .nav { background:#fff; border-bottom:1px solid var(--border); padding:18px 20px; text-align:center; }
  .logo { display:inline-block; font-family:var(--serif); font-size:19px; letter-spacing:.05em; line-height:1.2; color:var(--ink); text-decoration:none; }
  .logo span { display:block; font-family:var(--sans); font-size:9px; letter-spacing:.3em; text-transform:uppercase; color:var(--celeste); margin-top:2px; }
  main { flex:1; width:100%; max-width:760px; margin:0 auto; padding:36px 16px 48px; }
  .head { text-align:center; margin-bottom:26px; }
  .kicker { font-size:11px; font-weight:700; letter-spacing:.22em; text-transform:uppercase; color:var(--celeste); }
  h1 { font-family:var(--serif); font-weight:500; font-size:clamp(30px,5vw,40px); line-height:1.15; color:var(--navy); margin:8px 0 8px; }
  .sub { color:var(--muted); font-size:15px; }
  .meta { display:flex; justify-content:center; gap:18px; flex-wrap:wrap; margin-top:12px; font-size:13px; color:var(--muted); }
  .meta b { color:var(--ink); font-weight:600; }
  .card { background:#fff; border:1px solid var(--border); border-radius:14px; padding:22px; box-shadow:0 10px 30px -18px rgba(14,39,64,.25); }
  .paso { display:flex; align-items:center; gap:10px; font-size:12px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); margin:2px 0 12px; }
  .paso i { font-style:normal; width:22px; height:22px; border-radius:50%; background:var(--navy); color:#fff; display:grid; place-items:center; font-size:11px; letter-spacing:0; }
  .dias { display:flex; gap:8px; overflow-x:auto; padding-bottom:6px; scroll-snap-type:x mandatory; }
  .dia { flex:0 0 auto; scroll-snap-align:start; width:74px; border:1px solid var(--border); background:#fff; border-radius:10px; padding:10px 6px; text-align:center; cursor:pointer; font:inherit; color:inherit; transition:border-color .15s, background .15s; }
  .dia small { display:block; font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }
  .dia strong { display:block; font-size:22px; font-weight:600; line-height:1.2; }
  .dia em { display:block; font-style:normal; font-size:11px; color:var(--muted); }
  .dia:hover { border-color:var(--celeste); }
  .dia.sel { background:var(--navy); border-color:var(--navy); color:#fff; }
  .dia.sel small, .dia.sel em { color:rgba(255,255,255,.75); }
  .horas { display:grid; grid-template-columns:repeat(auto-fill,minmax(88px,1fr)); gap:8px; margin-top:18px; }
  .hora { border:1px solid var(--border); background:#fff; border-radius:8px; padding:10px 0; font:inherit; font-weight:600; color:var(--celeste-d); cursor:pointer; transition:all .15s; }
  .hora:hover { border-color:var(--celeste); background:var(--celeste-l); }
  .hora.sel { background:var(--celeste); border-color:var(--celeste); color:#fff; }
  .vacio { color:var(--muted); font-size:14px; padding:12px 0; }
  form { margin-top:22px; border-top:1px solid var(--border); padding-top:20px; display:none; }
  form.on { display:block; animation:fade .25s ease; }
  @keyframes fade { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
  .resumen { background:var(--celeste-l); border-radius:10px; padding:12px 14px; font-size:14px; margin-bottom:16px; }
  .resumen b { color:var(--navy); }
  .g2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  label { display:block; font-size:13px; font-weight:600; margin:0 0 5px; }
  .f { margin-bottom:12px; }
  input, select, textarea { width:100%; font:inherit; font-size:15px; color:var(--ink); border:1px solid var(--border); border-radius:8px; padding:11px 12px; background:#fff; outline:none; }
  input:focus, select:focus, textarea:focus { border-color:var(--celeste); box-shadow:0 0 0 3px rgba(47,127,196,.15); }
  textarea { min-height:84px; resize:vertical; }
  .opt { font-weight:400; color:var(--muted); }
  .hp { position:absolute; left:-9999px; }
  .btn { width:100%; border:0; border-radius:10px; background:var(--navy); color:#fff; font:inherit; font-weight:700; font-size:15px; padding:14px; cursor:pointer; margin-top:4px; }
  .btn:disabled { opacity:.6; cursor:wait; }
  .err { color:#b42318; font-size:14px; margin-top:10px; min-height:1em; }
  .nota { font-size:12.5px; color:var(--muted); margin-top:10px; text-align:center; }
  .ok { text-align:center; display:none; }
  .ok.on { display:block; animation:fade .3s ease; }
  .ok .check { width:56px; height:56px; border-radius:50%; background:rgba(31,157,107,.12); color:var(--ok); display:grid; place-items:center; margin:4px auto 12px; font-size:28px; }
  .ok h2 { font-family:var(--serif); font-weight:500; font-size:30px; color:var(--navy); }
  .ok .cuando { font-size:16px; margin:6px 0 16px; }
  .ok .meet { display:inline-flex; align-items:center; gap:8px; background:var(--celeste); color:#fff; text-decoration:none; font-weight:700; border-radius:10px; padding:12px 18px; }
  .cargando { color:var(--muted); font-size:14px; padding:6px 0; }
  footer { text-align:center; color:var(--muted); font-size:12.5px; padding:18px 16px 26px; }
  @media (max-width:560px) { .g2 { grid-template-columns:1fr; gap:0; } .card { padding:18px 14px; } main { padding-top:26px; } }
</style>
</head>
<body>
<header class="nav"><a class="logo" href="https://www.santanaycia.cl/">Santana &amp; Cía<span>Abogados</span></a></header>
<main>
  <div class="head">
    <div class="kicker">Agenda</div>
    <h1>Agenda una consulta</h1>
    <p class="sub">Elige el día y la hora. Te llegará la invitación con el enlace de Google Meet.</p>
    <div class="meta"><span>⏱ <b id="dur">30</b> minutos</span><span>🎥 Videollamada por Google Meet</span></div>
  </div>

  <section class="card" id="agenda">
    <div class="paso"><i>1</i> Elige el día</div>
    <div class="dias" id="dias"><div class="cargando">Cargando horarios disponibles…</div></div>
    <div class="paso" style="margin-top:20px"><i>2</i> Elige la hora</div>
    <div class="horas" id="horas"><div class="vacio">Selecciona un día.</div></div>

    <form id="form" autocomplete="on" novalidate>
      <div class="paso"><i>3</i> Tus datos</div>
      <div class="resumen" id="resumen"></div>
      <div class="g2">
        <div class="f"><label for="nombre">Nombre</label><input id="nombre" name="nombre" autocomplete="name" required></div>
        <div class="f"><label for="correo">Correo electrónico</label><input id="correo" name="correo" type="email" autocomplete="email" required></div>
      </div>
      <div class="g2">
        <div class="f"><label for="telefono">Teléfono <span class="opt">(opcional)</span></label><input id="telefono" name="telefono" type="tel" autocomplete="tel" placeholder="+56 9"></div>
        <div class="f"><label for="materia">Materia</label><select id="materia" name="materia"><option>Familia</option><option>Civil</option><option>Laboral</option><option>Penal</option><option>Comercial</option><option>Otra</option></select></div>
      </div>
      <div class="f"><label for="detalle">Cuéntanos brevemente tu caso <span class="opt">(opcional)</span></label><textarea id="detalle" name="detalle" maxlength="1200"></textarea></div>
      <input class="hp" name="web" tabindex="-1" autocomplete="off" aria-hidden="true">
      <button class="btn" id="btn" type="submit">Confirmar cita</button>
      <div class="err" id="err" role="alert"></div>
      <p class="nota">Al confirmar, la cita queda agendada y recibirás la invitación en tu correo.</p>
    </form>
  </section>

  <section class="card ok" id="ok">
    <div class="check">✓</div>
    <h2>¡Cita agendada!</h2>
    <p class="cuando" id="cuando"></p>
    <p class="sub" style="margin-bottom:16px">Te enviamos la invitación a <b id="okcorreo"></b>. Revisa también la carpeta de spam.</p>
    <a class="meet" id="meet" href="#" target="_blank" rel="noopener">🎥 Enlace de Google Meet</a>
  </section>
</main>
<footer>Santana &amp; Cía Abogados · <a href="https://www.santanaycia.cl/" style="color:inherit">santanaycia.cl</a></footer>
<script>
(function () {
  const $ = id => document.getElementById(id);
  const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const largo = s => new Date(s).toLocaleString('es-CL', { timeZone: 'America/Santiago', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  let data = null, dia = null, inicio = null;

  async function cargar() {
    try {
      const r = await fetch('/api/disponibilidad'); data = await r.json();
      if (!r.ok) throw new Error(data.error);
      $('dur').textContent = data.duracion;
      if (!data.dias.length) { $('dias').innerHTML = '<div class="vacio">No hay horarios disponibles por ahora.</div>'; return; }
      $('dias').innerHTML = data.dias.map((d, i) => { const [y, m, dd] = d.fecha.split('-'); return '<button type="button" class="dia" data-i="' + i + '"><small>' + DIAS[d.dow] + '</small><strong>' + (+dd) + '</strong><em>' + MESES[m - 1] + '</em></button>'; }).join('');
      elegirDia(0);
    } catch (e) { $('dias').innerHTML = '<div class="vacio">' + (e.message || 'No pudimos cargar la agenda.') + '</div>'; }
  }
  function elegirDia(i) {
    dia = data.dias[i]; inicio = null; $('form').classList.remove('on');
    document.querySelectorAll('.dia').forEach(b => b.classList.toggle('sel', +b.dataset.i === i));
    $('horas').innerHTML = dia.horas.map(h => '<button type="button" class="hora" data-s="' + h.inicio + '">' + h.hora + '</button>').join('');
  }
  function elegirHora(b) {
    inicio = b.dataset.s;
    document.querySelectorAll('.hora').forEach(x => x.classList.toggle('sel', x === b));
    $('resumen').innerHTML = '📅 <b>' + largo(inicio) + '</b> · ' + data.duracion + ' min por Google Meet';
    $('form').classList.add('on'); $('err').textContent = '';
    setTimeout(() => $('form').scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  }
  document.addEventListener('click', e => {
    const d = e.target.closest('.dia'); if (d) return elegirDia(+d.dataset.i);
    const h = e.target.closest('.hora'); if (h) return elegirHora(h);
  });
  $('form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target).entries());
    if (f.nombre.trim().length < 3) return $('err').textContent = 'Ingresa tu nombre.';
    if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/.test(f.correo.trim())) return $('err').textContent = 'Revisa tu correo electrónico.';
    $('btn').disabled = true; $('btn').textContent = 'Agendando…'; $('err').textContent = '';
    try {
      const r = await fetch('/api/reservar', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign(f, { inicio })) });
      const j = await r.json();
      if (!j.ok) { $('err').textContent = j.error || 'No se pudo agendar.'; if (j.ocupado) cargar(); return; }
      $('agenda').style.display = 'none'; $('ok').classList.add('on');
      $('cuando').textContent = largo(j.inicio); $('okcorreo').textContent = f.correo.trim();
      if (j.meet) $('meet').href = j.meet; else $('meet').style.display = 'none';
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (_) { $('err').textContent = 'No se pudo agendar. Intenta nuevamente.'; }
    finally { $('btn').disabled = false; $('btn').textContent = 'Confirmar cita'; }
  });
  cargar();
})();
</script>
</body>
</html>`;
