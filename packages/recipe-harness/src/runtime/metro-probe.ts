import http from 'node:http';

export interface MetroReachabilityCheck {
  status: 'up' | 'down' | 'skipped';
}

export function probeMetroPackager(port: number, timeoutMs = 1500): Promise<MetroReachabilityCheck> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/status`, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        const up = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300
          && /packager-status:running/u.test(body);
        resolve({ status: up ? 'up' : 'down' });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 'down' });
    });
    req.on('error', () => resolve({ status: 'down' }));
  });
}