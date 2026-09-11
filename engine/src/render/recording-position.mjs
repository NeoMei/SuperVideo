/** Transient hints follow the source clock, including cuts and rate edits. No hints on held frames. */
export function recordingInteraction(scene, localMs) {
  const cut = scene.visual.props.recording.cuts.find(c => localMs >= c.sceneStartMs && localMs < c.sceneStartMs + (c.sourceEndMs - c.sourceStartMs) / c.playbackRate);
  if (!cut) return null;
  const sourceMs = cut.sourceStartMs + (localMs - cut.sceneStartMs) * cut.playbackRate;
  const events = (scene.requiredEvents ?? []).filter(e => e.interaction && e.captureId === cut.captureId && e.sourceId === cut.sourceId && e.videoAssetId === cut.videoAssetId && e.startMs >= cut.sourceStartMs && e.endMs <= cut.sourceEndMs);
  const event = events.find(e => sourceMs >= Math.max(e.startMs, e.interaction.atMs - 350) && sourceMs < Math.min(e.endMs, e.interaction.untilMs ?? Infinity, e.interaction.atMs + 700));
  if (!event) return null;
  const action = event.interaction, age = sourceMs - action.atMs;
  return {...action, phase: age < 0 ? 'prepare' : 'action', progress: age < 0 ? Math.max(0, 1 + age / 350) : age / 700};
}

/** Frame center is the global output frame timestamp; subframe cut clocks remain exact. */
export function recordingPosition(cuts, localMs, media) {
  let previous = null;
  for (const cut of cuts) {
    const end =
      cut.sceneStartMs +
      (cut.sourceEndMs - cut.sourceStartMs) / cut.playbackRate;
    if (localMs < cut.sceneStartMs) break;
    if (localMs < end)
      return {
        assetId: cut.videoAssetId,
        sourceMs:
          cut.sourceStartMs + (localMs - cut.sceneStartMs) * cut.playbackRate,
      };
    previous = cut;
  }
  if (!previous) return null;
  const fps = media[previous.videoAssetId].fps;
  return {
    assetId: previous.videoAssetId,
    sourceMs: Math.max(
      previous.sourceStartMs,
      (Math.floor(((previous.sourceEndMs - 0.00001) * fps) / 1000) * 1000) /
        fps,
    ),
  };
}
