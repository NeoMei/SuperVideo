import {componentSettings, componentError} from './components-schema.mjs';
const fail = (message) => {
  throw Object.assign(new Error(message), { code: "INVALID_RENDER_SCHEMA" });
};
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v, allowed) => {
  if (!object(v) || Object.keys(v).some((k) => !allowed.includes(k)))
    fail("Unknown or invalid render fields");
};
const number = (v, min, max) => {
  if (!Number.isFinite(v) || v < min || v > max)
    fail("Render number out of bounds");
};
const string = (v, max = 500) => {
  if (typeof v !== "string" || v.length > max) fail("Invalid render text");
};
const color = (v) => {
  if (typeof v !== "string" || !/^#[0-9a-f]{6}$/i.test(v))
    fail("Use a six-digit hex color");
};
/** This exact projection is consumed by rendering and approvalSettings. */
export function renderSettings(project) {
  const input = project.settings.render ?? {};
  keys(input, [
    "fontAssetId",
    "background",
    "accent",
    "textColor",
    "fontSize",
    "captionSize",
    "captions",
    "safeMargin",
  ]);
  const value = {
    fontAssetId: null,
    background: "#101c2d",
    accent: "#65d7c0",
    textColor: "#f4f7fb",
    fontSize: 42,
    captionSize: 32,
    captions: true,
    safeMargin: 0.06,
    ...input,
    ...(project.mode === "lesson" ? { lessonPresentation: "fullscreen-overlay-v1" } : {}),
    ...(project.mode === "website" ? { interactionPresentation: "measured-actions-v1" } : {}),
    ...(["ppt", "book"].includes(project.mode)
      ? { pagePresentation: "fullscreen-overlay-v1" }
      : {}),
  };
  if (
    value.fontAssetId !== null &&
    (typeof value.fontAssetId !== "string" ||
      !project.assets.some(
        (a) => a.id === value.fontAssetId && a.mediaType.startsWith("font/"),
      ))
  )
    fail("Font asset does not resolve");
  for (const key of ["background", "accent", "textColor"]) color(value[key]);
  number(value.fontSize, 16, 96);
  number(value.captionSize, 16, 64);
  number(value.safeMargin, 0.03, 0.15);
  if (typeof value.captions !== "boolean") fail("captions must be boolean");
  return value;
}
export function assertRenderProject(project) {
  const settings = renderSettings(project);
  const components = componentSettings(project);
  for (const scene of project.scenes) {
    const visual = scene.visual,
      p = visual.props;
    keys(p, [
      "title",
      "overlay",
      "targets",
      "nodes",
      "edges",
      "items",
      "recording",
      "layout",
      "model",
    ]);
    if (p.layout !== undefined && !["visual", "narrated"].includes(p.layout))
      fail("layout must be visual or narrated");
    for (const key of ["title", "overlay"])
      if (p[key] !== undefined) string(p[key], 300);
    if (p.targets !== undefined) {
      if (!Array.isArray(p.targets) || p.targets.length > 50)
        fail("targets must be bounded array");
      for (const t of p.targets) {
        keys(t, ["id", "rect"]);
        string(t.id, 100);
        if (!Array.isArray(t.rect) || t.rect.length !== 4)
          fail("Target rect requires [x,y,width,height]");
        t.rect.forEach((v) => number(v, 0, 1));
        if (
          t.rect[0] + t.rect[2] > 1 ||
          t.rect[1] + t.rect[3] > 1 ||
          !t.rect[2] ||
          !t.rect[3]
        )
          fail("Target rectangle exceeds visual");
      }
    }
    if (
      ["page", "image"].includes(visual.kind) &&
      !visual.assetIds.some((id) =>
        project.assets.find((a) => a.id === id)?.mediaType.startsWith("image/"),
      )
    )
      fail("Page/image requires a registered raster image");
    if (
      visual.kind === "component" &&
      !["text", "steps", "comparison", ...components.map(d=>d.id)].includes(visual.component)
    )
      { throw componentError("Component requires a current host-reviewed source descriptor"); }
    if (p.model !== undefined && (!object(p.model) || !components.some(d=>d.id===visual.component))) fail("model props require a reviewed project component");
    if (p.nodes !== undefined) {
      if (
        visual.kind !== "diagram" ||
        !Array.isArray(p.nodes) ||
        p.nodes.length > 12
      )
        fail("diagram requires at most 12 nodes");
      for (const n of p.nodes) {
        keys(n, ["id", "text"]);
        string(n.id, 100);
        string(n.text, 120);
      }
    }
    if (p.edges !== undefined) {
      if (!Array.isArray(p.edges)) fail("edges must be array");
      for (const e of p.edges) {
        keys(e, ["from", "to"]);
        if (
          !p.nodes?.some((n) => n.id === e.from) ||
          !p.nodes?.some((n) => n.id === e.to)
        )
          fail("Diagram edge does not resolve");
      }
    }
    if (p.items !== undefined) {
      if (!Array.isArray(p.items) || p.items.length > 8)
        fail("items requires at most 8 entries");
      p.items.forEach((v) => string(v, 180));
    }
    const targets = [
      "visual",
      ...(!(settings.lessonPresentation && p.layout !== "narrated" &&
        visual.kind === "component" && components.some(d=>d.id===visual.component)) &&
        (p.title || !["page", "image"].includes(visual.kind)) ? ["title"] : []),
      ...(p.layout === "narrated" || (visual.kind === "recording" && p.layout !== "visual")
        ? ["narration"]
        : []),
      ...(settings.captions ? ["caption"] : []),
      ...(p.targets ?? []).map((t) => t.id),
      ...(p.nodes ?? []).map((n) => n.id),
    ];
    if (
      [...(p.targets ?? []), ...(p.nodes ?? [])].some((t) =>
        ["visual", "title", "narration", "caption"].includes(t.id),
      )
    )
      fail("Target IDs cannot shadow reserved regions");
    if (
      new Set([...(p.targets ?? []), ...(p.nodes ?? [])].map((t) => t.id))
        .size !==
      (p.targets ?? []).length + (p.nodes ?? []).length
    )
      fail("Duplicate visual target IDs");
    for (const cue of scene.cues) {
      if (!targets.includes(cue.target))
        fail(`Unresolved cue target: ${cue.target}`);
      const allowed = {
        highlight: ["durationMs", "color"],
        reveal: ["durationMs"],
        move: ["durationMs", "x", "y"],
        zoom: ["durationMs", "scale"],
        compare: ["durationMs", "left", "right"],
        point: ["durationMs"],
      }[cue.action];
      keys(cue.params, allowed);
      if(cue.params.color!==undefined)color(cue.params.color);
      if (cue.params.durationMs !== undefined)
        number(cue.params.durationMs, 1, 10000);
      for (const k of ["x", "y"])
        if (cue.params[k] !== undefined) number(cue.params[k], -1, 1);
      if (cue.params.scale !== undefined) number(cue.params.scale, 0.5, 3);
      if (cue.action === "compare") {
        string(cue.params.left, 100);
        string(cue.params.right, 100);
      }
    }
  }
  return settings;
}
/** Sample order is always project order. All clocks are recomputed from exact ms. */
export function scopeTimeline(project, timeline, sceneIds) {
  if (
    !Array.isArray(sceneIds) ||
    !sceneIds.length ||
    new Set(sceneIds).size !== sceneIds.length ||
    sceneIds.some((id) => !project.scenes.some((s) => s.id === id))
  )
    fail("Invalid sample sceneIds");
  const frame = (ms) => Math.round((ms * timeline.fps) / 1000),
    result = {
      ...timeline,
      scenes: [],
      audio: [],
      captions: [],
      durationInFrames: 0,
    };
  let start = 0;
  for (const slot of timeline.scenes.filter((s) => sceneIds.includes(s.id))) {
    const delta = start - slot.startMs,
      ids = new Set(
        project.scenes.find((s) => s.id === slot.id).sentences.map((s) => s.id),
      );
    const end = start + slot.durationMs;
    result.scenes.push({
      ...slot,
      from: frame(start),
      startMs: start,
      durationInFrames: frame(end) - frame(start),
      cues: slot.cues.map((c) => {
        if (!Number.isFinite(c.atMs))
          fail("Timeline cue is missing exact atMs; prepare again");
        const atMs = c.atMs + delta;
        return { ...c, atMs, frame: frame(atMs) };
      }),
    });
    result.audio.push(
      ...timeline.audio
        .filter((a) => ids.has(a.sentenceId))
        .map((a) => ({
          ...a,
          startMs: a.startMs + delta,
          from: frame(a.startMs + delta),
          durationInFrames:
            frame(a.startMs + delta + a.durationMs) - frame(a.startMs + delta),
        })),
    );
    result.captions.push(
      ...timeline.captions
        .filter((c) => ids.has(c.id))
        .map((c) => ({
          ...c,
          startMs: c.startMs + delta,
          endMs: c.endMs + delta,
        })),
    );
    start = end;
  }
  result.durationInFrames = frame(start);
  return result;
}
export {recordingPosition} from './recording-position.mjs';
