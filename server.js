const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROTOCOL_VERSION = '2025-03-26';
const SERVER_INFO = { name: 'skills-aggregator', version: '1.1.0' };
const MAX_SKILL_CHARACTERS = 60000;
const MAX_DESCRIPTION_CHARACTERS = 1000;

function option(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

function safeName(value) {
  const name = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(name)) {
    throw new Error('Skill name must contain only lowercase letters, digits, dot, underscore, or dash.');
  }
  return name;
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(temporary, content, 'utf8');
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    fs.renameSync(temporary, file);
  }
}

function parseFrontMatter(content) {
  if (!content.startsWith('---')) return {};
  const end = content.indexOf('\n---', 3);
  if (end < 0) return {};
  const result = {};
  for (const line of content.slice(3, end).split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const rawValue = line.slice(separator + 1).trim();
    let value = rawValue.replace(/^['"]|['"]$/g, '');
    if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
      try { value = JSON.parse(rawValue); } catch { }
    }
    if (key === 'name' || key === 'description') result[key] = value;
  }
  return result;
}

function markdownBody(content) {
  const normalized = String(content || '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return normalized.trim();
  const end = normalized.indexOf('\n---', 4);
  if (end < 0) return normalized.trim();
  return normalized.slice(end + 4).replace(/^\n+/, '').trim();
}

function skillDocument(name, description, markdown) {
  const normalizedName = safeName(name);
  const normalizedDescription = String(description || '').trim();
  if (!normalizedDescription) throw new Error('Skill description is required. Explain what the skill does and when to use it.');
  if (/\r|\n/.test(normalizedDescription)) throw new Error('Skill description must be a single line.');
  if (normalizedDescription.length > MAX_DESCRIPTION_CHARACTERS) {
    throw new Error(`Skill description exceeds ${MAX_DESCRIPTION_CHARACTERS} characters.`);
  }
  const body = markdownBody(markdown);
  if (!body) throw new Error('Skill markdown is required.');
  const escapedDescription = normalizedDescription.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const content = `---\nname: ${normalizedName}\ndescription: "${escapedDescription}"\n---\n\n${body}\n`;
  if (content.length > MAX_SKILL_CHARACTERS) {
    throw new Error(`Complete SKILL.md exceeds ${MAX_SKILL_CHARACTERS} characters.`);
  }
  return { name: normalizedName, description: normalizedDescription, content };
}

function createStore(dataDirectory) {
  const root = path.resolve(dataDirectory);
  fs.mkdirSync(root, { recursive: true });

  function skillFile(name) {
    return path.join(root, safeName(name), 'SKILL.md');
  }

  return {
    root,
    list() {
      return fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => {
          const file = skillFile(entry.name);
          if (!fs.existsSync(file)) return null;
          const content = fs.readFileSync(file, 'utf8');
          const metadata = parseFrontMatter(content);
          const stats = fs.statSync(file);
          return {
            name: safeName(metadata.name),
            description: metadata.description,
            updatedUtc: stats.mtime.toISOString()
          };
        })
        .filter(Boolean)
        .sort((left, right) => left.name.localeCompare(right.name));
    },
    get(name) {
      const normalized = safeName(name);
      const file = skillFile(normalized);
      if (!fs.existsSync(file)) throw new Error('Skill not found: ' + normalized);
      const content = fs.readFileSync(file, 'utf8');
      const metadata = parseFrontMatter(content);
      if (safeName(metadata.name) !== normalized || !metadata.description) throw new Error('Skill metadata is invalid: ' + normalized);
      return { name: normalized, description: metadata.description, markdown: content };
    },
    write(name, description, markdown, overwrite) {
      const skill = skillDocument(name, description, markdown);
      const file = skillFile(skill.name);
      if (fs.existsSync(file) && !overwrite) throw new Error('Skill already exists; set overwrite=true to replace it.');
      atomicWrite(file, skill.content);
      return this.get(skill.name);
    },
    delete(name) {
      const normalized = safeName(name);
      const directory = path.dirname(skillFile(normalized));
      if (!fs.existsSync(skillFile(normalized))) return { name: normalized, deleted: false, status: 'not_found' };
      fs.rmSync(directory, { recursive: true, force: true });
      return { name: normalized, deleted: true, status: 'deleted' };
    }
  };
}

function loadWriteToken(tokenFile) {
  const fromEnvironment = String(process.env.SKILLS_WRITE_TOKEN || '').trim();
  if (fromEnvironment) return fromEnvironment;
  const resolved = path.resolve(tokenFile);
  if (fs.existsSync(resolved)) {
    const existing = fs.readFileSync(resolved, 'utf8').trim();
    if (existing) return existing;
  }
  const created = crypto.randomBytes(32).toString('hex');
  atomicWrite(resolved, created + '\n');
  return created;
}

function bearerToken(request) {
  const header = String(request.headers.authorization || '').trim();
  return /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : '';
}

function tokenMatches(actual, expected) {
  const left = Buffer.from(actual || '', 'utf8');
  const right = Buffer.from(expected || '', 'utf8');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function toolDefinitions() {
  return [
    {
      name: 'list_skills',
      description: 'List skills available to the chat. Returns each canonical name and a short description explaining what the skill does and when to use it. Use this catalog before loading a full skill.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'get_skill',
      description: 'Get the complete SKILL.md for one skill by its canonical name. Read access does not require authentication.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Exact canonical skill name returned by list_skills.' } },
        required: ['name'],
        additionalProperties: false
      }
    },
    {
      name: 'write_skill',
      description: 'Create or replace a skill from Markdown pasted or attached in chat. description is required and must concisely explain both what the skill does and when an agent should use it. The server writes canonical YAML frontmatter. The complete SKILL.md may not exceed 60000 characters. Requires Authorization: Bearer <write token>.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Unique canonical lowercase name used to store and retrieve the skill.' },
          description: { type: 'string', maxLength: MAX_DESCRIPTION_CHARACTERS, description: 'A concise single-line explanation of what the skill does and when to use it.' },
          markdown: { type: 'string', maxLength: MAX_SKILL_CHARACTERS, description: 'Skill Markdown from the chat or attached .md file. Existing frontmatter is replaced with canonical name and description.' },
          overwrite: { type: 'boolean', default: false, description: 'Allow replacing an existing skill.' }
        },
        required: ['name', 'description', 'markdown'],
        additionalProperties: false
      }
    },
    {
      name: 'delete_skill',
      description: 'Delete a skill by its exact canonical name. Returns deleted or not_found. Requires Authorization: Bearer <write token>.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Exact canonical skill name returned by list_skills.' } },
        required: ['name'],
        additionalProperties: false
      }
    }
  ];
}

function textResult(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function createMcpServer({ host, port, dataDirectory, tokenFile }) {
  const sessions = new Set();
  const store = createStore(dataDirectory);
  const writeToken = loadWriteToken(tokenFile);

  function jsonRpc(id, result) {
    return JSON.stringify({ jsonrpc: '2.0', id, result });
  }

  function rpcError(id, code, message) {
    return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  }

  function send(response, status, contentType, body, headers = {}) {
    const bytes = Buffer.from(body || '', 'utf8');
    response.writeHead(status, { 'Content-Type': contentType, 'Content-Length': bytes.length, ...headers });
    response.end(bytes);
  }

  function sendSse(response, payload, sessionId) {
    send(response, 200, 'text/event-stream; charset=utf-8', 'data: ' + payload + '\n\n', sessionId ? { 'Mcp-Session-Id': sessionId } : {});
  }

  async function readBody(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) throw new Error('Request body exceeds 4 MiB.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
      if (request.method === 'GET' && url.pathname === '/') {
        send(response, 200, 'text/plain; charset=utf-8', 'Skills Aggregator MCP');
        return;
      }
      if (request.method === 'GET' && url.pathname === '/healthz') {
        send(response, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, server: SERVER_INFO.name, skills: store.list().length }));
        return;
      }
      if (url.pathname !== '/mcp') {
        send(response, 404, 'application/json; charset=utf-8', JSON.stringify({ error: 'Not found' }));
        return;
      }
      if (request.method === 'DELETE') {
        const sessionId = String(request.headers['mcp-session-id'] || '');
        if (sessionId) sessions.delete(sessionId);
        send(response, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true }));
        return;
      }
      if (request.method !== 'POST') {
        send(response, 405, 'application/json; charset=utf-8', JSON.stringify({ error: 'Method not allowed' }));
        return;
      }

      const payload = JSON.parse((await readBody(request)).toString('utf8'));
      const id = Object.prototype.hasOwnProperty.call(payload, 'id') ? payload.id : null;
      const method = String(payload.method || '');

      if (method === 'initialize') {
        const sessionId = crypto.randomUUID();
        sessions.add(sessionId);
        sendSse(response, jsonRpc(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: 'Call list_skills to discover canonical skill names and when each skill applies, then call get_skill by name to load the complete instructions. write_skill and delete_skill require a Bearer write token.'
        }), sessionId);
        return;
      }

      const sessionId = String(request.headers['mcp-session-id'] || '');
      if (!sessionId) {
        send(response, 400, 'application/json; charset=utf-8', JSON.stringify({ error: 'Session ID is required' }));
        return;
      }
      if (!sessions.has(sessionId)) {
        send(response, 404, 'application/json; charset=utf-8', JSON.stringify({ error: 'Session not found' }));
        return;
      }
      if (method === 'notifications/initialized') {
        response.writeHead(202, { 'Content-Length': 0 });
        response.end();
        return;
      }
      if (method === 'tools/list') {
        sendSse(response, jsonRpc(id, { tools: toolDefinitions() }));
        return;
      }
      if (method === 'tools/call') {
        const name = String(payload.params?.name || '');
        const args = payload.params?.arguments || {};
        let result;
        if (name === 'list_skills') result = textResult({ skills: store.list() });
        else if (name === 'get_skill') result = textResult(store.get(args.name));
        else if (name === 'write_skill') {
          if (!tokenMatches(bearerToken(request), writeToken)) {
            sendSse(response, rpcError(id, -32001, 'Bearer write token is required.'));
            return;
          }
          result = textResult({ saved: true, skill: store.write(args.name, args.description, args.markdown, args.overwrite === true) });
        } else if (name === 'delete_skill') {
          if (!tokenMatches(bearerToken(request), writeToken)) {
            sendSse(response, rpcError(id, -32001, 'Bearer write token is required.'));
            return;
          }
          result = textResult(store.delete(args.name));
        } else {
          sendSse(response, rpcError(id, -32601, 'Unknown tool: ' + name));
          return;
        }
        sendSse(response, jsonRpc(id, result));
        return;
      }
      sendSse(response, rpcError(id, -32601, 'Method not found: ' + method));
    } catch (error) {
      send(response, 500, 'application/json; charset=utf-8', JSON.stringify({ error: error.message }));
    }
  });

  return { server, store, writeToken, listen: () => new Promise(resolve => server.listen(port, host, resolve)) };
}

async function selfTest() {
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'skills-aggregator-'));
  try {
    const store = createStore(path.join(root, 'skills'));
    store.write('sample-skill', 'Tests writing, listing, and loading a skill.', '# Sample Skill\n\nUse this skill.\n', false);
    if (store.list().length !== 1) throw new Error('list smoke failed');
    if (!store.get('sample-skill').markdown.includes('Use this skill.')) throw new Error('get smoke failed');
    let rejected = false;
    try { store.write('../escape', 'Bad path.', 'bad', false); } catch { rejected = true; }
    if (!rejected) throw new Error('path traversal smoke failed');
    rejected = false;
    try { store.write('too-large', 'Large skill.', 'x'.repeat(MAX_SKILL_CHARACTERS), false); } catch { rejected = true; }
    if (!rejected) throw new Error('skill size smoke failed');
    if (!store.delete('sample-skill').deleted || store.delete('sample-skill').status !== 'not_found') throw new Error('delete smoke failed');
    process.stdout.write('SkillsAggregator self-test passed.\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv.includes('--self-test')) {
  selfTest().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const host = option('--host', process.env.SKILLS_HOST || '127.0.0.1');
  const port = Number(option('--port', process.env.SKILLS_PORT || '11611'));
  const dataDirectory = option('--data-dir', process.env.SKILLS_DATA_DIR || path.join(process.cwd(), '.generated', 'skills'));
  const tokenFile = option('--token-file', process.env.SKILLS_WRITE_TOKEN_FILE || path.join(process.cwd(), '.generated', 'write-token.txt'));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be from 1024 to 65535.');
  const service = createMcpServer({ host, port, dataDirectory, tokenFile });
  service.listen().then(() => console.error(`[skills-aggregator] listening on http://${host}:${port}/mcp; data=${service.store.root}`));
}
