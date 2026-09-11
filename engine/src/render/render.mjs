import {assertModePlan} from '../core/readiness.mjs';
import {runRenderWorker} from './render-worker.mjs';
import {claimJob,finishJob,failJob,currentJobKey,outputFiles,verifyOutputs} from '../core/jobs.mjs';
import {refreshComponentSources} from '../core/revise.mjs';
import {lessonSettings} from '../modes/lesson.mjs';
import {freezeComponents, verifiedComponentPath} from './project-components.mjs';
import { bundle } from "./bundle.mjs";
import {
  openBrowser,
  selectComposition,
  renderMedia,
  renderStill,
} from "@remotion/renderer";
import { createServer } from "node:http";
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  rm,
  copyFile,
  realpath,
} from "node:fs/promises";
import { join, dirname, extname, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { readProject, withProjectLock } from "../core/store.mjs";
import { canonicalHash } from "../core/model.mjs";
import { isCurrent, approvalDigest } from "../core/approvals.mjs";
import { prepareTimeline, mixAudio, audioSettings, CAPTION_POLICY } from "../media/audio.mjs";
import { prepareMusicTrack } from "../media/music.mjs";
import { timelineProjectHash } from "../media/timeline.mjs";
import {
  verifiedAssetPath,
  projectMediaPath,
  importAsset,
  mediaError,
  sha256,
} from "../providers/assets.mjs";
import { runProcess } from "../providers/process.mjs";
import { assertRenderProject, scopeTimeline } from "./schema.mjs";
export { scopeTimeline, recordingPosition } from "./schema.mjs";
const entryPoint = fileURLToPath(new URL("./index.tsx", import.meta.url));
const check = (name, evidence) => ({
  name,
  passed: true,
  evidence: typeof evidence === "string" ? evidence : JSON.stringify(evidence),
});
function selection(project, request) {
  if (
    !request ||
    !["sample", "full"].includes(request.kind) ||
    Object.keys(request).some((k) => !["kind", "sceneIds"].includes(k)) ||
    (request.kind === "full" && request.sceneIds !== undefined)
  )
    throw mediaError(
      "INVALID_RENDER_REQUEST",
      "Use sample with sceneIds or full",
    );
  const ids =
    request.kind === "full"
      ? project.scenes.map((s) => s.id)
      : (request.sceneIds ?? [project.scenes[0]?.id]);
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !project.scenes.some((s) => s.id === id))
  )
    throw mediaError(
      "INVALID_RENDER_REQUEST",
      "Scene selection does not resolve",
    );
  return project.scenes.filter((s) => ids.includes(s.id)).map((s) => s.id);
}
function authorize(project, request, scope) {
  const covers = (stage, ids) =>
    ids.every((id) =>
      project.approvals.some(
        (a) =>
          a.stage === stage && a.scope.includes(id) && isCurrent(project, a),
      ),
    );
  if (!covers("script", scope))
    throw mediaError(
      "SCRIPT_APPROVAL_REQUIRED",
      "Current explicit script approval or waiver must cover selected scenes",
    );
  if (request.kind === "full") {
    const sample = project.settings.review?.sampleSceneIds ?? [
      project.scenes[0].id,
    ];
    if (
      !Array.isArray(sample) ||
      !sample.length ||
      new Set(sample).size !== sample.length ||
      sample.some((id) => !project.scenes.some((s) => s.id === id))
    )
      throw mediaError(
        "INVALID_RENDER_REQUEST",
        "settings.review.sampleSceneIds must select existing scenes",
      );
    if (!covers("sample", sample))
      throw mediaError(
        "SAMPLE_APPROVAL_REQUIRED",
        "Current sample approval or waiver must cover designated sampleSceneIds",
      );
  }
}
export const renderContentKey = (p, scope) =>
  canonicalHash({
    digest: approvalDigest(p, "sample", scope),
    review: p.settings.review ?? {},
  });
async function processOk(executable, args, runtime, label) {
  const r = await runProcess(executable, args, {
    timeoutMs: runtime.timeoutMs ?? 120000,
  });
  if (r.code !== 0)
    throw mediaError(
      r.timedOut ? "PROVIDER_TIMEOUT" : "OUTPUT_INVALID",
      `${label}: ${r.stderr.slice(-1200)}`,
    );
  return r;
}
async function probe(path, runtime) {
  const r = await processOk(
    runtime.ffprobe,
    ["-v", "error", "-show_streams", "-show_format", "-of", "json", path],
    runtime,
    "Media probe",
  );
  return JSON.parse(r.stdout);
}
async function copyVerified(root, asset, destination) {
  const path = await verifiedAssetPath(root, asset);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(path, destination);
  if (sha256(await readFile(destination)) !== asset.sha256)
    throw mediaError("ASSET_HASH_MISMATCH", "Asset changed during snapshot");
}
// Fresh snapshots and cache verification must consume the same scoped assets.
function renderAssetIds(project, scope, fontAssetId, timeline) {
  const audio = audioSettings(project, scope);
  return new Set([
    ...project.scenes.filter(s => scope.includes(s.id)).flatMap(s => s.visual.assetIds),
    fontAssetId,
    ...audio.music.map(t => t.assetId),
    ...audio.sfx.map(t => t.assetId),
    ...timeline.audio.map(segment => project.assets.find(a => a.path === segment.path && a.sha256 === segment.sha256)?.id),
  ]);
}
/** Ready originals are frozen, selected, remixed, then copied to a whitelist static directory. */
async function prepareRender(root, request, config) {
  const runtime = config.runtime ?? config;
  const original = await readProject(root),
    scope = selection(original, request);
  assertModePlan(original);
  const selected = {
    ...original,
    scenes: original.scenes.filter((s) => scope.includes(s.id)),
  };
  const settings = assertRenderProject(selected);
  authorize(original, request, scope);
  if (!settings.fontAssetId)
    throw mediaError(
      "FONT_REQUIRED",
      "Import a Chinese-capable font asset and set settings.render.fontAssetId before output approval",
    );
  if (!runtime.ffmpeg || !runtime.ffprobe || !runtime.browserExecutable)
    throw mediaError(
      "DEPENDENCY_MISSING",
      "Configured FFmpeg, ffprobe and Chrome executable required",
    );
  const key = renderContentKey(original, scope),
    directory = await mkdtemp(join(tmpdir(), "supervideo-render-"));
  try {
    const segments = JSON.parse(
      await readFile(
        await projectMediaPath(root, "audio/segments.json"),
        "utf8",
      ),
    );
    // No caller-supplied pure timeline or arbitrary receipt bypasses this boundary.
    const full = await prepareTimeline(root, segments, {
      runtime,
      workflowPaths: config.workflowPaths ?? [],
    });
    if (full.projectHash !== timelineProjectHash(original))
      throw mediaError("RENDER_STALE", "Project changed during preparation");
    const timeline = scopeTimeline(original, full, scope),
      frozen = join(directory, "project"),
      publicDir = join(directory, "public");
    await mkdir(frozen);
    await mkdir(publicDir);
    const project = structuredClone(selected);
    project.approvals = [];
    project.jobs = [];
    project.settings.audio = audioSettings(original, scope);
    if (project.mode === "lesson" && project.settings.components?.some(d => project.scenes.some(s => s.visual.component === d.id))) project.settings.lesson = lessonSettings(original, scope);
    const ids = renderAssetIds(original, scope, settings.fontAssetId, timeline);
    for (const id of ids) {
      const asset = original.assets.find((a) => a.id === id);
      await copyVerified(root, asset, join(frozen, asset.path));
    }
    await writeFile(join(frozen, "project.json"), JSON.stringify(project));
    // Preserve original music source clocks across discontiguous selected windows.
    if (scope.length !== original.scenes.length) {
      const music = [];
      for (const [index, track] of project.settings.audio.music.entries()) {
        const asset = project.assets.find((a) => a.id === track.assetId),
          windows = full.scenes.filter((s) => scope.includes(s.id));
        const fullStem = join(directory, `music-full-${index}.wav`);
        const {startMs, durationMs} = await prepareMusicTrack(root, track, full, fullStem, {runtime});
        if (
          !windows.some(
            (w) =>
              w.startMs < startMs + durationMs &&
              w.startMs + w.durationMs > startMs,
          )
        )
          continue;
        const filter =
          `[0:a]asplit=${windows.length}${windows.map((_, i) => `[a${i}]`).join("")};` +
          windows
            .map(
              (w, i) =>
                `[a${i}]atrim=start=${w.startMs / 1000}:end=${(w.startMs + w.durationMs) / 1000},asetpts=PTS-STARTPTS[m${i}]`,
            )
            .join(";") +
          `;${windows.map((_, i) => `[m${i}]`).join("")}concat=n=${windows.length}:v=0:a=1[out]`;
        const path = join(directory, `music-${index}.wav`);
        await processOk(
          runtime.ffmpeg,
          [
            "-v",
            "error",
            "-i",
            fullStem,
            "-filter_complex",
            filter,
            "-map",
            "[out]",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-y",
            path,
          ],
          runtime,
          "Sample music conform",
        );
        const imported = await importAsset(frozen, {
          path,
          origin: {
            kind: "provider",
            reference: `sample music ${asset.id}`,
            version: key,
          },
        });
        music.push({ assetId: imported.id, volume: track.volume, startMs: 0 });
      }
      project.assets = (await readProject(frozen)).assets;
      project.settings.audio.music = music;
      await writeFile(join(frozen, "project.json"), JSON.stringify(project));
    }
    timeline.projectHash = timelineProjectHash(project);
    const mixed = await mixAudio(frozen, timeline, { runtime });
    const media = {};
    for (const id of new Set([
      ...project.scenes.flatMap((s) => s.visual.assetIds),
      settings.fontAssetId,
    ])) {
      const asset = project.assets.find((a) => a.id === id);
      const path = join(frozen, asset.path);
      const name = `media/${asset.sha256}${extname(asset.path)}`;
      await mkdir(join(publicDir, "media"), { recursive: true });
      await copyFile(path, join(publicDir, name));
      media[id] = { path: name, mediaType: asset.mediaType };
      if (
        asset.mediaType.startsWith("image/") ||
        asset.mediaType.startsWith("video/")
      ) {
        const data = await probe(path, runtime),
          s = data.streams.find((s) => s.codec_type === "video");
        if (!s || !(s.width > 0 && s.height > 0))
          throw mediaError(
            "OUTPUT_INVALID",
            "Visual media has no measured dimensions",
          );
        Object.assign(media[id], { width: s.width, height: s.height });
        await processOk(
          runtime.ffmpeg,
          ["-v", "error", "-i", path, "-f", "null", "-"],
          runtime,
          "Visual full decode",
        );
        if (asset.mediaType.startsWith("video/")) {
          const [a, b] = s.avg_frame_rate.split("/").map(Number);
          if (!(a / b > 0))
            throw mediaError(
              "OUTPUT_INVALID",
              "Video requires measured source fps",
            );
          Object.assign(media[id], {
            fps: a / b,
            durationMs: Number(data.format.duration) * 1000,
          });
        }
      }
    }
    const mixPath = "media/mix.wav";
    await copyFile(join(frozen, mixed.artifacts[0]), join(publicDir, mixPath));
    const componentBundle = await freezeComponents(root, project, join(directory, "components"));
    const inputProps = { project, timeline, settings, media, mixPath };
    await writeFile(
      join(publicDir, "snapshot.json"),
      JSON.stringify(inputProps),
    );
    const verify = async () => {
      const current = await readProject(root);
      authorize(current, request, scope);
      if (renderContentKey(current, scope) !== key)
        throw mediaError(
          "RENDER_STALE",
          "Selected project settings/content changed during rendering",
        );
      for (const d of componentBundle.descriptors) for (const f of d.files) await verifiedComponentPath(root, original.assets.find(a=>a.id===f.assetId));
      for (const id of ids)
        await verifiedAssetPath(
          root,
          original.assets.find((a) => a.id === id),
        );
    };
    await verify();
    const serveUrl = await bundle({
      entryPoint: componentBundle.descriptors.length ? componentBundle.entry : entryPoint,
      publicDir,
      outDir: join(directory, "bundle"),
      rootDir: resolve(dirname(entryPoint), "../.."),
    });
    return {
      directory,
      inputProps,
      serveUrl,
      runtime,
      verify,
      scope,
      key,
      original,
      full,
      mixed,
      frozen,
      componentChecks: componentBundle.checks,
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
export async function renderUntracked(root, request, config = {}, lifecycle = {}) {
  let prepared, browser, phase="prepare";
  try {
    lifecycle.check?.();
    prepared = await prepareRender(root, request, config);
    lifecycle.check?.();
    const { inputProps, serveUrl, runtime } = prepared;
    // Own the browser across all operations, including thrown navigation paths.
    phase="open-browser";
    browser = await openBrowser("chrome", {
      browserExecutable: runtime.browserExecutable,
      logLevel: "error",
    });
    await lifecycle.onBrowser?.(browser);
    const opts = {
      ...(lifecycle.cancelSignal?{cancelSignal:lifecycle.cancelSignal}:{}),
      serveUrl,
      inputProps,
      puppeteerInstance: browser,
      browserExecutable: runtime.browserExecutable,
      timeoutInMilliseconds: runtime.timeoutMs ?? 60000,
    };
    phase="select-composition";
    const composition = await selectComposition({ ...opts, id: "SuperVideo" });
    const out = join(prepared.directory, "output");
    await mkdir(out);
    const video = join(out, "video.mp4");
    const encoded = join(prepared.directory, "remotion.mp4");
    phase="render-media";
    await renderMedia({
      ...opts,
      composition,
      codec: "h264",
      audioCodec: "aac",
      outputLocation: encoded,
      concurrency: config.concurrency ?? 2,
      logLevel: "error",
      enforceAudioTrack: true,
    });
    phase="probe-and-conform";
    const remotionProbe = await probe(encoded, runtime);
    const duration =
      inputProps.timeline.durationInFrames / inputProps.timeline.fps;
    // Remotion's AAC output may contain about 50-60ms trailing padding.
    // Preserve every encoded video frame and remux the same verified exact-length mix.
    await processOk(
      runtime.ffmpeg,
      [
        "-v",
        "error",
        "-i",
        encoded,
        "-i",
        join(prepared.frozen, prepared.mixed.artifacts[0]),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-af",
        `atrim=duration=${duration},asetpts=PTS-STARTPTS`,
        "-t",
        String(duration),
        "-movflags",
        "+faststart",
        "-y",
        video,
      ],
      runtime,
      "Conform final audio duration",
    );
    const data = await probe(video, runtime),
      v = data.streams.find((s) => s.codec_type === "video"),
      a = data.streams.find((s) => s.codec_type === "audio");
    const expected = inputProps.timeline;
    if (
      v?.width !== inputProps.project.output.width ||
      v?.height !== inputProps.project.output.height ||
      Number(v.nb_frames) !== expected.durationInFrames ||
      !a ||
      Math.abs(Number(a.duration) - expected.durationInFrames / expected.fps) >
        Math.max(1 / expected.fps, 1024 / Number(a.sample_rate)) + 1e-6
    )
      throw mediaError(
        "OUTPUT_INVALID",
        `Rendered stream mismatch: ${JSON.stringify({ expected: { ...inputProps.project.output, frames: expected.durationInFrames, duration }, streams: data.streams.map((s) => ({ type: s.codec_type, width: s.width, height: s.height, duration: s.duration, frames: s.nb_frames })) })}`,
      );
    await processOk(
      runtime.ffmpeg,
      ["-v", "error", "-i", video, "-f", "null", "-"],
      runtime,
      "Video full decode",
    );
    const audioDecode = await processOk(
      runtime.ffmpeg,
      [
        "-hide_banner",
        "-i",
        video,
        "-vn",
        "-af",
        "volumedetect",
        "-f",
        "null",
        "-",
      ],
      runtime,
      "Rendered audio verification",
    );
    const audioLevels = {
      meanDb: Number(
        audioDecode.stderr.match(/mean_volume: (-?[\d.]+) dB/)?.[1],
      ),
      peakDb: Number(
        audioDecode.stderr.match(/max_volume: (-?[\d.]+) dB/)?.[1],
      ),
    };
    if (!Number.isFinite(audioLevels.meanDb) || audioLevels.meanDb <= -80)
      throw mediaError("OUTPUT_INVALID", "Encoded audio is silent");
    const frames = [];
    for (const slot of expected.scenes) {
      const scene = inputProps.project.scenes.find((s) => s.id === slot.id);
      const points = [
        { frame: slot.from + Math.floor(slot.durationInFrames * 0.55) },
        ...slot.cues.map((c) => ({
          frame:
            c.frame +
            Math.ceil(
              ((scene.cues.find((v) => v.id === c.id).params.durationMs ??
                350) *
                expected.fps) /
                1000,
            ),
          cueId: c.id,
        })),
      ];
      for (const point of points) {
        const frame = Math.max(
          slot.from,
          Math.min(slot.from + slot.durationInFrames - 1, point.frame),
        );
        const name = `frame-${String(frames.length).padStart(3, "0")}.png`;
        phase="keyframe";
        await renderStill({
          ...opts,
          composition,
          frame,
          output: join(out, name),
          imageFormat: "png",
          logLevel: "error",
        });
        frames.push({
          sceneId: slot.id,
          frame,
          path: name,
          ...(point.cueId ? { cueId: point.cueId } : {}),
        });
      }
    }
    await copyFile(
      join(prepared.frozen, prepared.mixed.artifacts[0]),
      join(out, "mix.wav"),
    );
    await copyFile(
      join(prepared.frozen, prepared.mixed.artifacts[1]),
      join(out, "captions.srt"),
    );
    const manifest = {
      schemaVersion: 1,
      artifactFiles: await outputFiles(out,["video.mp4","mix.wav","captions.srt",...frames.map(f=>f.path)]),
      kind: request.kind,
      workflowPaths: structuredClone(config.workflowPaths ?? []),
      captionPolicy: CAPTION_POLICY,
      scope: prepared.scope,
      sourceDigest: prepared.key,
      sourceApprovals: prepared.original.approvals,
      componentChecks: prepared.componentChecks,
      timeline: expected,
      output: inputProps.project.output,
      settings: inputProps.settings,
      media: inputProps.media,
      frames,
      audioLevels,
      preConformStreams: remotionProbe.streams.map((s) => ({
        type: s.codec_type,
        duration: s.duration,
        frames: s.nb_frames,
      })),
      probe: { ...data, format: { ...data.format, filename: "video.mp4" } },
    };
    await writeFile(
      join(out, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
    phase="publish";
    const relativeDir = `renders/${randomUUID()}`;
    await withProjectLock(root, async () => {
      lifecycle.check?.();
      await prepared.verify();
      await mkdir(join(root, "renders"), { recursive: true });
      await projectMediaPath(root, "renders");
      lifecycle.check?.();
      await mkdir(join(root, relativeDir));
      try {
      for (const name of [
        "video.mp4",
        "mix.wav",
        "captions.srt",
        "manifest.json",
        ...frames.map((f) => f.path),
      ]) {
        lifecycle.check?.();
        await copyFile(join(out, name), join(root, relativeDir, name));
      }
      lifecycle.check?.();
      } catch(error) {await rm(join(root,relativeDir),{recursive:true,force:true});throw error;}
    });
    return {
      status: "succeeded",
      artifacts: [
        "video.mp4",
        "manifest.json",
        "mix.wav",
        "captions.srt",
        ...frames.map((f) => f.path),
      ].map((p) => `${relativeDir}/${p}`),
      checks: [
        ...prepared.componentChecks,
        check("approvals-current", prepared.scope),
        check("verified-timeline", expected.projectHash),
        check("media-ready", inputProps.media),
        check("full-decode", video.split("/").at(-1)),
        check("frame-count", `${expected.durationInFrames}`),
        check("audio-track", a),
        check("audio-levels", audioLevels),
        check("geometry", inputProps.project.output),
      ],
    };
  } catch (error) {
    return {
      status: [
        "COMPONENT_REVIEW_REQUIRED",
        "SCRIPT_APPROVAL_REQUIRED",
        "SAMPLE_APPROVAL_REQUIRED",
        "FONT_REQUIRED",
        "DEPENDENCY_MISSING",
      ].includes(error.code)
        ? "needs_input"
        : "failed",
      artifacts: [],
      checks: [{name:"render-phase",passed:false,evidence:phase}],
      error: { code: error.code ?? "RENDER_FAILED", detail: error.message },
    };
  } finally {
    try {
      if (browser) await (lifecycle.closeBrowser?lifecycle.closeBrowser():browser.close({ silent: true }));
    } finally {
      if (prepared)
        await rm(prepared.directory, { recursive: true, force: true });
    }
  }
}
// Old manifests predate immutable evidence selection. Their videos remain intact,
// but they cannot satisfy a new render request by perpetual cache reuse.
async function reusableManifest(root,job,workflowPaths){
 try{const manifest=JSON.parse(await readFile(await projectMediaPath(root,job.manifestPath)));
  return manifest.captionPolicy===CAPTION_POLICY&&Array.isArray(manifest.workflowPaths)&&canonicalHash(manifest.workflowPaths)===canonicalHash(workflowPaths)&&Array.isArray(manifest.artifactFiles);
 }catch{return false;}
}
/** A durable whole-composition job covers both frozen mixing and Remotion. */
export async function renderVideo(root,request,config={}){
 let job;
 try{
  const project=await refreshComponentSources(root);assertModePlan(project);
  const scope=selection(project,request);
  const spec={id:`render-${canonicalHash(request)}`,kind:'render',sceneIds:scope,request:structuredClone(request),workflowPaths:structuredClone(config.workflowPaths??[]),inputs:[]};
  spec.key=await currentJobKey(root,project,spec);
  const old=project.jobs.find(j=>j.id===spec.id);
  if(old?.state==='succeeded'&&old.receipt&&old.key===spec.key&&await reusableManifest(root,old,spec.workflowPaths)&&await verifyOutputs(root,old.outputFiles,config.runtime)){
   authorize(project,request,scope);
   const segments=JSON.parse(await readFile(join(root,'audio/segments.json')));
   const full=await prepareTimeline(root,segments,config);
   const verifiedKey=await currentJobKey(root,project,spec,segments);
   if(verifiedKey!==spec.key||full.projectHash!==timelineProjectHash(project))throw mediaError('RENDER_STALE','Dependencies changed during cache verification');
   // Even a cached movie cannot bless changed registered media/source bytes.
   const settings=assertRenderProject({...project,scenes:project.scenes.filter(s=>scope.includes(s.id))});
   const used=renderAssetIds(project,scope,settings.fontAssetId,scopeTimeline(project,full,scope));
   for(const id of used)await verifiedAssetPath(root,project.assets.find(a=>a.id===id));
   // Decode/hash work stays outside the lock; publish only its still-current snapshot.
   return await withProjectLock(root,async()=>{
    const current=await readProject(root);
    authorize(current,request,scope);
    const currentJob=current.jobs.find(j=>j.id===spec.id);
    if(!currentJob||canonicalHash(currentJob)!==canonicalHash(old)||await currentJobKey(root,current,spec)!==verifiedKey||timelineProjectHash(current)!==full.projectHash)throw mediaError('RENDER_STALE','Project or cached job changed before cache publication');
    return {...old.receipt,checks:[...old.receipt.checks,check('cache-verified','SHA256, size and full decode')]};
   });
  }
  job=await claimJob(root,spec);
  const receipt=await runRenderWorker(root,request,config);
  if(receipt.status!=='succeeded'){await failJob(root,job,receipt.error);return receipt;}
  const files=await outputFiles(root,receipt.artifacts);
  await finishJob(root,job,{outputFiles:files,manifestPath:receipt.artifacts.find(p=>p.endsWith('/manifest.json')),receipt},async current=>{
   if(await currentJobKey(root,current,spec)!==spec.key)throw mediaError('RENDER_STALE','Audio or creative content changed before job publication');authorize(current,request,scope);
  });return receipt;
 }catch(error){if(job)await failJob(root,job,error);return {status:['JOB_OWNED','COMPONENT_REVIEW_REQUIRED','SCRIPT_APPROVAL_REQUIRED','SAMPLE_APPROVAL_REQUIRED','FONT_REQUIRED','DEPENDENCY_MISSING'].includes(error.code)?'needs_input':'failed',artifacts:[],checks:[],error:{code:error.code??'RENDER_FAILED',detail:error.message}};}
}
/** Serves an immutable read-only composition preview on loopback, including Range for media. */
export async function openPreview(root, config = {}) {
  const prepared = await prepareRender(
    root,
    config.request ?? { kind: "full" },
    config,
  );
  let server;
  try {
    prepared.serveUrl = await realpath(prepared.serveUrl);
    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, "http://localhost");
        let name = decodeURIComponent(url.pathname);
        if (name === "/" || name === "/SuperVideo") name = "/index.html";
        const file = resolve(prepared.serveUrl, `.${name}`);
        if (!file.startsWith(`${prepared.serveUrl}${sep}`))
          throw Error("Path escapes bundle");
        const path = await realpath(file);
        if (!path.startsWith(`${prepared.serveUrl}${sep}`))
          throw Error("Path escapes bundle");
        const bytes = await readFile(path);
        const type =
          {
            ".html": "text/html",
            ".js": "application/javascript",
            ".json": "application/json",
            ".css": "text/css",
            ".wav": "audio/wav",
            ".mp4": "video/mp4",
            ".webm": "video/webm",
            ".png": "image/png",
            ".ttf": "font/ttf",
            ".woff2": "font/woff2",
          }[extname(path)] ?? "application/octet-stream";
        res.setHeader("Content-Type", type);
        res.setHeader("Accept-Ranges", "bytes");
        const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
        if (range) {
          const start = Number(range[1]),
            end = Math.min(
              bytes.length - 1,
              range[2] ? Number(range[2]) : bytes.length - 1,
            );
          if (start > end) {
            res.writeHead(416);
            res.end();
            return;
          }
          res.writeHead(206, {
            "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
            "Content-Length": end - start + 1,
          });
          res.end(bytes.subarray(start, end + 1));
        } else {
          res.setHeader("Content-Length", bytes.length);
          res.end(bytes);
        }
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    let closed = false;
    return {
      url: `http://127.0.0.1:${server.address().port}/SuperVideo`,
      close: async () => {
        if (closed) return;
        closed = true;
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await rm(prepared.directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (server) server.close();
    await rm(prepared.directory, { recursive: true, force: true });
    throw error;
  }
}
