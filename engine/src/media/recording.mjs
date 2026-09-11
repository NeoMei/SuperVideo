import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { assertInteraction } from './interaction.mjs';
import { assertProject, canonicalHash } from '../core/model.mjs';
import { atomicWriteFile, readProject, withProjectLock } from '../core/store.mjs';
import { runProcess } from '../providers/process.mjs';
import { openWebsiteBrowser, pageEvidence, websiteAssets, websiteOptions, websiteError, validateCondition, conditionMatches, conditionLocator, waitCondition, maskClosedShadowHosts } from '../inputs/website.mjs';

const now = () => performance.timeOrigin + performance.now();
const publicError = code => ({ code, detail: ({ LOGIN_REQUIRED: 'Complete login using the host browser and resume with external storage state.', UNCERTAIN_ACTION: 'The attempted action has no verified postcondition. Resolve its state before resuming; it was not repeated.', RESUME_STATE_CHANGED: 'The last completed postcondition is no longer visible. Restore the page state before resuming.', CHECKPOINT_MISMATCH: 'Checkpoint does not match this source and request.', CAPTURE_LIMIT: 'Recording reached its configured time or storage limit.', RECORDING_FAILED: 'The browser action or expected UI condition failed. Review captured evidence and the checkpoint.', INCOMPLETE_MEDIA: 'Completed actions lack recoverable verified media. Restore the retained capture files and resume; no actions were repeated.', VIDEO_INVALID: 'The finalized recording failed media validation.' })[code] ?? 'The website request could not be completed.' });

function validateRequest(request) {
  if (!request || Object.keys(request).some(k => !['sourceId', 'steps', 'initial', 'success', 'checkpoint'].includes(k)) || typeof request.sourceId !== 'string' || !Array.isArray(request.steps) || request.steps.length > 100) throw websiteError('INVALID_REQUEST', 'Invalid recording request');
  validateCondition(request.initial); validateCondition(request.success);
  const ids = new Set();
  for (const step of request.steps) {
    if (!step || Object.keys(step).some(k => !['id', 'action', 'role', 'name', 'value', 'expected'].includes(k)) || typeof step.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(step.id) || ids.has(step.id) || !['click', 'fill', 'press', 'wait'].includes(step.action)) throw websiteError('INVALID_REQUEST', 'Invalid or duplicate step');
    validateCondition({ role: step.role, name: step.name }); validateCondition(step.expected); ids.add(step.id);
    if (['fill', 'press'].includes(step.action) && (typeof step.value !== 'string' || step.value.length > 10_000)) throw websiteError('INVALID_REQUEST', 'Step requires a bounded string value');
  }
  if (request.checkpoint !== undefined && !/^[a-f0-9-]{36}$/.test(request.checkpoint)) throw websiteError('INVALID_REQUEST', 'Invalid checkpoint ID');
}

async function encodeCapture(root, directory, config) {
  const frameDirectory = join(root, directory, '.frames');
  const capture = JSON.parse(await readFile(join(frameDirectory, 'capture.json'), 'utf8'));
  const { frames, started, fps } = capture;
  const finalTimestamp = capture.finalTimestamp ?? frames.at(-1)?.timestamp;
  if (!frames.length || !frames.every(f => /^[a-z0-9-]+\.(jpg|png)$/.test(f.name) && Number.isFinite(f.timestamp))) throw websiteError('INCOMPLETE_MEDIA', 'Capture frame metadata missing');
  frames.sort((a, b) => a.timestamp - b.timestamp);
  const firstTimestamp = frames[0].timestamp;
  // Reuse recorded timestamps during media-only recovery; encoding remains separately bounded.
  const endTimestamp = Math.max(finalTimestamp, frames.at(-1).timestamp) + 1000 / fps;
  const retained = frames.filter(f => f.timestamp <= endTimestamp);
  const lines = ['ffconcat version 1.0'];
  for (let i = 0; i < retained.length; i++) {
    const duration = ((retained[i + 1]?.timestamp ?? endTimestamp) - retained[i].timestamp) / 1000;
    if (duration <= 0) continue;
    lines.push(`file '${retained[i].name}'`, 'option framerate 1000', `duration ${duration.toFixed(6)}`);
  }
  lines.push(`file '${retained.at(-1).name}'`, 'option framerate 1000');
  const manifest = join(frameDirectory, 'frames.txt'); await writeFile(manifest, lines.join('\n') + '\n');
  const video = `${directory}/recording.mp4`;
  const encode = await runProcess(config.ffmpeg ?? 'ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', manifest, '-vf', `fps=${fps},pad=ceil(iw/2)*2:ceil(ih/2)*2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(root, video)], { timeoutMs: 60_000 });
  if (encode.code !== 0) throw websiteError('VIDEO_INVALID', 'Video encode failed');
  const probe = await runProcess(config.ffprobe ?? 'ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', join(root, video)]);
  if (probe.code !== 0) throw websiteError('VIDEO_INVALID', 'Video probe failed');
  const metadata = JSON.parse(probe.stdout); const durationMs = Number(metadata.format?.duration) * 1000;
  if (!(durationMs > 0) || !metadata.streams?.some(s => s.codec_type === 'video')) throw websiteError('VIDEO_INVALID', 'Video stream missing');
  const decode = await runProcess(config.ffmpeg ?? 'ffmpeg', ['-v', 'error', '-i', join(root, video), '-f', 'null', '-'], { timeoutMs: 60_000 });
  if (decode.code !== 0) throw websiteError('VIDEO_INVALID', 'Video decode failed');
  const timing = { method: 'chromium-cdp-screencast', clock: 'frame swap epoch; events use host monotonic epoch', firstFrameTimestampMs: firstTimestamp, finalFrameTimestampMs: retained.at(-1).timestamp, captureStartOffsetMs: firstTimestamp - started, durationMs, fps, precisionMs: Math.ceil(1000 / fps), frameCount: retained.length, frameTimestampsMs: retained.map(f => f.timestamp), ffprobe: metadata };
  await atomicWriteFile(join(root, directory, 'timing.json'), JSON.stringify(timing, null, 2));
  return { video, timing };
}

async function publishEvents(root, directory, sourceId, rawEvents, finalized) {
  const paths = [finalized.video, `${directory}/timing.json`]; const events = [];
  const [videoAsset] = await websiteAssets(root, [finalized.video], sourceId);
  for (const event of rawEvents) {
    const startMs = Math.max(0, event.start - finalized.timing.firstFrameTimestampMs); const endMs = Math.max(startMs, event.end - finalized.timing.firstFrameTimestampMs);
    if (endMs > finalized.timing.durationMs + finalized.timing.precisionMs) throw websiteError('INCOMPLETE_MEDIA', 'Event exceeds retained media');
    const eventPath = `${directory}/${event.id}-event.json`;
    const interaction = event.interaction ? assertInteraction({...event.interaction, atMs: Math.max(0, event.interaction.atMs - finalized.timing.firstFrameTimestampMs),
      ...(event.interaction.untilMs!==undefined?{untilMs:Math.max(0,event.interaction.untilMs-finalized.timing.firstFrameTimestampMs)}:{})}, startMs, endMs) : undefined;
    await atomicWriteFile(join(root, eventPath), JSON.stringify({ ...event, interaction, verified: true, startMs, endMs, video: finalized.video, videoAssetId: videoAsset.id, captureId: directory.slice('recordings/'.length), capture: `${directory}/timing.json` }, null, 2));
    paths.push(eventPath, event.before.screenshot, event.before.dom, event.after.screenshot, event.after.dom);
    events.push({ id: event.id, startMs, endMs, evidence: eventPath });
  }
  return { paths, events, segment: { captureId: directory.slice('recordings/'.length), video: finalized.video, videoAssetId: videoAsset.id, timing: `${directory}/timing.json`, events } };
}

/** Chromium CDP frames are written before acknowledgment; timing comes from frame swap timestamps. */
async function beginCapture(session, root, directory, config, fps) {
  await maskClosedShadowHosts(session.page);
  const cdp = await session.context.newCDPSession(session.page);
  const frameDirectory = join(root, directory, '.frames'); await mkdir(frameDirectory, { recursive: true });
  const frames = []; const writes = new Set(); let bytes = 0; let failure; let active = true; let index = 0;
  const started = now();
  let persisted = Promise.resolve();
  const persistFrames = finalTimestamp => { const data = JSON.stringify({ started, fps, frames: [...frames], ...(finalTimestamp ? { finalTimestamp } : {}) }); persisted = persisted.then(() => atomicWriteFile(join(frameDirectory, 'capture.json'), data)); return persisted; };
  await persistFrames();
  const fail = () => { failure = websiteError('CAPTURE_LIMIT', 'Capture limit'); void session.page.close().catch(() => {}); };
  const timer = setTimeout(fail, session.options.maxDurationMs);
  const onFrame = payload => {
    const task = (async () => {
      try {
        if (!active) return;
        const timestamp = payload.metadata.timestamp * 1000;
        if (!Number.isFinite(timestamp) || Math.abs(timestamp - now()) > 10_000) throw websiteError('VIDEO_INVALID', 'Invalid browser frame clock');
        const buffer = Buffer.from(payload.data, 'base64'); bytes += buffer.length;
        if (bytes > session.options.maxBytes) { fail(); return; }
        const name = `frame-${String(index++).padStart(6, '0')}.jpg`;
        await writeFile(join(frameDirectory, name), buffer);
        frames.push({ name, timestamp }); await persistFrames();
      } catch (error) { failure = error; }
      finally { await cdp.send('Page.screencastFrameAck', { sessionId: payload.sessionId }).catch(() => {}); }
    })();
    writes.add(task); void task.finally(() => writes.delete(task));
  };
  cdp.on('Page.screencastFrame', onFrame);
  try { await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, everyNthFrame: 1 }); }
  catch (error) { clearTimeout(timer); active = false; cdp.off('Page.screencastFrame', onFrame); await Promise.all(writes); await cdp.detach().catch(() => {}); throw error; }
  return {
    check() { if (failure) throw failure; },
    async finish() {
      clearTimeout(timer);
      let finalTimestamp = now();
      try {
        // Explicit final image retains the verified visible result even when the page stops repainting.
        await maskClosedShadowHosts(session.page);
        const screenshot = await session.page.screenshot({ type: 'jpeg', quality: 90 });
        finalTimestamp = now(); bytes += screenshot.length;
        if (bytes > session.options.maxBytes) failure = websiteError('CAPTURE_LIMIT', 'Capture limit');
        else { await writeFile(join(frameDirectory, 'final.jpg'), screenshot); frames.push({ name: 'final.jpg', timestamp: finalTimestamp }); }
      } catch { /* Closed page on limit: preserve frames already acquired. */ }
      active = false;
      await cdp.send('Page.stopScreencast').catch(() => {}); cdp.off('Page.screencastFrame', onFrame);
      await Promise.all(writes); await cdp.detach().catch(() => {});
      if (!frames.length) throw failure ?? websiteError('VIDEO_INVALID', 'No recorded frames');
      await persistFrames(finalTimestamp);
      return { failure };
    },
    async abort() { clearTimeout(timer); active = false; cdp.off('Page.screencastFrame', onFrame); await cdp.send('Page.stopScreencast').catch(() => {}); await Promise.all(writes); await cdp.detach().catch(() => {}); },
  };
}

/** Events returned here belong only to this attempt's MP4. Previous attempts remain linked by checkpoint. */
export async function recordWebsite(root, request, config = {}) {
  try { validateRequest(request); websiteOptions(config); }
  catch (error) { return { receipt: { status: 'failed', artifacts: [], checks: [], error: publicError(error.code ?? 'INVALID_REQUEST') }, events: [] }; }
  return withProjectLock(root, async () => {
    const project = await readProject(root); const source = project.sources.find(s => s.id === request.sourceId && s.kind === 'url');
    if (!source) return { receipt: { status: 'failed', artifacts: [], checks: [], error: publicError('SOURCE_NOT_FOUND') }, events: [] };
    const { viewport } = JSON.parse(await readFile(join(root, `sources/${source.id}/website.json`), 'utf8'));
    const requestHash = canonicalHash({ sourceId: request.sourceId, initial: request.initial, success: request.success, steps: request.steps });
    const checkpointId = request.checkpoint ?? randomUUID(); const checkpointPath = `recordings/checkpoints/${checkpointId}/checkpoint.json`;
    let checkpoint;
    if (request.checkpoint) {
      try { checkpoint = JSON.parse(await readFile(join(root, checkpointPath), 'utf8')); } catch { checkpoint = null; }
      if (!checkpoint || checkpoint.requestHash !== requestHash || checkpoint.sourceHash !== source.hash) return { receipt: { status: 'failed', artifacts: [], checks: [], error: publicError('CHECKPOINT_MISMATCH') }, events: [] };
    } else checkpoint = { id: checkpointId, requestHash, sourceId: source.id, sourceHash: source.hash, completed: [], attempted: null, attempts: [] };
    await mkdir(join(root, `recordings/checkpoints/${checkpointId}`), { recursive: true });
    const saveCheckpoint = () => atomicWriteFile(join(root, checkpointPath), JSON.stringify(checkpoint, null, 2));
    if (request.checkpoint) {
      try {
        await recoverAttempts(root,project,source,checkpoint,saveCheckpoint,config);
      } catch {
        return { receipt: { status: 'needs_input', artifacts: [checkpointPath], checks: [{ name: 'complete-action-media', passed: false, evidence: checkpointPath }], error: publicError('INCOMPLETE_MEDIA') }, events: [] };
      }
    }
    const directory = `recordings/${randomUUID()}`; await mkdir(join(root, directory), { recursive: true });
    const paths = []; const rawEvents = [];
    const attempt = { directory, status: 'running', mediaStatus: 'pending' }; checkpoint.attempts.push(attempt);
    const persistEvents = () => atomicWriteFile(join(root, directory, 'attempt.json'), JSON.stringify({ rawEvents }, null, 2)); let session; let capture; let finalized; let error; let status = 'succeeded';
    const evidence = async label => {
      const item = await pageEvidence(session.page, root, `${directory}/${label}`);
      paths.push(item.screenshot, item.dom); return { screenshot: item.screenshot, dom: item.dom };
    };
    try {
      await persistEvents(); await saveCheckpoint();
      session = await openWebsiteBrowser(root, viewport, config);
      const binding = `supervideoAction_${randomUUID().replaceAll('-', '')}`;
      let activeStep, observedInteraction, navigatedAt;
      session.page.on('framenavigated', frame => {
        if (activeStep && frame === session.page.mainFrame()) navigatedAt ??= now();
      });
      await session.page.exposeBinding(binding, ({frame}, payload) => {
        if (frame !== session.page.mainFrame() || payload?.kind !== activeStep?.action || observedInteraction) return;
        const hint = {kind: activeStep.action, atMs: payload.atMs, rect: payload.rect,
          ...(activeStep.action === 'click' ? {point: payload.point} : {})};
        try { assertInteraction(hint, 0, now() + 1000); observedInteraction = hint; } catch { /* No guessed positions. */ }
      });
      await session.page.addInitScript(({binding}) => {
        for (const [eventName,kind] of [['click','click'],['input','fill'],['keydown','press']]) {
          document.addEventListener(eventName, event => {
            if (!event.isTrusted) return;
            const path = event.composedPath().filter(node => node instanceof Element);
            const el = path.find(node => node.matches('button,a[href],input,textarea,select,[role],[contenteditable]')) ?? path[0];
            if (!el) return;
            const r = el.getBoundingClientRect(), vw = innerWidth, vh = innerHeight;
            const left = Math.max(0,r.left), top = Math.max(0,r.top);
            const rect = [left/vw, top/vh, (Math.min(vw,r.right)-left)/vw, (Math.min(vh,r.bottom)-top)/vh];
            void window[binding]({kind, atMs:performance.timeOrigin + performance.now(), rect,
              ...(kind === 'click' ? {point:[event.clientX/vw,event.clientY/vh]} : {})});
          }, {capture:true});
        }
      }, {binding});
      await session.page.goto(source.original, { waitUntil: 'domcontentloaded' });
      capture = await beginCapture(session, root, directory, config, project.output.fps);
      const loginNeeded = async () => session.options.login && await conditionMatches(session.page, session.options.login);
      if (await loginNeeded()) throw websiteError('LOGIN_REQUIRED', 'Login required');
      await waitCondition(session.page, request.initial);
      if (checkpoint.completed.length) {
        const last = request.steps.find(s => s.id === checkpoint.completed.at(-1));
        if (!last || !await conditionMatches(session.page, last.expected)) throw websiteError('RESUME_STATE_CHANGED', 'State changed');
      }
      for (const step of request.steps) {
        if (checkpoint.completed.includes(step.id)) continue;
        capture.check();
        if (await loginNeeded()) throw websiteError('LOGIN_REQUIRED', 'Login required');
        const start = now(); const before = await evidence(`${step.id}-before`); let reconciled = false;
        activeStep = step; observedInteraction = undefined; navigatedAt = undefined;
        if (checkpoint.attempted) {
          if (checkpoint.attempted !== step.id || !await conditionMatches(session.page, step.expected)) throw websiteError('UNCERTAIN_ACTION', 'Uncertain action');
          reconciled = true;
        } else {
          const locator = conditionLocator(session.page, { role: step.role, name: step.name });
          if (step.action === 'fill') {
            const labelTarget = session.page.getByLabel(step.name, { exact: true });
            const privateTarget = /password|token|secret|密码|口令/i.test(step.name) || (await labelTarget.count() === 1 && await labelTarget.evaluate(el => el.type === 'password' || /password|one-time-code/.test(el.autocomplete)));
            if (privateTarget) throw websiteError('LOGIN_REQUIRED', 'Credential entry requires handoff');
          }
          // Durable attempted state precedes every action, including crashes during click/navigation.
          checkpoint.attempted = step.id; await saveCheckpoint();
          if (step.action !== 'wait') {
            // A SPA may replace the node during this read-only preparation.
            // The actual locator action below resolves its current replacement.
            await locator.scrollIntoViewIfNeeded().catch(error => {
              if (!String(error.message).includes('Element is not attached to the DOM')) throw error;
            });
            // Retain a short target-establishing beat in the actual capture.
            await new Promise(resolve => setTimeout(resolve, 350));
          }
          if (step.action === 'click') await locator.click();
          if (step.action === 'fill') await locator.fill(step.value);
          if (step.action === 'press') await locator.press(step.value);
          if (step.action === 'wait') await locator.waitFor({ state: 'visible' });
          await waitCondition(session.page, step.expected);
          if (step.action !== 'wait') await new Promise(resolve => setTimeout(resolve, 700));
        }
        const after = await evidence(`${step.id}-after`); const end = now();
        if (observedInteraction && navigatedAt !== undefined && navigatedAt >= observedInteraction.atMs)
          observedInteraction.untilMs = Math.min(end, navigatedAt);
        rawEvents.push({ id: step.id, start, end, before, after, expected: step.expected, reconciled,
          ...(step.action !== 'wait' && !reconciled && !observedInteraction ? {hintWarning:'ACTION_POSITION_UNAVAILABLE'} : {}),
          ...(observedInteraction && !reconciled ? {interaction: observedInteraction} : {}) });
        activeStep = undefined;
        await persistEvents();
        checkpoint.completed.push(step.id); checkpoint.attempted = null; await saveCheckpoint();
      }
      await waitCondition(session.page, request.success);
      await evidence('final'); capture.check();
    } catch (caught) {
      error = publicError(caught.code ?? 'RECORDING_FAILED');
      if (session?.options.login && await conditionMatches(session.page, session.options.login).catch(() => false)) error = publicError('LOGIN_REQUIRED');
      status = ['LOGIN_REQUIRED', 'UNCERTAIN_ACTION', 'RESUME_STATE_CHANGED'].includes(error.code) ? 'needs_input' : 'failed';
      if (session) await evidence('failure').catch(() => {});
    } finally {
      let captured;
      try { if (capture) captured = await capture.finish(); }
      catch (caught) { status = 'failed'; error = publicError(caught.code ?? 'VIDEO_INVALID'); }
      finally {
        await capture?.abort();
        if (session) await session.context.close().catch(() => {}).finally(() => session.browser.close());
      }
      // Final frames are durable. Release Chrome before encoding so a killed
      // encoder owner cannot leave a browser with no remaining capture work.
      if (captured) {
        try { finalized = { ...await encodeCapture(root, directory, config), failure: captured.failure }; }
        catch (caught) { status = 'failed'; error = publicError(caught.code ?? 'VIDEO_INVALID'); }
      }
    }
    let events = [];
    if (finalized) {
      if (finalized.failure) { status = 'failed'; error = publicError(finalized.failure.code ?? 'CAPTURE_LIMIT'); }
      try {
        const publication = await publishEvents(root, directory, source.id, rawEvents, finalized);
        events = publication.events; paths.push(...publication.paths); attempt.segment = publication.segment; attempt.mediaStatus = 'complete';
      } catch { status = 'needs_input'; error = publicError('INCOMPLETE_MEDIA'); }
    }
    attempt.status = status; if (!attempt.segment) attempt.mediaStatus = 'failed'; await saveCheckpoint();
    const represented = new Set(checkpoint.attempts.flatMap(a => a.segment?.events ?? []).map(e => e.id));
    if (status === 'succeeded' && checkpoint.completed.some(id => !represented.has(id))) { status = 'needs_input'; error = publicError('INCOMPLETE_MEDIA'); }
    const workflowPath = `${directory}/workflow.json`;
    await atomicWriteFile(join(root, workflowPath), JSON.stringify({ schemaVersion: 1, sourceId: source.id, requestHash, status, completed: checkpoint.completed, segments: checkpoint.attempts.filter(a => a.segment).map(a => a.segment) }, null, 2));
    paths.push(workflowPath);
    const receipt = { status, artifacts: [...paths, checkpointPath], checks: [{ name: 'success-condition', passed: status === 'succeeded', evidence: paths.find(p => p === `${directory}/final/dom.json`) ?? paths.find(p => p === `${directory}/failure/dom.json`) ?? checkpointPath }, { name: 'video-probe-and-decode', passed: Boolean(finalized), evidence: finalized ? `${directory}/timing.json` : directory }], ...(error ? { error } : {}) };
    receipt.checks.push({name:'measured-action-hints',passed:!rawEvents.some(e=>e.hintWarning),evidence:rawEvents.filter(e=>e.hintWarning).map(e=>e.id)});
    await atomicWriteFile(join(root, directory, 'receipt.json'), JSON.stringify({ receipt, events }, null, 2)); paths.push(`${directory}/receipt.json`);
    const assets = await websiteAssets(root, paths, source.id); for (const asset of assets) if (!project.assets.some(a => a.id === asset.id)) project.assets.push(asset); project.revision++;
    await atomicWriteFile(join(root, 'project.json'), JSON.stringify(assertProject(project), null, 2));
    return { receipt, events };
  });
}


// Shared durable-media recovery used by explicit website continuation and generic job recovery.
async function recoverAttempts(root,project,source,checkpoint,saveCheckpoint,config){
        for (const previous of checkpoint.attempts) {
          if (previous.segment) {
            const segment = previous.segment;
            const verificationPaths = [segment.video, segment.timing, ...segment.events.map(e => e.evidence)];
            for (const event of segment.events) {
              const evidence = JSON.parse(await readFile(join(root, event.evidence), 'utf8'));
              if (evidence.verified !== true || evidence.id !== event.id || evidence.videoAssetId !== segment.videoAssetId) throw websiteError('INCOMPLETE_MEDIA', 'Historic event is not verified');
              verificationPaths.push(evidence.before.screenshot, evidence.before.dom, evidence.after.screenshot, evidence.after.dom);
            }
            const assets = await websiteAssets(root, verificationPaths, source.id);
            if (assets.find(a => a.path === segment.video)?.id !== segment.videoAssetId) throw websiteError('INCOMPLETE_MEDIA', 'Historic video changed');
            for (const asset of assets) {
              const registered = project.assets.find(a => a.path === asset.path);
              if (registered && registered.sha256 !== asset.sha256) throw websiteError('INCOMPLETE_MEDIA', 'Historic evidence changed');
              if (!registered) project.assets.push(asset);
            }
            const decoded = await runProcess(config.ffmpeg ?? 'ffmpeg', ['-v', 'error', '-i', join(root, segment.video), '-f', 'null', '-'], { timeoutMs: 60_000 });
            if (decoded.code !== 0) throw websiteError('INCOMPLETE_MEDIA', 'Historic video cannot decode');
            continue;
          }
          const { rawEvents: retainedEvents } = JSON.parse(await readFile(join(root, previous.directory, 'attempt.json'), 'utf8'));
          if (!retainedEvents.length) continue;
          const frameDirectory = join(root, previous.directory, '.frames');
          const retained = JSON.parse(await readFile(join(frameDirectory, 'capture.json'), 'utf8'));
          // The durable after-screenshot supplies the last verified result if the process died before finalization.
          const last = retainedEvents.at(-1);
          if (!retained.frames.length) throw websiteError('INCOMPLETE_MEDIA', 'No initial recorded frames');
          if (!retained.finalTimestamp || retained.finalTimestamp < last.end) {
            await writeFile(join(frameDirectory, 'recovered.png'), await readFile(join(root, last.after.screenshot)));
            retained.frames.push({ name: 'recovered.png', timestamp: last.end }); retained.finalTimestamp = last.end;
            await atomicWriteFile(join(frameDirectory, 'capture.json'), JSON.stringify(retained));
          }
          const media = await encodeCapture(root, previous.directory, config);
          const publication = await publishEvents(root, previous.directory, source.id, retainedEvents, media);
          const assets = await websiteAssets(root, publication.paths, source.id);
          for (const asset of assets) if (!project.assets.some(a => a.id === asset.id)) project.assets.push(asset);
          previous.segment = publication.segment; previous.mediaStatus = 'complete';
          for (const event of retainedEvents) if (!checkpoint.completed.includes(event.id)) checkpoint.completed.push(event.id);
          if (retainedEvents.some(e => e.id === checkpoint.attempted)) checkpoint.attempted = null;
        }
        const represented = new Set(checkpoint.attempts.flatMap(a => a.segment?.events ?? []).map(e => e.id));
        if (checkpoint.completed.some(id => !represented.has(id))) throw websiteError('INCOMPLETE_MEDIA', 'Missing historic event media');
        project.revision++; await atomicWriteFile(join(root, 'project.json'), JSON.stringify(assertProject(project), null, 2));
        await saveCheckpoint();
}

/** Finalize existing recordings only. No browser, navigation or UI action is launched. */
export async function recoverRecordingMedia(root,request,config={}){
 try{
  if(!request||Object.keys(request).some(k=>!['sourceId','checkpoint'].includes(k))||typeof request.sourceId!=='string'||! /^[a-f0-9-]{36}$/.test(request.checkpoint))throw websiteError('INVALID_REQUEST','Expected sourceId and checkpoint');
  return await withProjectLock(root,async()=>{
   const project=await readProject(root),source=project.sources.find(s=>s.id===request.sourceId&&s.kind==='url');
   const path=`recordings/checkpoints/${request.checkpoint}/checkpoint.json`;
   const checkpoint=JSON.parse(await readFile(join(root,path)));
   if(!source||checkpoint.sourceId!==source.id||checkpoint.sourceHash!==source.hash||checkpoint.id!==request.checkpoint)throw websiteError('CHECKPOINT_MISMATCH','Checkpoint source changed');
   const save=()=>atomicWriteFile(join(root,path),JSON.stringify(checkpoint,null,2));
   await recoverAttempts(root,project,source,checkpoint,save,config);
   const status=checkpoint.attempted?'needs_input':'succeeded';
   const workflowPath=`recordings/checkpoints/${checkpoint.id}/workflow.json`;
   const segments=checkpoint.attempts.filter(a=>a.segment).map(a=>a.segment);
   await atomicWriteFile(join(root,workflowPath),JSON.stringify({schemaVersion:1,sourceId:source.id,requestHash:checkpoint.requestHash,status,completed:checkpoint.completed,segments},null,2));
   const assets=await websiteAssets(root,[workflowPath],source.id);
   project.assets=project.assets.filter(a=>a.path!==workflowPath);project.assets.push(...assets);project.revision++;
   await atomicWriteFile(join(root,'project.json'),JSON.stringify(assertProject(project),null,2));
   return {receipt:{status,artifacts:[path,workflowPath,...segments.map(s=>s.video)],checks:[{name:'complete-recorded-action-media',passed:true,evidence:'Recovered existing verified action media only; no live website completion asserted'}],...(status==='needs_input'?{error:publicError('UNCERTAIN_ACTION')}:{})},events:segments.flatMap(s=>s.events)};
  });
 }catch(error){return {receipt:{status:'needs_input',artifacts:[],checks:[],error:publicError(error.code==='CHECKPOINT_MISMATCH'?error.code:'INCOMPLETE_MEDIA')},events:[]};}
}
