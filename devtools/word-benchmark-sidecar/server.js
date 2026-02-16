import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { URL } from 'node:url';

const HOST = process.env.SUPERDOC_WORD_BASELINE_HOST ?? '127.0.0.1';
const PORT = Number.parseInt(process.env.SUPERDOC_WORD_BASELINE_PORT ?? '9185', 10);
const JOB_ROOT = path.resolve(
  process.env.SUPERDOC_WORD_BASELINE_DIR ?? path.join(os.tmpdir(), 'superdoc-word-baselines'),
);
const MAX_DOCX_BYTES = Number.parseInt(process.env.SUPERDOC_WORD_BASELINE_MAX_DOCX_BYTES ?? `${40 * 1024 * 1024}`, 10);
const MAX_REQUEST_BYTES = Number.parseInt(
  process.env.SUPERDOC_WORD_BASELINE_MAX_REQUEST_BYTES ?? `${80 * 1024 * 1024}`,
  10,
);
const CLEANUP_AGE_MS = Number.parseInt(
  process.env.SUPERDOC_WORD_BASELINE_CLEANUP_AGE_MS ?? `${6 * 60 * 60 * 1000}`,
  10,
);
const CLEANUP_INTERVAL_MS = Number.parseInt(
  process.env.SUPERDOC_WORD_BASELINE_CLEANUP_INTERVAL_MS ?? `${10 * 60 * 1000}`,
  10,
);
const BENCHMARK_INSTALL_COMMAND = 'npm install -g @superdoc-dev/visual-benchmarks';
const MISSING_BENCHMARK_MESSAGE = [
  "'superdoc-benchmark' was not found in your PATH.",
  `Install it globally: ${BENCHMARK_INSTALL_COMMAND}`,
  'Then restart your SuperDoc dev server.',
].join('\n');

/** @type {Map<string, { id: string, createdAt: number, fileName: string, jobDir: string, pagesDir: string, pages: string[] }>} */
const jobs = new Map();

let queueTail = Promise.resolve();

const withCors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
};

const writeJson = (res, statusCode, payload) => {
  withCors(res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
};

const toErrorMessage = (error) => {
  if (error instanceof Error) return error.message;
  return String(error);
};

const createHttpError = (statusCode, message) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

const readJsonBody = async (req, maxBytes) => {
  const chunks = [];
  let received = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.length;

    if (received > maxBytes) {
      throw createHttpError(413, `Request payload exceeds ${maxBytes} bytes`);
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};

  const bodyText = Buffer.concat(chunks).toString('utf8');

  try {
    return JSON.parse(bodyText);
  } catch {
    throw createHttpError(400, 'Invalid JSON payload');
  }
};

const enqueue = (task) => {
  const next = queueTail.then(task, task);
  queueTail = next.catch(() => {});
  return next;
};

const sanitizeFileName = (input) => {
  const fallback = 'document.docx';
  if (!input || typeof input !== 'string') return fallback;

  const base = path
    .basename(input)
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!base) return fallback;
  if (base.toLowerCase().endsWith('.docx')) return base;
  return `${base}.docx`;
};

const normalizeBase64 = (input) => {
  if (typeof input !== 'string' || !input.trim()) {
    throw createHttpError(400, 'docxBase64 is required');
  }

  const trimmed = input.trim();
  const commaIndex = trimmed.indexOf(',');
  return commaIndex >= 0 ? trimmed.slice(commaIndex + 1) : trimmed;
};

const runWordCapture = async (docxPath, outputRoot) => {
  const args = ['word', docxPath, '--force'];
  const env = {
    ...process.env,
    SUPERDOC_BENCHMARK_SKIP_UPDATE_CHECK: '1',
  };

  await new Promise((resolve, reject) => {
    const child = spawn('superdoc-benchmark', args, {
      cwd: outputRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      if (error && error.code === 'ENOENT') {
        reject(createHttpError(500, MISSING_BENCHMARK_MESSAGE));
        return;
      }
      reject(createHttpError(500, `Failed to start superdoc-benchmark: ${toErrorMessage(error)}`));
    });

    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      const details = stderr.trim().split('\n').slice(-8).join('\n');
      reject(
        createHttpError(
          500,
          `superdoc-benchmark failed (code=${code ?? 'unknown'}, signal=${signal ?? 'none'})${details ? `\n${details}` : ''}`,
        ),
      );
    });
  });
};

const findCapturedPages = async (outputRoot) => {
  const capturesRoot = path.join(outputRoot, 'reports', 'word-captures');

  let entries = [];
  try {
    entries = await fs.readdir(capturesRoot, { withFileTypes: true });
  } catch {
    throw createHttpError(500, 'No Word capture directory was created');
  }

  const candidates = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dirPath = path.join(capturesRoot, entry.name);
    const files = await fs.readdir(dirPath);
    const pages = files.filter((name) => /^page_\d{4}\.png$/i.test(name)).sort((a, b) => a.localeCompare(b, 'en'));

    if (pages.length === 0) continue;

    const stat = await fs.stat(dirPath);
    candidates.push({ dirPath, pages, mtimeMs: stat.mtimeMs });
  }

  if (candidates.length === 0) {
    throw createHttpError(500, 'Word capture completed but no page PNG files were found');
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0];
};

const createJob = async ({ fileName, docxBase64, requestOrigin }) => {
  const normalizedBase64 = normalizeBase64(docxBase64);
  const docxBuffer = Buffer.from(normalizedBase64, 'base64');

  if (docxBuffer.length === 0) {
    throw createHttpError(400, 'Decoded docx payload is empty');
  }

  if (docxBuffer.length > MAX_DOCX_BYTES) {
    throw createHttpError(413, `DOCX exceeds max size (${MAX_DOCX_BYTES} bytes)`);
  }

  const safeFileName = sanitizeFileName(fileName);
  const jobId = crypto.randomUUID();
  const jobDir = path.join(JOB_ROOT, jobId);
  const inputDir = path.join(jobDir, 'input');
  const outputDir = path.join(jobDir, 'output');
  const docxPath = path.join(inputDir, safeFileName);

  await fs.mkdir(inputDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(docxPath, docxBuffer);

  await runWordCapture(docxPath, outputDir);

  const capture = await findCapturedPages(outputDir);

  jobs.set(jobId, {
    id: jobId,
    createdAt: Date.now(),
    fileName: safeFileName,
    jobDir,
    pagesDir: capture.dirPath,
    pages: capture.pages,
  });

  return {
    jobId,
    fileName: safeFileName,
    pageCount: capture.pages.length,
    pages: capture.pages.map((pageName) => {
      const encodedName = encodeURIComponent(pageName);
      return `${requestOrigin}/api/word-baseline/jobs/${jobId}/pages/${encodedName}`;
    }),
  };
};

const cleanupExpiredJobs = async () => {
  const cutoff = Date.now() - CLEANUP_AGE_MS;
  const removals = [];

  for (const [jobId, job] of jobs.entries()) {
    if (job.createdAt >= cutoff) continue;
    jobs.delete(jobId);
    removals.push(fs.rm(job.jobDir, { recursive: true, force: true }));
  }

  if (removals.length > 0) {
    await Promise.allSettled(removals);
  }
};

const getRequestOrigin = (req) => {
  const host = req.headers.host || `${HOST}:${PORT}`;
  return `http://${host}`;
};

const parsePageRoute = (pathname) => {
  const match = pathname.match(/^\/api\/word-baseline\/jobs\/([^/]+)\/pages\/([^/]+)$/);
  if (!match) return null;
  return {
    jobId: decodeURIComponent(match[1]),
    pageName: decodeURIComponent(match[2]),
  };
};

const server = http.createServer(async (req, res) => {
  const method = req.method || 'GET';
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const { pathname } = requestUrl;

  if (method === 'OPTIONS') {
    withCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (method === 'GET' && pathname === '/health') {
    writeJson(res, 200, {
      status: 'ok',
      queueSize: jobs.size,
      host: HOST,
      port: PORT,
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/word-baseline') {
    try {
      const body = await readJsonBody(req, MAX_REQUEST_BYTES);
      const requestOrigin = getRequestOrigin(req);
      const result = await enqueue(() =>
        createJob({
          fileName: body?.fileName,
          docxBase64: body?.docxBase64,
          requestOrigin,
        }),
      );

      writeJson(res, 200, result);
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 500;
      writeJson(res, statusCode, { error: toErrorMessage(error) });
    }
    return;
  }

  if (method === 'GET') {
    const pageRoute = parsePageRoute(pathname);
    if (pageRoute) {
      const job = jobs.get(pageRoute.jobId);
      if (!job) {
        writeJson(res, 404, { error: `Unknown job: ${pageRoute.jobId}` });
        return;
      }

      if (!job.pages.includes(pageRoute.pageName)) {
        writeJson(res, 404, { error: `Unknown page: ${pageRoute.pageName}` });
        return;
      }

      const pagePath = path.join(job.pagesDir, pageRoute.pageName);
      try {
        const png = await fs.readFile(pagePath);
        withCors(res);
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'no-store',
        });
        res.end(png);
      } catch (error) {
        writeJson(res, 500, { error: `Failed to read page image: ${toErrorMessage(error)}` });
      }
      return;
    }
  }

  writeJson(res, 404, { error: `Not found: ${method} ${pathname}` });
});

await fs.mkdir(JOB_ROOT, { recursive: true });

const benchmarkCheck = spawnSync('superdoc-benchmark', ['--version'], {
  stdio: 'ignore',
  shell: false,
});
if (benchmarkCheck.error?.code === 'ENOENT') {
  console.warn(`[word-sidecar] ${MISSING_BENCHMARK_MESSAGE.replace(/\n/g, ' ')}`);
}

const cleanupTimer = setInterval(() => {
  cleanupExpiredJobs().catch((error) => {
    console.warn(`[word-sidecar] cleanup error: ${toErrorMessage(error)}`);
  });
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

server.listen(PORT, HOST, () => {
  console.log(`[word-sidecar] listening on http://${HOST}:${PORT}`);
  console.log(`[word-sidecar] job root: ${JOB_ROOT}`);
});
