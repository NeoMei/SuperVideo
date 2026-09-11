import React, { useEffect, useState, useMemo } from "react";
import {
  Composition,
  Sequence,
  Audio,
  staticFile,
  getInputProps,
  delayRender,
  continueRender,
  cancelRender,
} from "remotion";
import { Scene } from "./Scene";
export function SuperVideo({
  project,
  timeline,
  settings,
  media,
  mixPath,
  components = {},
}: any) {
  const [handle] = useState(() => delayRender("Loading verified font"));
  useEffect(() => {
    let disposed = false;
    const font = new FontFace(
      "SuperVideoFont",
      `url("${staticFile(media[settings.fontAssetId].path)}")`,
    );
    font
      .load()
      .then((loaded) => {
        if (disposed) return;
        document.fonts.add(loaded);
        return document.fonts.ready;
      })
      .then(() => {
        if (!disposed) continueRender(handle);
      })
      .catch(cancelRender);
    return () => {
      disposed = true;
      document.fonts.delete(font);
    };
  }, [handle]);
  return (
    <>
      <Audio src={staticFile(mixPath)} />
      {timeline.scenes.map((slot: any) => (
        <Sequence
          key={slot.id}
          name={slot.id}
          from={slot.from}
          durationInFrames={slot.durationInFrames}
        >
          <Scene
            {...{ project, timeline, settings, media, slot, components }}
            scene={project.scenes.find((s: any) => s.id === slot.id)}
          />
        </Sequence>
      ))}
    </>
  );
}
export function Root({components = {}}: any) {
  const CompositionVideo = useMemo(() => (props: any) => <SuperVideo {...props} components={components} />, [components]);
  const provided: any = getInputProps();
  const [data, setData] = useState<any>(provided.project ? provided : null);
  const [handle] = useState(() =>
    delayRender("Loading verified frozen snapshot"),
  );
  useEffect(() => {
    if (data) {
      continueRender(handle);
      return;
    }
    fetch(staticFile("snapshot.json"))
      .then((r) => {
        if (!r.ok) throw Error("Frozen snapshot missing");
        return r.json();
      })
      .then(setData)
      .catch(cancelRender);
  }, [data, handle]);
  if (!data) return null;
  return (
    <Composition
      id="SuperVideo"
      component={CompositionVideo}
      width={data.project.output.width}
      height={data.project.output.height}
      fps={data.timeline.fps}
      durationInFrames={data.timeline.durationInFrames}
      defaultProps={data}
    />
  );
}
