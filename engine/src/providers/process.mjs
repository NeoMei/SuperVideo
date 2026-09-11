import { spawn } from 'node:child_process';

export function runProcess(file, args, { input, timeoutMs = 10_000, env = process.env } = {}) {
  return new Promise((resolve) => {
    let stdout = ''; let stderr = ''; let settled = false; let timedOut = false;
    const child = spawn(file, args, { env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ...result, timedOut }); } };
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    }, timeoutMs);
    child.stdout.on('data', (part) => { stdout += part; });
    child.stderr.on('data', (part) => { stderr += part; });
    child.on('error', (error) => finish({ code: null, stdout, stderr: `${stderr}${error.message}`, error }));
    child.on('close', (code) => finish({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}
