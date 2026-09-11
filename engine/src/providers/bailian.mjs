import { mediaError } from './assets.mjs';

export const BAILIAN_MODEL = 'qwen3-tts-flash-2025-11-27';
export const BAILIAN_INSTRUCT_MODEL = 'qwen3-tts-instruct-flash-2026-01-26';
export const BAILIAN_DEFAULT_VOICE = Object.freeze({provider:'bailian',model:BAILIAN_MODEL,voice:'Cherry',language:'Chinese'});
const ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const OUTPUT_HOSTS = new Set(['dashscope-result-bj.oss-cn-beijing.aliyuncs.com','dashscope-result-wlcb.oss-cn-wulanchabu.aliyuncs.com']);
const LANGUAGES = ['Auto','Chinese','English','German','Italian','Portuguese','Spanish','Japanese','Korean','French','Russian'];
const PLAIN_MODELS = [BAILIAN_MODEL,'qwen3-tts-flash'];
const MODELS = [...PLAIN_MODELS,BAILIAN_INSTRUCT_MODEL,'qwen3-tts-instruct-flash'];

export function validateBailianVoice(voice) {
  if (!MODELS.includes(voice.model) || !LANGUAGES.includes(voice.language) || typeof voice.voice !== 'string' || !/^[A-Za-z][A-Za-z ]{0,79}$/.test(voice.voice)) throw mediaError('INVALID_VOICE','Bailian requires a supported model, system voice and language');
  if (PLAIN_MODELS.includes(voice.model) && (Object.hasOwn(voice,'instructions') || Object.hasOwn(voice,'optimizeInstructions'))) throw mediaError('BAILIAN_INSTRUCTIONS_UNSUPPORTED','Plain Bailian Flash does not support instructions or optimizeInstructions; explicitly choose an instruct model to use those settings');
  if (voice.instructions !== undefined && (typeof voice.instructions !== 'string' || !voice.instructions.trim() || [...voice.instructions].length > 1600)) throw mediaError('INVALID_VOICE','Bailian instructions must be nonempty and at most 1600 characters');
  if (voice.optimizeInstructions !== undefined && typeof voice.optimizeInstructions !== 'boolean') throw mediaError('INVALID_VOICE','optimizeInstructions must be boolean');
  if (voice.optimizeInstructions && !voice.instructions) throw mediaError('INVALID_VOICE','Instruction optimization requires instructions');
}

function options(runtime) {
  const config=runtime.bailian??{};
  if (!config || typeof config!=='object' || Array.isArray(config) || Object.keys(config).some(k=>!['requestTimeoutMs','downloadTimeoutMs','maxAudioBytes'].includes(k))) throw mediaError('INVALID_BAILIAN_CONFIG','Unsupported Bailian runtime configuration');
  const value={requestTimeoutMs:60000,downloadTimeoutMs:30000,maxAudioBytes:32*1024*1024,...config};
  for (const key of ['requestTimeoutMs','downloadTimeoutMs']) if (!Number.isInteger(value[key]) || value[key]<1 || value[key]>120000) throw mediaError('INVALID_BAILIAN_CONFIG','Bailian timeout must be between 1 and 120000 milliseconds');
  if (!Number.isInteger(value.maxAudioBytes) || value.maxAudioBytes<1 || value.maxAudioBytes>32*1024*1024) throw mediaError('INVALID_BAILIAN_CONFIG','Invalid audio response size limit');
  return value;
}

async function boundedFetch(fetchImpl,url,init,timeoutMs,maxBytes) {
  const controller=new AbortController();
  let rejectTimeout;const timeout=new Promise((_,reject)=>{rejectTimeout=reject;});
  const timer=setTimeout(()=>{controller.abort();rejectTimeout(mediaError('PROVIDER_TIMEOUT','Bailian operation timed out'));},timeoutMs);
  const bounded=operation=>Promise.race([operation,timeout]);
  let reader;
  try {
    const response=await bounded(fetchImpl(url,{...init,redirect:'error',signal:controller.signal}));
    const declared=Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared>maxBytes) throw mediaError('BAILIAN_RESPONSE_TOO_LARGE','Bailian response exceeded the configured size limit');
    reader=response.body?.getReader();const chunks=[];let length=0;
    while (reader) {
      const part=await bounded(reader.read());if(part.done)break;
      length+=part.value.byteLength;
      if(length>maxBytes)throw mediaError('BAILIAN_RESPONSE_TOO_LARGE','Bailian response exceeded the configured size limit');
      chunks.push(Buffer.from(part.value));
    }
    return {status:response.status,ok:response.ok,bytes:Buffer.concat(chunks,length)};
  } catch(error) {
    if (controller.signal.aborted) throw mediaError('PROVIDER_TIMEOUT','Bailian request or audio download timed out; retry explicitly');
    if (error.code==='BAILIAN_RESPONSE_TOO_LARGE') throw error;
    throw mediaError('BAILIAN_NETWORK_ERROR','Bailian transport failed; check network connectivity and retry explicitly');
  } finally {
    clearTimeout(timer);void reader?.cancel().catch(()=>{});
  }
}

function outputUrl(value) {
  let url;try{url=new URL(value);}catch{throw mediaError('BAILIAN_OUTPUT_URL_INVALID','Bailian returned no trusted audio URL');}
  if (!OUTPUT_HOSTS.has(url.hostname) || url.username || url.password || url.port || !['http:','https:'].includes(url.protocol)) throw mediaError('BAILIAN_OUTPUT_URL_INVALID','Bailian returned an untrusted audio URL');
  // Official examples currently return http OSS links. Upgrade the exact known output host before any request.
  url.protocol='https:';return url;
}

/** No retries/fallback. The optional transport is an internal fault-test seam, never project/runtime input. */
export async function requestBailian(text,voice,runtime={}, {apiKey=process.env.DASHSCOPE_API_KEY,fetchImpl=globalThis.fetch}={}) {
  validateBailianVoice(voice);
  if(typeof text!=='string'||!text.trim()||[...text].length>600)throw mediaError('INVALID_SENTENCE','Bailian narration must contain 1–600 characters per sentence');
  const config=options(runtime);
  if(typeof apiKey!=='string'||!apiKey.trim())throw mediaError('TTS_UNAVAILABLE','DASHSCOPE_API_KEY is required for Bailian TTS');
  const input={text,voice:voice.voice,language_type:voice.language};
  if(voice.instructions!==undefined)input.instructions=voice.instructions;
  if(voice.optimizeInstructions!==undefined)input.optimize_instructions=voice.optimizeInstructions;
  const response=await boundedFetch(fetchImpl,ENDPOINT,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${apiKey}`},body:JSON.stringify({model:voice.model,input})},config.requestTimeoutMs,65536);
  let data;try{data=JSON.parse(response.bytes.toString('utf8'));}catch{throw mediaError('BAILIAN_PROTOCOL_ERROR','Bailian returned an invalid JSON response');}
  if(!data||typeof data!=='object'||Array.isArray(data))throw mediaError('BAILIAN_PROTOCOL_ERROR','Bailian returned an invalid response object');
  const rejected=(code,detail)=>Object.assign(mediaError(code,detail),{providerFailure:safeBailianFailure({httpStatus:response.status,serviceCode:data.code,requestId:data.request_id})});
  if (!response.ok || data.code || (data.status_code!==undefined&&data.status_code!==200)) {
    if(data.code==='AllocationQuota.FreeTierOnly')throw rejected('BAILIAN_QUOTA_BLOCKED','Bailian free-tier-only quota policy blocked synthesis (AllocationQuota.FreeTierOnly); account quota must be resolved before retry');
    if(response.status===401)throw rejected('BAILIAN_AUTH_FAILED','Bailian rejected authentication; verify the Beijing-region key');
    if(response.status===429)throw rejected('BAILIAN_RATE_LIMITED','Bailian rate limit reached; retry later explicitly');
    throw rejected('BAILIAN_REQUEST_REJECTED',`Bailian rejected synthesis (HTTP ${response.status}); verify model, voice and account access`);
  }
  const url=outputUrl(data.output?.audio?.url);
  // A signed output URL authorizes this GET; the API key is never forwarded.
  const audio=await boundedFetch(fetchImpl,url,{method:'GET'},config.downloadTimeoutMs,config.maxAudioBytes);
  if(!audio.ok)throw mediaError('BAILIAN_DOWNLOAD_FAILED',`Bailian audio download failed (HTTP ${audio.status})`);
  if(!audio.bytes.length)throw mediaError('OUTPUT_INVALID','Bailian returned empty audio');
  const evidence={provider:'bailian',model:voice.model,voice:voice.voice,language:voice.language,status:'succeeded'};
  if(typeof data.request_id==='string'&&/^[a-f0-9-]{16,64}$/i.test(data.request_id))evidence.requestId=data.request_id;
  for(const key of ['characters','input_tokens','output_tokens','total_tokens'])if(Number.isSafeInteger(data.usage?.[key])&&data.usage[key]>=0)evidence[key]=data.usage[key];
  return {bytes:audio.bytes,evidence};
}

// Service codes are enumerated, never arbitrary response text. IDs use the same
// bounded hexadecimal format as successful receipts; no body or URL survives.
const safeServiceCodes=new Set(['AllocationQuota.FreeTierOnly','InvalidParameter','InvalidApiKey','AccessDenied','Throttling','Throttling.RateQuota','InternalError','ServiceUnavailable','ModelNotFound','InvalidParameter.UnsupportedModel','InvalidParameter.UnsupportedVoice']);
export function safeBailianFailure(value) {
 const safe={};
 if(Number.isInteger(value?.httpStatus)&&value.httpStatus>=100&&value.httpStatus<=599)safe.httpStatus=value.httpStatus;
 if(safeServiceCodes.has(value?.serviceCode))safe.serviceCode=value.serviceCode;
 if(typeof value?.requestId==='string'&&/^[a-f0-9-]{16,64}$/i.test(value.requestId))safe.requestId=value.requestId;
 return safe;
}
