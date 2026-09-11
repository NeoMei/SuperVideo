import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
/** Geometry is relative to the contained recording, never to the outer stage. */
export function ActionHint({hint, scale}: any) {
  const [x,y,w,h] = hint.rect;
  const prepare = hint.phase === "prepare", p = hint.progress;
  const opacity = prepare ? 0.55 + p * 0.45 : Math.min(1, (1 - p) * 3);
  const color = "#ffcb45", size = Math.max(28, 44 * scale);
  const point = hint.point ?? [x + w / 2, y + h / 2];
  return <div data-action-hint={hint.kind} style={{position:"absolute",inset:0,pointerEvents:"none",overflow:"hidden",opacity}}>
    <div style={{position:"absolute",left:`${x*100}%`,top:`${y*100}%`,width:`${w*100}%`,height:`${h*100}%`,boxSizing:"border-box",border:`${Math.max(2,3*scale)}px solid ${color}`,borderRadius:6,background:"#ffcb451a",boxShadow:"0 0 0 2px #142236aa"}} />
    <div style={{position:"absolute",left:`${Math.min(x,0.8)*100}%`,...(y>0.13?{bottom:`${(1-y)*100}%`}:{top:`${(y+h)*100}%`}),padding:"4px 10px",marginBlock:8,borderRadius:5,background:"#142236ed",color:"#fff",fontSize:Math.max(16,20*scale),lineHeight:1.35,whiteSpace:"nowrap"}}>
      {prepare ? "即将" : ""}{({click:"点击",fill:"输入",press:"按键"} as any)[hint.kind]}
    </div>
    {hint.kind === "click" && <>
      {!prepare && [0,0.25].map((delay,i)=>{
        const progress=Math.max(0,(p-delay)/(1-delay));
        const diameter=size*(0.55+1.8*progress);
        return <div key={i} style={{position:"absolute",left:`${point[0]*100}%`,top:`${point[1]*100}%`,width:diameter,height:diameter,transform:"translate(-50%,-50%)",border:`${Math.max(2,3*scale)}px solid ${color}`,borderRadius:"50%",background:i===0?"#ffcb4526":"transparent",opacity:p<delay?0:1-progress}} />;
      })}
      <svg viewBox="0 0 32 40" width={size*0.7} height={size*0.88} style={{position:"absolute",left:`${point[0]*100}%`,top:`${point[1]*100}%`,transform:`scale(${prepare?1:1-0.18*Math.sin(Math.PI*Math.min(1,p*3))})`,transformOrigin:"0 0",filter:"drop-shadow(0 2px 2px #0009)"}}>
        <path d="M2 2 L3 30 L10 23 L17 37 L23 34 L16 20 L28 20 Z" fill="white" stroke="#142236" strokeWidth="2.4" />
      </svg>
    </>}
  </div>;
}
export const Target: React.FC<any> = ({
  id,
  scene,
  slot,
  settings,
  children,
  style = {},
}) => {
  const frame = useCurrentFrame() + slot.from,
    { fps, width, height } = useVideoConfig();
  // Keep the marker within the stage even for edge-aligned tiny targets.
  // The node marker fits its existing 24px padding, clear of the text.
  const pointerSize = Math.min(
    id === "visual" ? 52 : 24,
    Math.min(width, height) * settings.safeMargin * 0.8,
  );
  let opacity = 1,
    transform = "",
    border = "none";
  const active: any[] = [];
  for (const cue of scene.cues.filter((c: any) => c.target === id)) {
    const at = slot.cues.find((c: any) => c.id === cue.id).frame;
    const progress = interpolate(
      frame,
      [at, at + Math.max(1, ((cue.params.durationMs ?? 350) * fps) / 1000)],
      [0, 1],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
    );
    if (cue.action === "reveal") opacity *= progress;
    if (frame < at) continue;
    if (cue.action === "move")
      transform += ` translate(${(cue.params.x ?? 0.06) * progress * 100}%,${(cue.params.y ?? 0) * progress * 100}%)`;
    if (cue.action === "zoom")
      transform += ` scale(${1 + ((cue.params.scale ?? 1.12) - 1) * progress})`;
    if (cue.action === "highlight") border = `4px solid ${cue.params.color ?? settings.accent}`;
    if (["point", "compare"].includes(cue.action)) active.push(cue);
  }
  return (
    <div
      data-target={id}
      style={{
        position: "relative",
        opacity,
        transform,
        outline: border,
        outlineOffset: 3,
        ...style,
      }}
    >
      {children}
      {active.map((c) =>
        c.action === "point" ? (
          <span
            key={c.id}
            style={{
              position: "absolute",
              right: 0,
              top: 0,
              width: pointerSize,
              height: pointerSize,
              lineHeight: 1,
              pointerEvents: "none",
              color: settings.accent,
              fontSize: pointerSize,
              textShadow: "0 2px 4px #000",
            }}
          >
            ↙
          </span>
        ) : (
          <div
            key={c.id}
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
              background: "#101c2def",
              padding: 20,
              alignItems: "center",
            }}
          >
            {[c.params.left, c.params.right].map((text: string, i: number) => (
              <div
                key={i}
                style={{
                  padding: 20,
                  border: `2px solid ${settings.accent}`,
                  borderRadius: 12,
                  fontSize: 28,
                  color: settings.textColor,
                }}
              >
                {text}
              </div>
            ))}
          </div>
        ),
      )}
    </div>
  );
};
/** Fixed reviewed repository components. No dynamic imports, HTML, eval or project JS. */
export function RenderText({ scene, slot, settings }: any) {
  const { width, height } = useVideoConfig();
  const portrait = height > width;
  const text = scene.sentences.map((s: any) => s.text).join(" ");
  const items = scene.visual.props.items ?? [text];
  const component = scene.visual.component;
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 24,
        padding: 24,
        boxSizing: "border-box",
      }}
    >
      {component === "comparison" ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: portrait ? "1fr" : "1fr 1fr",
            gap: 20,
          }}
        >
          {items.map((item: string, i: number) => (
            <div
              key={i}
              style={{
                border: `2px solid ${settings.accent}`,
                padding: 24,
                borderRadius: 16,
              }}
            >
              {item}
            </div>
          ))}
        </div>
      ) : (
        items.map((item: string, i: number) => (
          <div
            key={i}
            style={{
              fontSize: Math.min(
                settings.fontSize,
                Math.max(
                  20,
                  settings.fontSize *
                    Math.sqrt(110 / Math.max(110, item.length)),
                ),
              ),
              lineHeight: 1.65,
            }}
          >
            {component === "steps" ? `${i + 1}. ` : ""}
            {item}
          </div>
        ))
      )}
    </div>
  );
}
export function Diagram({ scene, slot, settings }: any) {
  const { width, height } = useVideoConfig();
  const nodes = scene.visual.props.nodes ?? [
      { id: "diagram-default", text: scene.objective },
    ],
    edges = scene.visual.props.edges ?? [];
  const portrait = height > width;
  return (
    <div
      style={{
        display: "flex",
        height: "100%",
        gap: 20,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: portrait ? "column" : "row",
        flexWrap: "wrap",
      }}
    >
      {nodes.map((node: any, i: number) => (
        <React.Fragment key={node.id}>
          <Target
            id={node.id}
            scene={scene}
            slot={slot}
            settings={settings}
            style={{
              border: `2px solid ${settings.accent}`,
              borderRadius: 18,
              padding: 24,
              fontSize: Math.min(settings.fontSize, 32),
              maxWidth: portrait ? "80%" : 220,
            }}
          >
            {node.text}
          </Target>
          {edges
            .filter((e: any) => e.from === node.id)
            .map((e: any) => (
              <div key={e.to} style={{ color: settings.accent, fontSize: 24 }}>
                {portrait ? "↓" : "→"}{" "}
                <span style={{ fontSize: 18 }}>
                  {nodes.find((n: any) => n.id === e.to)?.text}
                </span>
              </div>
            ))}
        </React.Fragment>
      ))}
    </div>
  );
}
