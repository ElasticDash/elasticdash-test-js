import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

export type UiEvent =
  | { type: 'run-start'; payload: { files: string[] } }
  | { type: 'test-start'; payload: { name: string } }
  | { type: 'test-finish'; payload: { name: string; passed: boolean; durationMs: number; errorMessage?: string } }
  | { type: 'run-summary'; payload: { passed: number; failed: number; total: number; durationMs: number; failures: Array<{ name: string; errorMessage?: string }> } }

export interface BrowserUiServer {
  url: string
  send(event: UiEvent): void
  close(): void
}

interface BrowserUiOptions {
  port?: number
  autoOpen?: boolean
}

const defaultHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>ElasticDash Test Runner</title>
  <style>
    :root { font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0b1021; color: #e8ecf7; }
    body { margin: 0; padding: 24px; }
    h1 { margin: 0 0 16px; font-size: 20px; }
    .summary { display: flex; gap: 12px; margin-bottom: 16px; }
    .pill { padding: 8px 12px; border-radius: 999px; font-weight: 600; }
    .pass { background: #12351b; color: #8de0a3; }
    .fail { background: #351212; color: #f59b9b; }
    .total { background: #1c2745; color: #cdd7ff; }
    .tests { margin-top: 12px; }
    .test { border: 1px solid #1f2a4f; border-radius: 8px; padding: 12px; margin-bottom: 8px; background: #0f1731; }
    .name { font-weight: 600; }
    .error { margin-top: 8px; white-space: pre-wrap; color: #f59b9b; font-family: ui-monospace, SFMono-Regular, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; }
    .status { font-weight: 600; }
  </style>
</head>
<body>
  <h1>ElasticDash Test Runner</h1>
  <div class="summary">
    <div class="pill total" id="total">Total: -</div>
    <div class="pill pass" id="passed">Passed: -</div>
    <div class="pill fail" id="failed">Failed: -</div>
  </div>
  <div id="progress">Waiting for test run...</div>
  <div class="tests" id="tests"></div>
  <script>
    const totalEl = document.getElementById('total');
    const passedEl = document.getElementById('passed');
    const failedEl = document.getElementById('failed');
    const progressEl = document.getElementById('progress');
    const testsEl = document.getElementById('tests');

    const tests = new Map();
    let processed = 0;
    let passedCount = 0;
    let failedCount = 0;
    let finalTotal = null;

    function setError(el, message) {
      const errEl = el.querySelector('.error');
      let toggle = el.querySelector('.toggle');
      if (!message) {
        errEl.textContent = '';
        errEl.style.display = 'none';
        if (toggle) toggle.style.display = 'none';
        return;
      }
      if (!toggle) {
        toggle = document.createElement('button');
        toggle.className = 'toggle';
        toggle.textContent = 'Show details';
        toggle.style.marginTop = '8px';
        toggle.style.background = '#1c2745';
        toggle.style.color = '#cdd7ff';
        toggle.style.border = '1px solid #2a3866';
        toggle.style.borderRadius = '6px';
        toggle.style.padding = '6px 10px';
        toggle.style.cursor = 'pointer';
        toggle.style.fontWeight = '600';
        el.appendChild(toggle);
        toggle.addEventListener('click', () => {
          const isHidden = errEl.style.display === 'none';
          errEl.style.display = isHidden ? 'block' : 'none';
          toggle.textContent = isHidden ? 'Hide details' : 'Show details';
        });
      }
      errEl.textContent = message;
      errEl.style.display = 'none';
      toggle.style.display = 'inline-block';
      toggle.textContent = 'Show details';
    }

    function renderTest(name) {
      let el = tests.get(name);
      if (!el) {
        el = document.createElement('div');
        el.className = 'test';
        el.innerHTML = '<div class="name"></div><div class="status"></div><div class="error"></div>';
        tests.set(name, el);
        testsEl.appendChild(el);
      }
      return el;
    }

    function updatePills(passed, failed, total) {
      totalEl.textContent = 'Total: ' + total;
      passedEl.textContent = 'Passed: ' + passed;
      failedEl.textContent = 'Failed: ' + failed;
    }

    const evtSource = new EventSource('/events');
    evtSource.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'test-start') {
          const el = renderTest(msg.payload.name);
          el.querySelector('.name').textContent = msg.payload.name;
          el.querySelector('.status').textContent = 'Running...';
          el.querySelector('.status').style.color = '#cdd7ff';
          el.querySelector('.error').textContent = '';
          progressEl.textContent = 'Running tests...';
        }
        if (msg.type === 'test-finish') {
          const el = renderTest(msg.payload.name);
          el.querySelector('.name').textContent = msg.payload.name;
          el.querySelector('.status').textContent = msg.payload.passed ? 'Passed' : 'Failed';
          el.querySelector('.status').style.color = msg.payload.passed ? '#8de0a3' : '#f59b9b';
          setError(el, msg.payload.errorMessage || '');

          // live tally
          processed += 1;
          if (msg.payload.passed) passedCount += 1;
          else failedCount += 1;
          const displayTotal = finalTotal !== null ? finalTotal : processed;
          updatePills(passedCount, failedCount, displayTotal);
        }
        if (msg.type === 'run-summary') {
          finalTotal = msg.payload.total;
          passedCount = msg.payload.passed;
          failedCount = msg.payload.failed;
          processed = msg.payload.total;
          updatePills(msg.payload.passed, msg.payload.failed, msg.payload.total);
          progressEl.textContent = 'Finished';
          msg.payload.failures.forEach(function (f) {
            const el = renderTest(f.name);
            el.querySelector('.name').textContent = f.name;
            el.querySelector('.status').textContent = 'Failed';
            el.querySelector('.status').style.color = '#f59b9b';
            setError(el, f.errorMessage || '');
          });
        }
      } catch (e) {
        console.error('Bad event data', e);
      }
    };
  </script>
</body>
</html>`

export async function startBrowserUiServer(opts: BrowserUiOptions = {}): Promise<BrowserUiServer | undefined> {
  const autoOpen = opts.autoOpen !== false
  let port = opts.port ?? 4571

  // Ensure base dir for potential static assets (none now)
  const __dirname = path.dirname(fileURLToPath(import.meta.url))

  type FlushableResponse = http.ServerResponse & { flush?: () => void; flushHeaders?: () => void }
  const clients: FlushableResponse[] = []
  const eventBuffer: UiEvent[] = []

  const handler: http.RequestListener = (req, res) => {
    if (!req.url) return res.end()
    if (req.url.startsWith('/events')) {
      const sseRes = res as FlushableResponse
      sseRes.writeHead(200, {
        'Content-Type': 'text/event-stream',
        Connection: 'keep-alive',
        'Cache-Control': 'no-cache',
      })
      // Prime the connection so browsers render immediately
      sseRes.flushHeaders?.()
      sseRes.write(': connected\n\n')
      sseRes.flush?.()
      // Replay all previously sent events so late-connecting browsers get the full history
      for (const e of eventBuffer) {
        sseRes.write(`data: ${JSON.stringify(e)}\n\n`)
      }
      sseRes.flush?.()
      clients.push(sseRes)
      req.on('close', () => {
        const idx = clients.indexOf(sseRes)
        if (idx >= 0) clients.splice(idx, 1)
      })
      return
    }

    // Serve inline HTML
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(defaultHtml)
  }

  let server: http.Server | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let started = false

  while (!started) {
    try {
      server = http.createServer(handler)
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject)
        server!.listen(port, resolve)
      })
      started = true
    } catch (err) {
      port += 1
      if (port > (opts.port ?? 4571) + 10) {
        console.error('[elasticdash] Browser UI server failed to start:', (err as Error).message)
        return undefined
      }
    }
  }

  const url = `http://localhost:${port}`

  function send(event: UiEvent): void {
    eventBuffer.push(event)
    const payload = `data: ${JSON.stringify(event)}\n\n`
    for (const client of [...clients]) {
      client.write(payload)
      client.flush?.()
    }
  }

  function close(): void {
    if (heartbeat) {
      clearInterval(heartbeat)
      heartbeat = undefined
    }
    for (const client of clients) {
      client.end()
    }
    clients.length = 0
    server?.close()
  }

  if (autoOpen) {
    openBrowser(url)
  }

  // Periodic keepalive comments to keep EventSource connections from timing out
  heartbeat = setInterval(() => {
    for (const client of [...clients]) {
      client.write(': keepalive\n\n')
      client.flush?.()
    }
  }, 5000)

  return { url, send, close }
}

function openBrowser(url: string): void {
  const platform = os.platform()
  const command =
    platform === 'darwin'
      ? 'open'
      : platform === 'win32'
      ? 'cmd'
      : 'xdg-open'

  const args = platform === 'win32' ? ['/c', 'start', '""', url] : [url]
  const child = spawn(command, args, { stdio: 'ignore', detached: true })
  child.unref()
}
