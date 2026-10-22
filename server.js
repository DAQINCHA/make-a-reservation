#!/usr/bin/env node
'use strict';
/** 镜间：node:http + node:sqlite，无第三方依赖、无构建步骤。 */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, execFile } = require('node:child_process');
const { DatabaseSync: BackupDatabase } = require('node:sqlite');

const storage = require('./lib/storage');
const validation = require('./lib/validation');

const { ROOT, DEFAULT_DB, initialize, passwordHash, verifyPassword, tokenHash, initialPasswordPath } = storage;
const { schema, validate, authorize, Invalid, imageInfo, MAX_AVATAR } = validation;

const AGE = 7 * 24 * 60 * 60;
const CONFLICT = '工作区已在其他页面更新。请重新加载最新数据后再保存。';
const BODY_CAP = 16 * 1024 * 1024;
const WORKSPACE_LIMIT = 12 * 1000 * 1000;
const LEGACY_CSS = new Set(['/static/tailwindcss', '/static/tw-animate-css', '/vendor/shadcn-tailwind-4.13.0.css']);
const PUBLIC_DIR = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain',
  '.woff2': 'font/woff2',
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

class HTTPError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function fail(status, message) {
  throw new HTTPError(status, message);
}

function now() {
  return Date.now();
}

function codePoints(value) {
  let total = 0;
  for (const ignored of value) total += 1;
  return total;
}

class Db {
  constructor(file) {
    this.raw = storage.connect(file);
    this.tx = false;
  }
  begin() {
    if (!this.tx) {
      this.raw.exec('BEGIN IMMEDIATE');
      this.tx = true;
    }
  }
  commit() {
    if (this.tx) {
      this.raw.exec('COMMIT');
      this.tx = false;
    }
  }
  rollback() {
    if (this.tx) {
      try {
        this.raw.exec('ROLLBACK');
      } catch (ignored) {}
      this.tx = false;
    }
  }
  get(sql, ...args) {
    return this.raw.prepare(sql).get(...args);
  }
  all(sql, ...args) {
    return this.raw.prepare(sql).all(...args);
  }
  run(sql, ...args) {
    return this.raw.prepare(sql).run(...args);
  }
  close() {
    try {
      this.raw.close();
    } catch (ignored) {}
  }
}

function cookieHeader(token = '') {
  return `studio_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${token ? AGE : 0}`;
}

function readToken(headers) {
  const raw = headers.cookie || '';
  for (const piece of raw.split(';')) {
    const index = piece.indexOf('=');
    if (index === -1) continue;
    if (piece.slice(0, index).trim() !== 'studio_session') continue;
    let value = piece.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    return /^[a-f0-9]{64}$/.test(value) ? value : '';
  }
  return '';
}

function send(res, out, method) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const status = out.status || 200;
  const payload = Buffer.isBuffer(out.body)
    ? out.body
    : Buffer.from(typeof out.body === 'string' ? out.body : JSON.stringify(out.body), 'utf8');
  res.writeHead(status, {
    'Content-Type': out.mime || 'application/json; charset=utf-8',
    'Content-Length': String(payload.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    Connection: 'close',
    ...(out.headers || {}),
  });
  if (method === 'HEAD' || status === 304) res.end();
  else res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    };
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total <= BODY_CAP) chunks.push(chunk);
    });
    req.on('end', finish);
    req.on('aborted', finish);
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

async function buildContext(req, port, dbPath) {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (error) {
    fail(400, '请求格式错误');
  }
  const headers = req.headers;
  let invalidBody = !!headers['transfer-encoding'];
  let length = 0;
  const declared = headers['content-length'];
  if (declared !== undefined) {
    const text = String(declared).trim();
    if (!/^[+-]?\d+$/.test(text)) invalidBody = true;
    else length = Number(text);
    if (length < 0) invalidBody = true;
  }
  const body = await readBody(req);
  const context = {
    method: req.method,
    pathname: url.pathname,
    query: url.searchParams,
    headers,
    host: headers.host || '',
    port,
    dbPath,
    token: readToken(headers),
    body,
    bodyLength: invalidBody ? Number.MAX_SAFE_INTEGER : length,
    invalidBody,
  };
  context.read = (limit = 4096) => {
    if (context.invalidBody) fail(400, '请求格式错误');
    if (context.bodyLength > limit) fail(413, url.pathname.startsWith('/api/avatars') ? '图片不能超过 3MB' : '输入内容过长');
    return context.body;
  };
  return context;
}

function jsonBody(ctx, limit = 4096) {
  if (!String(ctx.headers['content-type'] || '').includes('application/json')) fail(415, '请求格式错误');
  let body;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(ctx.read(limit)));
  } catch (error) {
    if (error instanceof HTTPError) throw error;
    fail(400, '请求格式错误');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, '请求格式错误');
  return body;
}

function workspaceOf(db) {
  const row = db.get("SELECT revision,payload FROM workspace WHERE id='studio'");
  return { revision: row.revision, data: JSON.parse(row.payload) };
}

function publicUser(db, account) {
  let name = '管理员';
  if (account.role !== 'admin') {
    const person = workspaceOf(db).data.people.find((one) => one.id === account.person_id);
    if (!person) return null;
    name = person.name;
  }
  return {
    id: account.id,
    username: account.username,
    role: account.role,
    personId: account.person_id,
    name,
    mustChangePassword: !!account.must_change_password,
  };
}

function currentUser(ctx, db) {
  if (!ctx.token) return null;
  const account = db.get(
    'SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=? AND expires_at>?',
    tokenHash(ctx.token),
    now(),
  );
  return account ? publicUser(db, account) : null;
}

function requireUser(ctx, db, options = {}) {
  const user = currentUser(ctx, db);
  if (!user) fail(401, '请先登录');
  if (user.mustChangePassword && !options.allowPasswordChange) fail(403, '请先修改初始密码，再使用工作区');
  if (options.admin && user.role !== 'admin') fail(403, '只有管理员可以管理账号');
  return user;
}

function attemptFailed(db, id) {
  db.run(
    'UPDATE users SET failed_attempts=failed_attempts+1, locked_until=CASE WHEN failed_attempts>=4 THEN ? ELSE 0 END WHERE id=?',
    now() + 60000,
    id,
  );
  db.commit();
}

function saveAvatar(db, pid, payload, contentType) {
  // 在调用方的事务里写入；此处绝不提交。
  if (!Buffer.isBuffer(payload)) fail(400, '请选择图片文件');
  if (payload.length > MAX_AVATAR) fail(413, '图片不能超过 3MB');
  const info = imageInfo(payload);
  if (!info) fail(400, '无法读取图片信息，请上传 PNG、JPEG、WebP 或 GIF 图片');
  if (info.width > 2048 || info.height > 2048) {
    fail(400, `图片尺寸不能超过 2048×2048 像素（当前 ${info.width}×${info.height}）`);
  }
  if (contentType && contentType !== info.mime) fail(415, '图片格式与文件类型不一致，请重新选择');
  const row = db.get('SELECT MAX(updated_at) AS latest FROM avatars WHERE person_id=?', pid);
  const version = Math.max(now(), (row && row.latest ? row.latest : 0) + 1);
  db.run('DELETE FROM avatars WHERE person_id=?', pid);
  let seq = 0;
  for (let offset = 0; offset < payload.length; offset += 128 * 1024) {
    const chunk = payload.subarray(offset, offset + 128 * 1024).toString('base64');
    db.run(
      'INSERT INTO avatars VALUES (?,?,?,?,?,?,?,?)',
      pid,
      seq,
      chunk,
      info.mime,
      info.width,
      info.height,
      payload.length,
      version,
    );
    seq += 1;
  }
  return { version, mime: info.mime, width: info.width, height: info.height };
}

function avatarPerson(db, pid) {
  const workspace = workspaceOf(db);
  const person = workspace.data.people.find((one) => one.id === pid);
  if (!person) fail(404, '人员不存在，请刷新后重试');
  return { workspace, person };
}

function commitAvatarWorkspace(db, workspace) {
  // 独立头像客户端的写入同样要让旧的工作区版本失效。
  db.run("UPDATE workspace SET revision=revision+1,payload=? WHERE id='studio'", JSON.stringify(workspace.data));
  db.commit();
}

function parseMultipart(raw, contentType) {
  const matched = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || '');
  const parts = new Map();
  if (!matched) return parts;
  const boundary = Buffer.from('--' + (matched[1] || matched[2]), 'latin1');
  let position = 0;
  while (position < raw.length) {
    const start = raw.indexOf(boundary, position);
    if (start === -1) break;
    let cursor = start + boundary.length;
    if (raw[cursor] === 0x2d && raw[cursor + 1] === 0x2d) break;
    while (raw[cursor] === 0x0d || raw[cursor] === 0x0a) cursor += 1;
    const next = raw.indexOf(boundary, cursor);
    if (next === -1) break;
    const headerEnd = raw.indexOf('\r\n\r\n', cursor);
    if (headerEnd === -1 || headerEnd > next) {
      position = next;
      continue;
    }
    const head = raw.subarray(cursor, headerEnd).toString('utf8');
    let bodyEnd = next;
    if (raw[bodyEnd - 2] === 0x0d && raw[bodyEnd - 1] === 0x0a) bodyEnd -= 2;
    const name = /name="([^"]*)"/i.exec(head) || /name=([^;\s]+)/i.exec(head);
    const filename = /filename="([^"]*)"/i.exec(head) || /filename=([^;\s]+)/i.exec(head);
    const type = /content-type:\s*([^\r\n]+)/i.exec(head);
    if (name) {
      parts.set(name[1], {
        data: raw.subarray(headerEnd + 4, bodyEnd),
        filename: filename ? filename[1] : null,
        contentType: type ? type[1].split(';')[0].trim().toLowerCase() : null,
      });
    }
    position = next;
  }
  return parts;
}

/* ---------------------------------- 路由 ---------------------------------- */

function serveStatic(pathname) {
  if (LEGACY_CSS.has(pathname)) {
    return { body: Buffer.from('/* Legacy import: native.css supplies the required primitives. */'), mime: 'text/css' };
  }
  let file;
  if (pathname === '/') {
    file = path.join(PUBLIC_DIR, 'index.html');
  } else {
    let decoded = pathname;
    try {
      decoded = decodeURIComponent(pathname);
    } catch (error) {
      decoded = pathname;
    }
    file = path.resolve(PUBLIC_DIR, decoded.replace(/^\/+/, ''));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) fail(404, '文件不存在');
  }
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    fail(404, '文件不存在');
  }
  if (!stat.isFile()) fail(404, '文件不存在');
  const mime = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  return {
    body: fs.readFileSync(file),
    headers: { 'Content-Security-Policy': CSP },
    mime: mime.startsWith('text/') ? mime + '; charset=utf-8' : mime,
  };
}

function sessionRoute(ctx, db) {
  if (ctx.method === 'GET') return { body: { user: currentUser(ctx, db) } };
  if (ctx.method === 'DELETE') {
    db.run('DELETE FROM sessions WHERE token_hash=?', tokenHash(ctx.token));
    db.commit();
    return { body: { ok: true }, headers: { 'Set-Cookie': cookieHeader() } };
  }
  if (ctx.method !== 'POST') fail(405, '请求方法无效');
  const body = jsonBody(ctx);
  if (
    typeof body.username !== 'string' ||
    typeof body.password !== 'string' ||
    codePoints(body.username) > 50 ||
    codePoints(body.password) > 128
  ) {
    fail(400, '账号或密码格式不正确');
  }
  const account = db.get('SELECT * FROM users WHERE username=?', body.username.trim().toLowerCase());
  if (account && account.locked_until > now()) fail(429, '尝试次数过多，请一分钟后重试');
  let valid = false;
  if (account) valid = verifyPassword(body.password, account.password_hash);
  else {
    passwordHash(body.password);
    valid = false;
  }
  if (!valid) {
    if (account) attemptFailed(db, account.id);
    fail(401, '账号或密码不正确');
  }
  const user = publicUser(db, account);
  if (!user) fail(401, '账号或密码不正确');
  const token = crypto.randomBytes(32).toString('hex');
  db.run('UPDATE users SET failed_attempts=0,locked_until=0 WHERE id=?', account.id);
  db.run('DELETE FROM sessions WHERE expires_at<=? OR token_hash=?', now(), tokenHash(ctx.token));
  db.run('INSERT INTO sessions VALUES (?,?,?)', tokenHash(token), account.id, now() + AGE * 1000);
  db.commit();
  return { body: { user }, headers: { 'Set-Cookie': cookieHeader(token) } };
}

function workspaceRoute(ctx, db) {
  const user = requireUser(ctx, db);
  const current = workspaceOf(db);
  if (ctx.method === 'GET') return { body: current };
  if (ctx.method !== 'PUT') fail(405, '请求方法无效');
  const body = jsonBody(ctx, WORKSPACE_LIMIT);
  const raw = body.data === undefined ? 'null' : JSON.stringify(body.data);
  if (raw.length > 3000000) fail(413, '工作区数据过大');
  const data = schema(body.data);
  const revision = body.revision;
  if (!Number.isInteger(revision) || !(revision >= 1 && revision <= 9007199254740991)) fail(400, '无效的数据版本');
  if (revision !== current.revision) fail(409, CONFLICT);
  const forbidden = authorize(data, current.data, user);
  if (forbidden) fail(403, forbidden);
  validate(data, current.data);
  if ('avatarChange' in body) {
    const change = body.avatarChange;
    if (!change || typeof change !== 'object' || Array.isArray(change)) fail(400, '头像数据格式错误');
    const pid = change.personId;
    if (typeof pid !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(pid)) fail(400, '人员信息无效');
    if (user.role !== 'admin' && user.personId !== pid) fail(403, '只能修改自己的头像');
    const person = data.people.find((one) => one.id === pid);
    if (!person) fail(400, '人员不存在，请刷新后重试');
    if (change.remove === true) {
      if ('base64' in change) fail(400, '头像数据格式错误');
      db.run('DELETE FROM avatars WHERE person_id=?', pid);
      delete person.avatar;
    } else {
      const encoded = change.base64;
      if (typeof encoded !== 'string') fail(400, '头像数据格式错误');
      if (encoded.length > 4 * Math.floor((MAX_AVATAR + 2) / 3)) fail(413, '图片不能超过 3MB');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) fail(400, '头像数据格式错误');
      const info = saveAvatar(db, pid, Buffer.from(encoded, 'base64'), change.mime);
      person.avatar = info.version;
    }
  }
  db.run(
    "UPDATE workspace SET revision=revision+1,payload=? WHERE id='studio' AND revision=?",
    JSON.stringify(data),
    revision,
  );
  const people = new Set(data.people.map((person) => person.id));
  for (const row of db.all("SELECT id,person_id FROM users WHERE role='user'")) {
    if (!people.has(row.person_id)) {
      db.run('DELETE FROM sessions WHERE user_id=?', row.id);
      db.run('DELETE FROM users WHERE id=?', row.id);
    }
  }
  for (const row of db.all('SELECT DISTINCT person_id FROM avatars')) {
    if (!people.has(row.person_id)) db.run('DELETE FROM avatars WHERE person_id=?', row.person_id);
  }
  db.commit();
  return { body: { data, revision: revision + 1 } };
}

function accountsRoute(ctx, db) {
  requireUser(ctx, db, { admin: true });
  const pid = ctx.query.get('personId') || '';
  if (ctx.method === 'GET') {
    const account = db.get('SELECT username FROM users WHERE person_id=?', pid);
    return { body: { account: account ? { username: account.username } : null } };
  }
  if (ctx.method !== 'POST') fail(405, '请求方法无效');
  const body = jsonBody(ctx);
  if (!['personId', 'username', 'password'].every((key) => typeof body[key] === 'string')) {
    fail(400, '请填写账号和密码');
  }
  const name = body.username.trim().toLowerCase();
  const password = body.password;
  if (!/^\S{2,50}$/.test(name)) fail(400, '账号需为 2–50 个字符，不能包含空格');
  if (password && !(codePoints(password) >= 4 && codePoints(password) <= 128)) fail(400, '密码需为 4–128 个字符');
  if (!workspaceOf(db).data.people.some((person) => person.id === body.personId)) {
    fail(404, '人员不存在，请刷新后重试');
  }
  const existing = db.get('SELECT * FROM users WHERE person_id=?', body.personId);
  if (!existing && !password) fail(400, '首次设置账号时必须填写密码');
  if (db.get('SELECT id FROM users WHERE username=? AND (person_id IS NULL OR person_id!=?)', name, body.personId)) {
    fail(409, '该账号已被使用');
  }
  const uid = existing ? existing.id : crypto.randomBytes(16).toString('hex');
  const hashed = password ? passwordHash(password) : existing.password_hash;
  db.run(
    "INSERT INTO users(id,person_id,username,password_hash,role) VALUES (?,?,?,?,'user') ON CONFLICT(person_id) DO UPDATE SET username=excluded.username,password_hash=excluded.password_hash,failed_attempts=0,locked_until=0",
    uid,
    body.personId,
    name,
    hashed,
  );
  db.run('DELETE FROM sessions WHERE user_id=?', uid);
  db.commit();
  return { body: { account: { username: name } } };
}

function passwordRoute(ctx, db) {
  const user = requireUser(ctx, db, { allowPasswordChange: true });
  if (ctx.method !== 'POST') fail(405, '请求方法无效');
  const body = jsonBody(ctx);
  const current = body.currentPassword;
  const next = body.newPassword;
  if (typeof current !== 'string' || typeof next !== 'string' || !current || !next) fail(400, '请填写当前密码和新密码');
  if (!(codePoints(next) >= 4 && codePoints(next) <= 128)) fail(400, '新密码需为 4–128 个字符');
  if (user.mustChangePassword && codePoints(next) < 8) fail(400, '首次设置的新密码至少需要 8 个字符');
  const account = db.get('SELECT * FROM users WHERE id=?', user.id);
  if (account.locked_until > now()) fail(429, '尝试次数过多，请一分钟后重试');
  if (!verifyPassword(current, account.password_hash)) {
    attemptFailed(db, account.id);
    fail(401, '当前密码不正确');
  }
  if (verifyPassword(next, account.password_hash)) fail(400, '新密码不能与当前密码相同');
  db.run(
    'UPDATE users SET password_hash=?,failed_attempts=0,locked_until=0,must_change_password=0 WHERE id=?',
    passwordHash(next),
    account.id,
  );
  db.run('DELETE FROM sessions WHERE user_id=? AND token_hash!=?', account.id, tokenHash(ctx.token));
  db.commit();
  if (user.role === 'admin' && user.mustChangePassword) {
    try {
      fs.unlinkSync(initialPasswordPath(ctx.dbPath));
    } catch (error) {}
  }
  user.mustChangePassword = false;
  return { body: { ok: true, user } };
}

function avatarRoute(ctx, db) {
  const user = requireUser(ctx, db);
  let pid = ctx.query.get('personId') || '';
  if (ctx.method === 'POST') {
    const raw = ctx.read(MAX_AVATAR + 256 * 1024);
    const contentType = String(ctx.headers['content-type'] || '');
    if (!contentType.startsWith('multipart/form-data')) fail(400, '请选择图片文件');
    const parts = parseMultipart(raw, contentType);
    const personPart = parts.get('personId');
    if (!personPart) fail(400, '人员信息无效');
    try {
      pid = new TextDecoder('utf-8', { fatal: true }).decode(personPart.data);
    } catch (error) {
      fail(400, '人员信息无效');
    }
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(pid)) fail(400, '人员信息无效');
    if (user.role !== 'admin' && user.personId !== pid) fail(403, '只能上传自己的头像');
    const file = parts.get('file');
    if (!file || file.filename === null) fail(400, '请选择图片文件');
    const { workspace, person } = avatarPerson(db, pid);
    const info = saveAvatar(db, pid, file.data, file.contentType);
    person.avatar = info.version;
    commitAvatarWorkspace(db, workspace);
    return { body: info };
  }
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(pid)) {
    if (ctx.method === 'GET') fail(404, '头像不存在');
    fail(400, '人员信息无效');
  }
  if (ctx.method === 'DELETE') {
    if (user.role !== 'admin' && user.personId !== pid) fail(403, '只能删除自己的头像');
    const { workspace, person } = avatarPerson(db, pid);
    db.run('DELETE FROM avatars WHERE person_id=?', pid);
    delete person.avatar;
    commitAvatarWorkspace(db, workspace);
    return { body: { ok: true } };
  }
  if (ctx.method !== 'GET') fail(405, '请求方法无效');
  const parts = db.all('SELECT * FROM avatars WHERE person_id=? ORDER BY seq', pid);
  if (!parts.length) fail(404, '头像不存在');
  const etag = `"${parts[0].updated_at}-${parts.length}"`;
  const headers = { 'Cache-Control': 'private, max-age=300', ETag: etag };
  if (ctx.headers['if-none-match'] === etag) return { body: Buffer.alloc(0), status: 304, headers, mime: parts[0].mime };
  const payload = Buffer.concat(parts.map((part) => Buffer.from(part.chunk, 'base64')));
  return { body: payload, headers, mime: parts[0].mime };
}

function route(ctx) {
  if (ctx.method !== 'GET' && ctx.method !== 'HEAD') {
    const origin = ctx.headers.origin;
    if (origin && !originAllowed(origin, ctx.headers)) fail(403, '请求来源无效');
    if (ctx.headers['sec-fetch-site'] === 'cross-site') fail(403, '请求来源无效');
  }
  if (!ctx.pathname.startsWith('/api/')) {
    if (ctx.method !== 'GET' && ctx.method !== 'HEAD') fail(405, '请求方法无效');
    return serveStatic(ctx.pathname);
  }
  const mutating = ctx.method !== 'GET' && ctx.method !== 'HEAD';
  const db = new Db(ctx.dbPath);
  try {
    if (mutating) db.begin();
    let out;
    switch (ctx.pathname) {
      case '/api/session':
        out = sessionRoute(ctx, db);
        break;
      case '/api/workspace':
        out = workspaceRoute(ctx, db);
        break;
      case '/api/accounts':
        out = accountsRoute(ctx, db);
        break;
      case '/api/password':
        out = passwordRoute(ctx, db);
        break;
      case '/api/avatars':
        out = avatarRoute(ctx, db);
        break;
      default:
        fail(404, '接口不存在');
    }
    db.commit();
    return out;
  } catch (error) {
    db.rollback();
    throw error;
  } finally {
    db.close();
  }
}

/* --------------------------------- 网络地址 -------------------------------- */

function localHost(name) {
  const cleaned = String(name || '')
    .replace(/^[\[\]]+/, '')
    .replace(/[\[\]]+$/, '')
    .toLowerCase();
  if (cleaned === 'localhost' || cleaned === '127.0.0.1' || cleaned === '::1') return true;
  const version = net.isIP(cleaned);
  if (version === 4) {
    const octets = cleaned.split('.').map(Number);
    if (octets[0] === 127) return true;
    if (octets[0] === 10) return true;
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
    if (octets[0] === 192 && octets[1] === 168) return true;
    if (octets[0] === 169 && octets[1] === 254) return true;
    if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return true;
    return false;
  }
  if (version === 6) {
    if (cleaned.startsWith('::ffff:')) return localHost(cleaned.slice(7));
    return cleaned.startsWith('fc') || cleaned.startsWith('fd') || /^fe[89ab]/.test(cleaned);
  }
  return cleaned.endsWith('.local') || cleaned === os.hostname().toLowerCase();
}

function loadEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (error) { return; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function originAllowed(origin, headers) {
  const list = (process.env.RESERVATION_ALLOWED_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (list.includes(origin)) return true;
  const hostName = (value) => String(value || "").split(",")[0].trim().toLowerCase().replace(/:\d+$/, "");
  let originName = "";
  try { originName = new URL(origin).hostname.toLowerCase(); } catch (error) {}
  const candidates = [headers.host, headers["x-forwarded-host"]].map(hostName).filter(Boolean);
  if (originName && candidates.includes(originName)) return true;
  console.warn(`  拒绝来源 ${origin}（Host: ${headers.host || "-"}，X-Forwarded-Host: ${headers["x-forwarded-host"] || "-"}）`);
  return false;
}

function hostAllowed(header, port) {
  if (!header) return false;
  const index = header.lastIndexOf(':');
  const name = index === -1 ? header : header.slice(0, index);
  const text = index === -1 ? '' : header.slice(index + 1);
  return text === String(port) && localHost(name);
}

function lanAddresses() {
  const found = [];
  const add = (value) => {
    const text = String(value || '').trim();
    if (!text || text === '127.0.0.1' || text === '0.0.0.0' || found.includes(text)) return;
    if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(text)) return;
    found.push(text);
  };
  if (process.platform === 'darwin') {
    for (const name of ['en0', 'en1']) {
      try {
        add(execFileSync('ipconfig', ['getifaddr', name], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }));
      } catch (error) {}
    }
  }
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' || entry.family === 4) add(entry.address);
    }
  }
  const score = (ip) => {
    if (ip.startsWith('192.168.') || ip.startsWith('10.')) return 0;
    if (ip.startsWith('172.')) {
      const second = Number(ip.split('.')[1]);
      if (second >= 16 && second <= 31) return 0;
    }
    if (ip.startsWith('169.254.') || ip.startsWith('198.1')) return 3;
    return /^(127\.|0\.)/.test(ip) ? 2 : 1;
  };
  return found.sort((a, b) => score(a) - score(b));
}

/* ---------------------------------- 启动 ---------------------------------- */

function parseArgs(argv) {
  const options = { db: DEFAULT_DB, port: 3288, host: '127.0.0.1', open: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = (name) => {
      if (arg.includes('=')) return arg.slice(arg.indexOf('=') + 1);
      index += 1;
      if (index >= argv.length) throw new Error(`${name} 缺少参数值`);
      return argv[index];
    };
    if (arg === '--db' || arg.startsWith('--db=')) options.db = path.resolve(take('--db'));
    else if (arg === '--port' || arg.startsWith('--port=')) options.port = Number(take('--port'));
    else if (arg === '--host' || arg.startsWith('--host=')) options.host = take('--host');
    else if (arg === '--open') options.open = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`无法识别的参数：${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('端口需为 0–65535 之间的整数');
  if (!options.host) throw new Error('监听地址不能为空');
  return options;
}

function openBrowser(url) {
  try {
    if (process.platform === 'darwin') execFile('open', [url], () => {});
    else if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], () => {});
    else execFile('xdg-open', [url], () => {});
  } catch (error) {}
}


/* 启动时备份数据库：data/backups/<名>-startup-<时间>.db，只保留最近 10 份 */
function backupOnStartup(dbPath, keep = 10) {
  if (!fs.existsSync(dbPath)) return null;
  const dir = path.join(path.dirname(dbPath), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const base = path.basename(dbPath).replace(/\.[^.]+$/, "");
  const target = path.join(dir, `${base}-startup-${stamp}.db`);
  const db = new BackupDatabase(dbPath);
  try { db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`); } finally { db.close(); }
  const old = fs.readdirSync(dir).filter((n) => n.startsWith(`${base}-startup-`) && n.endsWith(".db")).sort();
  for (const n of old.slice(0, Math.max(0, old.length - keep))) fs.rmSync(path.join(dir, n), { force: true });
  return target;
}

function main() {
  loadEnvFile(path.join(__dirname, ".env"));
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error('用法：node server.js [--db 数据库路径] [--port 端口] [--host 监听地址] [--open]');
    process.exit(1);
  }
  if (options.help) {
    console.log('用法：node server.js [--db 数据库路径] [--port 端口] [--host 监听地址] [--open]');
    return;
  }
  const dbPath = path.resolve(options.db);
  try {
    initialize(dbPath);
  } catch (error) {
    console.error(`无法打开数据库：${error.message}`);
    process.exit(1);
  }
  let backupPath = null;
  try { backupPath = backupOnStartup(dbPath); } catch (error) { console.warn(`  数据库备份失败：${error.message}`); }
  let boundPort = options.port;
  const server = http.createServer((request, response) => {
    const respond = (out) => {
      try {
        send(response, out, request.method);
      } catch (error) {}
    };
    buildContext(request, boundPort, dbPath)
      .then((context) => route(context))
      .then((out) => respond(out))
      .catch((error) => {
        if (error instanceof HTTPError) respond({ body: { error: error.message }, status: error.status });
        else if (error instanceof Invalid) respond({ body: { error: error.message }, status: 400 });
        else if (error && (error.code === 'EPIPE' || error.code === 'ECONNRESET' || error.code === 'ERR_STREAM_DESTROYED')) return;
        else {
          console.error(error);
          respond({ body: { error: '保存失败，填写的内容仍已保留，请重试。' }, status: 503 });
        }
      });
  });
  server.on('error', (error) => {
    console.error(`无法启动服务：${error.message}。请关闭占用端口的旧服务后重试。`);
    process.exit(1);
  });
  server.listen(options.port, options.host, () => {
    const port = server.address().port;
    boundPort = port;
    const url = `http://127.0.0.1:${port}`;
    const bar = '='.repeat(60);
    const lines = [bar, '   镜间 · 光影之艺影棚管理系统  MAKE A RESERVATION', bar, '', `  Node:    ${process.execPath}`, '', `  本机    http://127.0.0.1:${port}`];
    if (!['127.0.0.1', 'localhost', '::1'].includes(options.host)) {
      for (const lan of lanAddresses().slice(0, 2)) lines.push(`  局域网  http://${lan}:${port}`);
    }
    const dataPath = path.relative(ROOT, dbPath);
    lines.push(`  数据    ${dataPath.startsWith('..') ? dbPath : dataPath}`);
    if (backupPath) { const b = path.relative(ROOT, backupPath); lines.push(`  备份    ${b.startsWith("..") ? backupPath : b}（保留最近 10 份）`); }
    const secret = initialPasswordPath(dbPath);
    if (fs.existsSync(secret)) {
      const secretPath = path.relative(ROOT, secret);
      lines.push('', `  首次登录账号 admin，初始密码见 ${secretPath.startsWith('..') ? secret : secretPath}。`);
      lines.push('  首次登录后必须设置新密码，才能使用工作区。');
    }
    lines.push('', '  关闭这个窗口即停止服务。', '');
    console.log(lines.join('\n'));
    if (options.open) openBrowser(url);
  });
  const stop = () => {
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) main();

module.exports = { route, send, buildContext, hostAllowed, lanAddresses };
