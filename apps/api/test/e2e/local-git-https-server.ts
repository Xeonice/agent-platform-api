import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpsServer } from 'node:https';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

/**
 * SELF-CONTAINED test scaffolding for git-credential-local.e2e-spec.ts: a LOCAL,
 * BASIC-AUTH-PROTECTED git remote — over HTTPS (self-signed CA) OR plaintext HTTP —
 * that the real product code (project clone workflow + credential materializer +
 * ls-remote tester) can clone from with NO external network and NO real PAT. It pins
 * CI-permanent judgements: wrong token MUST fail, right token MUST pass, execution is
 * HERMETIC, and the credential helper key is SCHEME-AWARE (http AND https both work).
 *
 * The scaffolding traps this deliberately avoids (all empirically confirmed):
 *  1. SMART http only — the clone uses `git clone --depth=1`; dumb http reports
 *     "does not support shallow capabilities". So every request is proxied through
 *     the `git-http-backend` CGI.
 *  2. Scheme-aware credential helper — the materializer keys the helper
 *     `credential.<scheme>://<authority>.helper`, so the helper key MUST match the
 *     remote's actual scheme. The HTTPS variant generates a CA + server cert (SAN =
 *     the bound IP) via openssl and the caller sets GIT_SSL_CAINFO; the HTTP variant
 *     needs NO TLS/CA at all (its whole point is to prove `http://` matches).
 *  3. Bind a PRIVATE, non-loopback IPv4 — RepoUrl's SSRF gate blocks loopback/link
 *     -local but ALLOWS private LAN ranges (self-hosted git is a core use case).
 *  4. Authority carries the (non-default) port — allowedHosts / repoUrl use
 *     `<ip>:<port>`, matching git's port-sensitive credential lookup.
 */

export const TEST_TOKEN = 'local_test_tok_ABC123';
const AUTH_USER = 'x-access-token';

/** A private, non-internal IPv4 (10/8, 172.16-31/12, 192.168/16), or null. */
export function findPrivateIpv4(): string | null {
  const ifaces = networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const p = a.address.split('.').map(Number);
      const [x, y] = p;
      if (x === 10) return a.address;
      if (x === 172 && y >= 16 && y <= 31) return a.address;
      if (x === 192 && y === 168) return a.address;
    }
  }
  return null;
}

export function opensslAvailable(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Path to git-http-backend under `git --exec-path`, or null if it is not present. */
export function gitHttpBackendPath(): string | null {
  try {
    const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
    const candidate = join(execPath, 'git-http-backend');
    // existsSync would follow through, but a plain read of the dir entry is enough:
    // spawn will fail loudly if it is somehow not executable.
    execFileSync('test', ['-x', candidate], { stdio: 'ignore' });
    return candidate;
  } catch {
    return null;
  }
}

export interface LocalGitServer {
  ip: string;
  port: number;
  /** authority = ip:port (non-default port kept), matching the credential scope. */
  host: string;
  /** 'http' | 'https' — the remote's scheme (drives the scheme-aware helper key). */
  scheme: 'http' | 'https';
  /** <scheme>://<ip>:<port>/repo.git */
  repoUrl: string;
  /** self-signed CA path (HTTPS only); undefined for the plaintext HTTP variant. */
  caPath?: string;
  token: string;
  close: () => Promise<void>;
}

interface StartOptions {
  ip: string;
  gitHttpBackend: string;
}

/** Build a bare repo (one commit: README.md + src/app.txt) under a fresh temp root. */
function prepareRepo(): { root: string; projectRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'local-git-'));
  const workDir = join(root, 'work');
  const projectRoot = join(root, 'srv');
  const bareRepo = join(projectRoot, 'repo.git');
  execFileSync('mkdir', ['-p', workDir, projectRoot]);

  const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  git(['init', '-q'], workDir);
  git(['config', 'user.email', 'test@local'], workDir);
  git(['config', 'user.name', 'Local Test'], workDir);
  git(['config', 'commit.gpgsign', 'false'], workDir);
  writeFileSync(join(workDir, 'README.md'), '# local test repo\nhermetic clone target\n');
  execFileSync('mkdir', ['-p', join(workDir, 'src')]);
  writeFileSync(join(workDir, 'src', 'app.txt'), 'nested file\n');
  git(['add', '-A'], workDir);
  git(['commit', '-q', '-m', 'initial'], workDir);
  // smart http via git-http-backend needs NO update-server-info (that is dumb http).
  git(['clone', '-q', '--bare', workDir, bareRepo], projectRoot);
  return { root, projectRoot };
}

/** Resolve the listening address into `{ port, host }`. */
function boundHost(server: Server, ip: string): { port: number; host: string } {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { port, host: `${ip}:${port}` };
}

/**
 * Start a LOCAL, BASIC-AUTH, PLAINTEXT HTTP git remote (no TLS, no CA) bound to the
 * same private non-loopback IP. This is the scheme-aware regression twin of the HTTPS
 * variant: it proves the credential helper keyed `credential.http://<authority>.helper`
 * actually fires for an `http://` remote. Everything lives under one temp root.
 */
export function startLocalGitHttpServer(opts: StartOptions): Promise<LocalGitServer> {
  const { ip, gitHttpBackend } = opts;
  const { root, projectRoot } = prepareRepo();
  const server = createHttpServer((req, res) =>
    handleRequest(req, res, { projectRoot, gitHttpBackend }),
  );
  return new Promise<LocalGitServer>((resolveP, reject) => {
    server.on('error', reject);
    server.listen(0, ip, () => {
      const { port, host } = boundHost(server, ip);
      resolveP({
        ip,
        port,
        host,
        scheme: 'http',
        repoUrl: `http://${host}/repo.git`,
        token: TEST_TOKEN,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => {
              rmSync(root, { recursive: true, force: true });
              r();
            });
          }),
      });
    });
  });
}

/**
 * Prepare a bare repo (with a real commit: README.md + a subdir file), a self-signed
 * CA + server cert (SAN = ip), and start a basic-auth HTTPS server that proxies to
 * git-http-backend. Everything lives under a single temp root removed by close().
 */
export function startLocalGitServer(opts: StartOptions): Promise<LocalGitServer> {
  const { ip, gitHttpBackend } = opts;
  const { root, projectRoot } = prepareRepo();
  const certDir = join(root, 'certs');
  execFileSync('mkdir', ['-p', certDir]);

  // --- certs: CA + server cert whose SAN is the bound IP ---------------------
  const caKey = join(certDir, 'ca.key');
  const caCrt = join(certDir, 'ca.crt');
  const srvKey = join(certDir, 's.key');
  const srvCsr = join(certDir, 's.csr');
  const srvCrt = join(certDir, 's.crt');
  const extCnf = join(certDir, 'ext.cnf');
  const ossl = (args: string[]) => execFileSync('openssl', args, { stdio: 'ignore' });
  ossl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    caKey,
    '-out',
    caCrt,
    '-days',
    '2',
    '-subj',
    '/CN=TestCA',
  ]);
  ossl([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    srvKey,
    '-out',
    srvCsr,
    '-subj',
    `/CN=${ip}`,
  ]);
  writeFileSync(extCnf, `subjectAltName=IP:${ip}\n`);
  ossl([
    'x509',
    '-req',
    '-in',
    srvCsr,
    '-CA',
    caCrt,
    '-CAkey',
    caKey,
    '-CAcreateserial',
    '-out',
    srvCrt,
    '-days',
    '2',
    '-extfile',
    extCnf,
  ]);

  // --- HTTPS server → basic auth → git-http-backend CGI ----------------------
  const server = createHttpsServer(
    { key: readFileSync(srvKey), cert: readFileSync(srvCrt) },
    (req, res) => handleRequest(req, res, { projectRoot, gitHttpBackend }),
  );

  return new Promise<LocalGitServer>((resolveP, reject) => {
    server.on('error', reject);
    server.listen(0, ip, () => {
      const { port, host } = boundHost(server, ip);
      resolveP({
        ip,
        port,
        host,
        scheme: 'https',
        repoUrl: `https://${host}/repo.git`,
        caPath: caCrt,
        token: TEST_TOKEN,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => {
              rmSync(root, { recursive: true, force: true });
              r();
            });
          }),
      });
    });
  });
}

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="git"',
    'Content-Type': 'text/plain',
  });
  res.end('unauthorized');
}

/** Constant-token basic-auth check: Authorization: Basic base64(x-access-token:TOKEN). */
function authOk(header: string | undefined): boolean {
  if (!header) return false;
  const m = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return false;
  }
  const idx = decoded.indexOf(':');
  if (idx < 0) return false;
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  return user === AUTH_USER && pass === TEST_TOKEN;
}

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { projectRoot: string; gitHttpBackend: string },
): void {
  if (!authOk(req.headers.authorization)) {
    unauthorized(res);
    return;
  }
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => runBackend(Buffer.concat(chunks), req, res, ctx));
}

/** Spawn git-http-backend as a CGI, feed the request body, parse the CGI response. */
function runBackend(
  body: Buffer,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { projectRoot: string; gitHttpBackend: string },
): void {
  const url = new URL(req.url ?? '/', 'https://placeholder');
  const env: Record<string, string> = {
    ...process.env,
    GIT_PROJECT_ROOT: ctx.projectRoot,
    GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: url.pathname,
    QUERY_STRING: url.searchParams.toString(),
    REQUEST_METHOD: req.method ?? 'GET',
    REMOTE_ADDR: req.socket.remoteAddress ?? '127.0.0.1',
  };
  const ct = req.headers['content-type'];
  if (typeof ct === 'string') env.CONTENT_TYPE = ct;
  if (req.method === 'POST') env.CONTENT_LENGTH = String(body.length);
  const proto = req.headers['git-protocol'];
  if (typeof proto === 'string') env.GIT_PROTOCOL = proto;

  const child = spawn(ctx.gitHttpBackend, [], { env });
  const out: Buffer[] = [];
  child.stdout.on('data', (c: Buffer) => out.push(c));
  child.stderr.on('data', () => undefined); // swallow; failures surface as clone errors
  child.on('error', () => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  child.on('close', () => forwardCgi(Buffer.concat(out), res));
  if (req.method === 'POST') child.stdin.write(body);
  child.stdin.end();
}

/** Split CGI headers (\r\n\r\n) from the body; honour a `Status:` header if present. */
function forwardCgi(buf: Buffer, res: ServerResponse): void {
  const sep = buf.indexOf('\r\n\r\n');
  if (sep < 0) {
    // No CGI header block — pass through as-is (defensive).
    res.writeHead(200);
    res.end(buf);
    return;
  }
  const headerText = buf.slice(0, sep).toString('latin1');
  const bodyBuf = buf.slice(sep + 4);
  let status = 200;
  const headers: Record<string, string> = {};
  for (const line of headerText.split('\r\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key.toLowerCase() === 'status') {
      status = Number.parseInt(value, 10) || 200;
    } else {
      headers[key] = value;
    }
  }
  res.writeHead(status, headers);
  res.end(bodyBuf);
}
