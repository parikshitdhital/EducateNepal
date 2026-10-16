const J = (d, s = 200, h = {}) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json', ...h } });
const enc = new TextEncoder();
const b64 = b => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX = 25 * 1024 * 1024;
const natural = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });

async function hashPw(pw, salt) {
  const k = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, k, 256));
}
const DESC = `WITH RECURSIVE d(id) AS (SELECT ? UNION ALL SELECT f.id FROM folders f JOIN d ON f.parent_id = d.id)`;

export async function onRequest({ request, env, params }) {
  const db = env.DB, m = request.method, url = new URL(request.url);
  const [a, b] = params.path || [];
  const cookie = (request.headers.get('cookie') || '').match(/sid=([\w-]+)/);

  async function user() {
    if (!cookie) return null;
    return await db.prepare('SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires > ?')
      .bind(cookie[1], Date.now()).first();
  }
  const body = async () => { try { return await request.json(); } catch { return {}; } };
  const clean = s => String(s || '').trim().replace(/[\/\\]/g, '-').slice(0, 120);

  try {
    // ---------- public ----------
    if (a === 'browse' && m === 'GET') {
      const id = url.searchParams.get('folder') || null;
      let crumbs = [];
      if (id) {
        const r = await db.prepare(`WITH RECURSIVE up(id,parent_id,name,d) AS (SELECT id,parent_id,name,0 FROM folders WHERE id=? UNION ALL SELECT f.id,f.parent_id,f.name,d+1 FROM folders f JOIN up ON f.id=up.parent_id) SELECT id,name FROM up ORDER BY d DESC`).bind(id).all();
        crumbs = r.results;
        if (!crumbs.length) return J({ error: 'Folder not found' }, 404);
      }
      const folders = (await db.prepare(`SELECT id,name,(SELECT COUNT(*) FROM folders c WHERE c.parent_id=folders.id) subfolders,(SELECT COUNT(*) FROM files x WHERE x.folder_id=folders.id) files FROM folders WHERE parent_id IS ?`).bind(id).all()).results.sort(natural);
      const files = (await db.prepare('SELECT id,name,type,size FROM files WHERE folder_id IS ?').bind(id).all()).results.sort(natural);
      return J({ crumbs, folders, files });
    }
    if (a === 'search' && m === 'GET') {
      const q = '%' + (url.searchParams.get('q') || '').replace(/[%_]/g, '') + '%';
      const folders = (await db.prepare('SELECT id,name FROM folders WHERE name LIKE ? LIMIT 50').bind(q).all()).results;
      const files = (await db.prepare('SELECT id,name,type,size,folder_id FROM files WHERE name LIKE ? LIMIT 100').bind(q).all()).results;
      return J({ folders, files });
    }
    if (a === 'tree' && m === 'GET') {
      return J((await db.prepare('SELECT id,parent_id,name FROM folders').all()).results);
    }
    if (a === 'file' && b && m === 'GET') {
      const f = await db.prepare('SELECT * FROM files WHERE id=?').bind(b).first();
      if (!f) return new Response('Not found', { status: 404 });
      const o = await env.BUCKET.get(f.r2_key);
      if (!o) return new Response('Not found', { status: 404 });
      const h = { 'content-type': f.type, 'cache-control': 'public, max-age=86400' };
      if (url.searchParams.get('download')) h['content-disposition'] = `attachment; filename="${encodeURIComponent(f.name)}"`;
      return new Response(o.body, { headers: h });
    }

    // ---------- auth ----------
    if (a === 'setup' && m === 'POST') {
      const n = await db.prepare('SELECT COUNT(*) c FROM users').first();
      if (n.c > 0) return J({ error: 'Setup already done' }, 403);
      const d = await body();
      if (!env.SETUP_KEY || d.key !== env.SETUP_KEY) return J({ error: 'Wrong setup key' }, 403);
      if (!d.email || !d.password || d.password.length < 8) return J({ error: 'Email and a password of 8+ characters required' }, 400);
      const salt = crypto.getRandomValues(new Uint8Array(16));
      await db.prepare('INSERT INTO users VALUES (?,?,?,?)').bind(crypto.randomUUID(), d.email.toLowerCase().trim(), b64(salt), await hashPw(d.password, salt)).run();
      return J({ ok: true });
    }
    if (a === 'status' && m === 'GET') {
      const n = await db.prepare('SELECT COUNT(*) c FROM users').first();
      const u = await user();
      return J({ needsSetup: n.c === 0, email: u ? u.email : null });
    }
    if (a === 'login' && m === 'POST') {
      const d = await body();
      const u = await db.prepare('SELECT * FROM users WHERE email=?').bind(String(d.email || '').toLowerCase().trim()).first();
      const ok = u && (await hashPw(d.password || '', unb64(u.salt))) === u.hash;
      if (!ok) return J({ error: 'Wrong email or password' }, 401);
      const token = crypto.randomUUID();
      await db.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(token, u.id, Date.now() + 7 * 864e5).run();
      return J({ ok: true }, 200, { 'set-cookie': `sid=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800` });
    }
    if (a === 'logout' && m === 'POST') {
      if (cookie) await db.prepare('DELETE FROM sessions WHERE token=?').bind(cookie[1]).run();
      return J({ ok: true }, 200, { 'set-cookie': 'sid=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0' });
    }

    // ---------- everything below needs login ----------
    if (!(await user())) return J({ error: 'Not logged in' }, 401);

    if (a === 'folders' && m === 'POST') {
      const d = await body(), name = clean(d.name);
      if (!name) return J({ error: 'Name required' }, 400);
      const id = crypto.randomUUID();
      await db.prepare('INSERT INTO folders VALUES (?,?,?)').bind(id, d.parent_id || null, name).run();
      return J({ id });
    }
    if (a === 'folders' && b && m === 'PATCH') {
      const d = await body();
      if (d.name !== undefined) {
        const name = clean(d.name);
        if (!name) return J({ error: 'Name required' }, 400);
        await db.prepare('UPDATE folders SET name=? WHERE id=?').bind(name, b).run();
      }
      if (d.parent_id !== undefined) {
        const inside = await db.prepare(`${DESC} SELECT 1 x FROM d WHERE id=?`).bind(b, d.parent_id || '').first();
        if (inside) return J({ error: 'A folder cannot go inside itself' }, 400);
        await db.prepare('UPDATE folders SET parent_id=? WHERE id=?').bind(d.parent_id || null, b).run();
      }
      return J({ ok: true });
    }
    if (a === 'folders' && b && m === 'DELETE') {
      const keys = (await db.prepare(`${DESC} SELECT r2_key FROM files WHERE folder_id IN (SELECT id FROM d)`).bind(b).all()).results.map(r => r.r2_key);
      for (let i = 0; i < keys.length; i += 1000) await env.BUCKET.delete(keys.slice(i, i + 1000));
      await db.batch([
        db.prepare(`${DESC} DELETE FROM files WHERE folder_id IN (SELECT id FROM d)`).bind(b),
        db.prepare(`${DESC} DELETE FROM folders WHERE id IN (SELECT id FROM d)`).bind(b),
      ]);
      return J({ ok: true });
    }
    if (a === 'upload' && m === 'POST') {
      const fd = await request.formData(), file = fd.get('file'), folder = url.searchParams.get('folder') || null;
      if (!file || !file.name) return J({ error: 'No file' }, 400);
      if (!ALLOWED.includes(file.type)) return J({ error: 'Only JPG, PNG, WebP and PDF are allowed' }, 400);
      if (file.size > MAX) return J({ error: 'File is over 25 MB' }, 400);
      const id = crypto.randomUUID();
      await env.BUCKET.put(id, file.stream(), { httpMetadata: { contentType: file.type } });
      await db.prepare('INSERT INTO files VALUES (?,?,?,?,?,?,?)').bind(id, folder, clean(file.name), id, file.type, file.size, Date.now()).run();
      return J({ id });
    }
    if (a === 'files' && b && m === 'PATCH') {
      const d = await body();
      if (d.name !== undefined) {
        const name = clean(d.name);
        if (!name) return J({ error: 'Name required' }, 400);
        await db.prepare('UPDATE files SET name=? WHERE id=?').bind(name, b).run();
      }
      if (d.folder_id !== undefined) await db.prepare('UPDATE files SET folder_id=? WHERE id=?').bind(d.folder_id || null, b).run();
      return J({ ok: true });
    }
    if (a === 'files' && b && m === 'DELETE') {
      const f = await db.prepare('SELECT r2_key FROM files WHERE id=?').bind(b).first();
      if (f) { await env.BUCKET.delete(f.r2_key); await db.prepare('DELETE FROM files WHERE id=?').bind(b).run(); }
      return J({ ok: true });
    }
    return J({ error: 'Not found' }, 404);
  } catch (e) {
    return J({ error: 'Server error: ' + e.message }, 500);
  }
}
