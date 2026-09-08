// A deliberately plain file server: /3d/ mount, no SPA rewrite or Vite transforms.
// Used by the browser smoke tests and the Pages-like live preview.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const root = resolve('dist');
const prefix = '/3d/';
const port = Number(process.env.PORT || 4174);
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
};

createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://pages.test').pathname);
    if (pathname === '/' || pathname === '/3d') {
      res.writeHead(302, { Location: prefix }).end();
      return;
    }
    if (!pathname.startsWith(prefix)) {
      res.writeHead(404).end('Not found');
      return;
    }
    const path = resolve(root, pathname.slice(prefix.length) || 'index.html');
    if (!path.startsWith(root + sep) || !(await stat(path)).isFile()) {
      res.writeHead(404).end('Not found');
      return;
    }
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, '0.0.0.0', () => {
  console.log(`Pages preview listening on 0.0.0.0:${port}${prefix}`);
});
