import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { assertProject } from './model.mjs';

const PROJECT_FILE = 'project.json';
const LOCK_FILE = 'project.lock';
const PROCESS_STARTED = `${process.pid}:${Date.now()}:${randomUUID()}`;

export async function createProject(root, { mode, output }) {
  const project = assertProject({
    schemaVersion: 1, id: randomUUID(), revision: 0, mode, output,
    sources: [], assets: [], scenes: [], approvals: [], jobs: [], settings: {},
  });
  await fs.mkdir(root, { recursive: true });
  return withProjectLock(root, async () => {
    try {
      await fs.access(join(root, PROJECT_FILE));
      throw Object.assign(new Error('项目已存在'), { code: 'PROJECT_EXISTS' });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await atomicWriteFile(join(root, PROJECT_FILE), serialize(project));
    return project;
  });
}

export async function readProject(root) {
  let contents;
  try {
    contents = await fs.readFile(join(root, PROJECT_FILE), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw Object.assign(new Error('项目不存在'), { code: 'PROJECT_NOT_FOUND' });
    throw error;
  }
  try {
    return assertProject(JSON.parse(contents));
  } catch (error) {
    if (error.code === 'INVALID_PROJECT') throw error;
    throw Object.assign(new Error(`项目文件不是有效 JSON: ${error.message}`), { code: 'INVALID_PROJECT', cause: error });
  }
}

export async function saveProject(root, project, expectedRevision) {
  assertProject(project);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw Object.assign(new TypeError('expectedRevision 无效'), { code: 'INVALID_REVISION' });
  return withProjectLock(root, async () => {
    const current = await readProject(root);
    if (current.revision !== expectedRevision) throw Object.assign(new Error('项目版本已变化'), { code: 'REVISION_CONFLICT' });
    if (project.id !== current.id) throw Object.assign(new Error('项目 ID 不匹配'), { code: 'PROJECT_ID_MISMATCH' });
    const next = assertProject({ ...project, revision: current.revision + 1 });
    await atomicWriteFile(join(root, PROJECT_FILE), serialize(next));
    return next;
  });
}

/**
 * Runs one project-scoped operation under the shared exclusive store lock.
 * Callers must perform their I/O directly inside the callback and must not
 * call saveProject or withProjectLock recursively.
 */
export async function withProjectLock(root, operation, fsOverride = {}) {
  if (typeof operation !== 'function') throw new TypeError('operation must be a function');
  const lock = await acquireProjectLock(root, fsOverride);
  try { return await operation(); }
  finally { await releaseLock(lock); }
}

/** Atomically replaces a file. fsOverride supports deterministic adapter-level failure tests. */
export async function atomicWriteFile(destination, contents, fsOverride = {}) {
  const io = { ...fs, ...fsOverride };
  const temporary = join(dirname(destination), `.${process.pid}-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await io.open(temporary, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close(); handle = undefined;
    await io.rename(temporary, destination);
    const directory = await io.open(dirname(destination), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await io.unlink(temporary).catch(() => {});
    throw error;
  }
}

// Every primary-lock mutation is serialized by this guard. Never reclaim the
// guard automatically: doing so would recreate the same stale-observer race.
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
function recoveryRequired(path) {
  return Object.assign(new Error(`Lock recovery required at ${path}. Stop all processes using this project, verify no owner remains, then remove the abandoned project.lock.recovery and project.lock; retry. Never remove either while a writer is live.`), { code: 'LOCK_RECOVERY_REQUIRED' });
}
async function ownerState(path, io) {
  let owner;
  try { owner = JSON.parse(await io.readFile(path, 'utf8')); }
  catch (error) { return error.code === 'ENOENT' ? 'missing' : 'unknown'; }
  if (!Number.isInteger(owner.pid) || owner.pid < 1) return 'unknown';
  try { process.kill(owner.pid, 0); return 'live'; }
  catch (error) { return error.code === 'ESRCH' ? 'dead' : 'live'; }
}
async function ownedRemoval(path, handle, io) {
  try {
    const [opened, current] = await Promise.all([handle.stat(), io.stat(path)]);
    if (opened.dev === current.dev && opened.ino === current.ino) await io.unlink(path);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  finally { await handle.close().catch(() => {}); }
}
async function withRecoveryGuard(path, io, operation) {
  const guard = `${path}.recovery`;
  for (let attempt = 0; attempt < 200; attempt++) {
    let handle;
    try { handle = await io.open(guard, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await ownerState(guard, io) === 'dead') throw recoveryRequired(guard);
      await pause(); continue;
    }
    try {
      await handle.writeFile(JSON.stringify({pid:process.pid, processStarted:PROCESS_STARTED, token:randomUUID()}));
      await handle.sync();
      return await operation();
    } finally {
      // No conforming contender can replace our guard: abandonment fails closed.
      await ownedRemoval(guard, handle, io);
    }
  }
  if (await ownerState(guard, io) === 'unknown') throw recoveryRequired(guard);
  throw Object.assign(new Error('项目锁回收正在由另一进程处理'), {code:'PROJECT_LOCKED'});
}
async function acquireProjectLock(root, fsOverride = {}) {
  const io = { ...fs, ...fsOverride }, path = join(root, LOCK_FILE);
  for (let attempt = 0; attempt < 200; attempt++) {
    const lock = await withRecoveryGuard(path, io, async () => {
      let handle;
      try {
        try { handle = await io.open(path, 'wx', 0o600); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const state = await ownerState(path, io);
          if (state === 'unknown') throw recoveryRequired(path);
          if (state === 'live') return null;
          if (state === 'dead') await io.unlink(path);
          handle = await io.open(path, 'wx', 0o600);
        }
        const token = randomUUID();
        await handle.writeFile(JSON.stringify({pid:process.pid, processStarted:PROCESS_STARTED, token})+'\n', 'utf8');
        await handle.sync();
        return {path, handle, io, token};
      } catch (error) {
        if (handle) await ownedRemoval(path, handle, io).catch(() => {});
        throw error;
      }
    });
    if (lock) return lock;
    await pause();
  }
  throw Object.assign(new Error('项目正由另一进程写入'), { code: 'PROJECT_LOCKED' });
}
async function releaseLock({path, handle, io, token}) {
  try {
    await withRecoveryGuard(path, io, async () => {
      let owner;
      try { owner = JSON.parse(await io.readFile(path, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (owner.token !== token) throw recoveryRequired(path);
      await ownedRemoval(path, handle, io);
    });
  } finally { await handle.close().catch(() => {}); }
}

function serialize(value) { return `${JSON.stringify(value, null, 2)}\n`; }
