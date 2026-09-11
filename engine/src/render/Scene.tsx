import React from "react";
import {
  AbsoluteFill,
  Img,
  OffthreadVideo,
  Freeze,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { recordingPosition, recordingInteraction } from "./recording-position.mjs";
import { Target, RenderText, Diagram, ActionHint } from "./components";
export function Scene({
  project,
  timeline,
  scene,
  slot,
  settings,
  media,
  components = {},
}: any) {
  const frame = useCurrentFrame(),
    { width, height, fps } = useVideoConfig();
  const portrait = height > width,
    scale = Math.min(width / 1280, height / 720),
    margin = settings.safeMargin * width;
  const fullLesson = settings.lessonPresentation === "fullscreen-overlay-v1" &&
    scene.visual.props.layout !== "narrated";
  const fullPage = fullLesson || settings.pagePresentation === "fullscreen-overlay-v1" &&
    ["page", "image"].includes(scene.visual.kind) &&
    scene.visual.props.layout !== "narrated";
  const wrap = (id: string, children: any, style: any = {}) => (
    <Target id={id} scene={scene} slot={slot} settings={settings} style={style}>
      {children}
    </Target>
  );
  const image = scene.visual.assetIds
    .map((id: string) => media[id])
    .find((a: any) => a?.mediaType.startsWith("image/"));
  const position =
    scene.visual.kind === "recording"
      ? recordingPosition(
          scene.visual.props.recording.cuts,
          Math.max(0, ((slot.from + frame) * 1000) / fps - slot.startMs),
          media,
        )
      : null;
  const text = scene.sentences.map((s: any) => s.text).join(" ");
  const interaction = scene.visual.kind === "recording"
    ? recordingInteraction(scene, Math.max(0, ((slot.from + frame) * 1000) / fps - slot.startMs))
    : null;
  const mediaStyle = {
    width: "100%",
    height: "100%",
    objectFit: "contain" as const,
  };
  const ProjectComponent = components[scene.visual.component];
  if (scene.visual.kind === "component" && !ProjectComponent && !["text", "steps", "comparison"].includes(scene.visual.component)) throw new Error("Reviewed project component missing from frozen registry");
  const visual =
    scene.visual.kind === "diagram" ? (
      <Diagram {...{ scene, slot, settings }} />
    ) : scene.visual.kind === "component" ? (
      ProjectComponent ? <ProjectComponent {...{project, timeline, scene, slot, settings, media}} /> : <RenderText {...{ scene, slot, settings }} />
    ) : scene.visual.kind === "recording" ? (
      position ? (
        <Freeze frame={(position.sourceMs * fps) / 1000}>
          <OffthreadVideo
            muted
            src={staticFile(media[position.assetId].path)}
            style={mediaStyle}
          />
        </Freeze>
      ) : null
    ) : (
      <Img src={staticFile(image.path)} style={mediaStyle} />
    );
  const caption = timeline.captions.find(
    (c: any) =>
      slot.from + frame >= Math.round((c.startMs * fps) / 1000) &&
      slot.from + frame < Math.round((c.endMs * fps) / 1000),
  );
  const sourceMedia =
    scene.visual.kind === "recording"
      ? media[
          position?.assetId ?? scene.visual.props.recording.cuts[0].videoAssetId
        ]
      : image;
  const ratio = sourceMedia ? sourceMedia.width / sourceMedia.height : null;
  const content = (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        containerType: "size",
        position: "relative",
        overflow: fullPage ? "hidden" : undefined,
      }}
    >
      {fullPage && image && ratio && Math.abs(ratio - width / height) > 0.01 && (
        <Img
          aria-hidden
          src={staticFile(image.path)}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%",
            objectFit: "cover", filter: "blur(24px)", transform: "scale(1.08)", opacity: 0.65 }}
        />
      )}
      <div
        style={{
          position: "relative",
          width: ratio ? `min(100cqw, calc(100cqh * ${ratio}))` : "100%",
          height: ratio ? `min(100cqh, calc(100cqw / ${ratio}))` : "100%",
        }}
      >
        {visual}
        {scene.visual.props.overlay && (
          <div
            style={{
              position: "absolute",
              left: "5%",
              right: "5%",
              bottom: "7%",
              padding: 16,
              background: "#102438ba",
              borderRadius: 12,
              fontSize: Math.max(20, 28 * scale),
            }}
          >
            {scene.visual.props.overlay}
          </div>
        )}
        {(scene.visual.props.targets ?? []).map((t: any) =>
          wrap(t.id, null, {
            position: "absolute",
            left: `${t.rect[0] * 100}%`,
            top: `${t.rect[1] * 100}%`,
            width: `${t.rect[2] * 100}%`,
            height: `${t.rect[3] * 100}%`,
          }),
        )}
        {interaction && <ActionHint hint={interaction} scale={scale} />}
      </div>
    </div>
  );
  const sidebar =
    scene.visual.props.layout === "narrated" ||
    (scene.visual.kind === "recording" && scene.visual.props.layout !== "visual");
  const hasTitle = !(fullLesson && ProjectComponent) && (
    Boolean(scene.visual.props.title) ||
    !["page", "image"].includes(scene.visual.kind));
  return (
    <AbsoluteFill
      style={{
        backgroundColor: settings.background,
        color: settings.textColor,
        fontFamily: "SuperVideoFont",
        padding: fullPage ? 0 : margin,
        overflow: fullPage ? "hidden" : undefined,
        boxSizing: "border-box",
      }}
    >
      {hasTitle &&
        wrap(
          "title",
          <div
            style={{
              fontSize:
                settings.fontSize *
                (portrait ? 0.95 : 1.15) *
                Math.max(0.75, scale),
              fontWeight: 600,
              lineHeight: 1.3,
              overflowWrap: "anywhere",
            }}
          >
            {scene.visual.props.title ?? scene.objective}
          </div>,
          fullPage
            ? { position: "absolute", left: margin, right: margin, top: height * 0.04, zIndex: 1,
                padding: "8px 16px", background: "#0009", color: "#fff", borderRadius: 8 }
            : { height: portrait ? "14%" : "16%", flexShrink: 0 },
        )}
      <div
        style={{
          ...(fullPage ? { position: "absolute" as const, inset: 0 } : {}),
          height: fullPage ? "100%" : hasTitle ? "65%" : "82%",
          display: "grid",
          gridTemplateColumns:
            !portrait && sidebar ? "minmax(0,2.3fr) minmax(0,1fr)" : "1fr",
          gridTemplateRows:
            portrait && sidebar ? "minmax(0,1.8fr) minmax(0,1fr)" : "1fr",
          gap: fullPage ? 0 : 24,
          marginTop: fullPage ? 0 : 16,
        }}
      >
        {wrap("visual", content, {
          minHeight: 0,
          minWidth: 0,
          borderRadius: fullPage ? 0 : 16,
          background: fullPage ? "transparent" : "#ffffff08",
          ...(fullPage ? { outlineOffset: -4 } : {}),
          // Project animation cues own their emphasis; never frame the entire lesson canvas.
          ...(fullLesson ? { outline: "none" } : {}),
        })}
        {sidebar &&
          wrap(
            "narration",
            <div
              style={{
                fontSize:
                  Math.min(settings.fontSize, 34) * Math.max(0.7, scale),
                lineHeight: 1.65,
                overflowWrap: "anywhere",
              }}
            >
              {text}
            </div>,
            { alignSelf: "center", padding: 16 },
          )}
      </div>
      {settings.captions &&
        caption &&
        wrap(
          "caption",
          <div
            style={{
              background: fullPage ? "rgba(0,0,0,0.58)" : "#000c",
              color: fullPage ? "#fff" : undefined,
              borderRadius: fullPage ? 8 : 14,
              padding: fullPage ? "10px 22px" : "12px 24px",
              maxWidth: "100%",
              boxSizing: "border-box",
              textAlign: "center",
              ...(fullLesson ? { textWrap: "balance" as const } : {}),
              fontSize: Math.max(
                18,
                settings.captionSize *
                  Math.max(0.8, scale) *
                  Math.min(
                    1,
                    Math.sqrt(
                      (portrait ? 45 : 90) / Math.max(1, caption.text.length),
                    ),
                  ),
              ),
              lineHeight: 1.5,
              overflowWrap: "anywhere",
            }}
          >
            {caption.text}
          </div>,
          {
            position: "absolute",
            left: margin,
            right: margin,
            bottom: height * (fullPage ? 0.04 : settings.safeMargin),
            ...(fullPage ? { display: "flex", justifyContent: "center", zIndex: 2 } : {}),
          },
        )}
    </AbsoluteFill>
  );
}
