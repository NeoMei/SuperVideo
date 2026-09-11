// SuperVideo's read-only preview uses the same composition and core timeline.
import React, {useContext, useEffect, useSyncExternalStore} from 'react';
import {createPortal} from 'react-dom';
import {Internals} from 'remotion';

function PreviewControls({state}:any) {
  const timeline=useContext(Internals.SetTimelineContext);
  const frameState=useContext(Internals.TimelineContext);
  const playing=useSyncExternalStore(timeline.subscribePlaying,timeline.isPlaying);
  const frame=frameState?.frame[state.compositionName]??0;
  const duration=state.compositionDurationInFrames, fps=state.compositionFps;
  useEffect(()=>{
    const resize=()=>{
      const canvas=document.getElementById('remotion-canvas');
      if(!canvas)return;
      const scale=Math.min((innerWidth-32)/state.compositionWidth,(innerHeight-110)/state.compositionHeight,1);
      const container=document.getElementById('video-container')!;
      Object.assign(container.style,{position:'relative',margin:'16px auto',width:`${state.compositionWidth*scale}px`,height:`${state.compositionHeight*scale}px`});
      Object.assign(canvas.style,{position:'relative',transform:`scale(${scale})`,transformOrigin:'top left'});
      Internals.setPortalNodeCurrentScale(scale);
    };
    resize();window.addEventListener('resize',resize);
    return()=>window.removeEventListener('resize',resize);
  },[state]);
  useEffect(()=>{
    if(!playing)return;
    let previous=performance.now(), accumulated=0, animation=0;
    const advance=(now:number)=>{
      if(!timeline.isBuffering()){
        accumulated+=(now-previous)*fps/1000;
        const elapsed=Math.floor(accumulated);
        if(elapsed){
          accumulated-=elapsed;
          const next=Math.min(duration-1,(timeline.frameRef.current[state.compositionName]??0)+elapsed);
          timeline.setFrame(s=>({...s,[state.compositionName]:next}));
          if(next===duration-1){timeline.setPlaying(false);return;}
        }
      }
      previous=now;animation=requestAnimationFrame(advance);
    };
    animation=requestAnimationFrame(advance);
    return()=>cancelAnimationFrame(animation);
  },[playing,timeline,duration,fps,state.compositionName]);
  const toggle=()=>{
    if(!playing&&frame>=duration-1)timeline.setFrame(s=>({...s,[state.compositionName]:0}));
    timeline.setPlaying(!playing);
  };
  return createPortal(<div style={{display:'flex',alignItems:'center',gap:12,maxWidth:960,margin:'auto',padding:16,fontFamily:'sans-serif',color:'white'}}>
    <button onClick={toggle}>{playing?'Pause':'Play'}</button>
    <input aria-label="Frame" type="range" min={0} max={duration-1} value={frame} onChange={e=>{timeline.setPlaying(false);timeline.setFrame(s=>({...s,[state.compositionName]:Number(e.target.value)}));}} style={{flex:1}}/>
    <span>{(frame/fps).toFixed(2)} / {(duration/fps).toFixed(2)} s</span>
  </div>,document.getElementById('supervideo-preview-controls')!);
}

export async function initializePreview() {
  if(typeof window.remotion_puppeteerTimeout!=='undefined')return;
  // The core uses this environment flag to select interactive media components.
  // No Studio code or editor is loaded.
  window.remotion_isStudio=true;
  window.remotion_isReadOnlyStudio=true;
  window.remotion_inputProps??='{}';
  const container=document.createElement('div');
  container.id='supervideo-preview-controls';document.body.appendChild(container);
  try {
    window.remotion_setBundleMode({type:'evaluation'});
    const deadline=performance.now()+30000;
    while(!Internals.compositionsRef.current?.getCompositions().length){
      if(performance.now()>deadline)throw Error('Preview composition did not load');
      await new Promise(requestAnimationFrame);
    }
    const [composition]=await window.getStaticCompositions();
    (window as any).supervideo_previewControls=PreviewControls;
    window.remotion_setBundleMode({type:'composition',compositionName:composition.id,
      compositionDurationInFrames:composition.durationInFrames,compositionFps:composition.fps,
      compositionHeight:composition.height,compositionWidth:composition.width,
      serializedResolvedPropsWithSchema:composition.serializedResolvedPropsWithCustomSchema,
      compositionDefaultCodec:composition.defaultCodec,compositionDefaultOutName:composition.defaultOutName,
      compositionDefaultVideoImageFormat:composition.defaultVideoImageFormat,compositionDefaultPixelFormat:composition.defaultPixelFormat,
      compositionDefaultProResProfile:composition.defaultProResProfile,compositionDefaultSampleRate:composition.defaultSampleRate});
  } catch(error) {container.setAttribute('role','alert');container.textContent=`Preview unavailable: ${(error as Error).message}`;}
}
