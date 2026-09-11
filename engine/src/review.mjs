import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readProject, withProjectLock, atomicWriteFile } from './core/store.mjs';
import { approvalDigest, approvalSettings, isCurrent } from './core/approvals.mjs';
import { canonicalHash } from './core/model.mjs';
import { projectMediaPath, sha256 } from './providers/assets.mjs';
import { CAPTION_POLICY } from './media/audio.mjs';

/** Generates a read-only human review from the project; review.md is never a script input. */
export async function writeReview(root, { renderManifestPaths = [] } = {}) {
  return withProjectLock(root, async () => {
    const project = await readProject(root);
    const lines = ['# 分镜审阅', '', `项目：${text(project.id)} · 模式：${text(project.mode)} · 修订：${project.revision}`, '',
      '此文件由 project.json 生成；修改讲稿请更新分镜计划后重新生成。预计时间仅为按每秒 4 个非空白字符加 lead/tail 的粗略估算，不能代替真实音频或时间轴。', ''];
    for (const scene of project.scenes) {
      const settings = approvalSettings(project, 'script', [scene.id]);
      const estimatedMs = scene.sentences.reduce((total, sentence) => total + [...sentence.text.replace(/\s/g, '')].length * 250, scene.leadMs + scene.tailMs);
      lines.push(`## 场景 ${text(scene.id)}`, '', `目标：${text(scene.objective)}`, '', `预计时间：${(estimatedMs / 1000).toFixed(2)} 秒（估算；片头留白 ${scene.leadMs} ms，片尾留白 ${scene.tailMs} ms）`, '', '### 原始来源', '');
      const assetIds = new Set(scene.visual.assetIds);
      if (!scene.refs.length) lines.push('- 无来源引用；宿主原创分镜。');
      for (const ref of scene.refs) {
        const source = project.sources.find(s => s.id === ref.sourceId);
        const node = source.nodes.find(n => n.id === ref.nodeId);
        node.assetIds.forEach(id => assetIds.add(id));
        lines.push(`- ${text(source.kind)} · ${text(source.original)}`, `  - sourceId：${code(source.id)}；nodeId：${code(node.id)}；定位：${code(node.locator)}`, `  - 节点 SHA-256：${ref.contentHash}；来源文件 SHA-256：${source.hash}`, `  - 原文：${text(node.text)}`);
        for (const warning of source.warnings) lines.push(`  - 来源提示 ${code(warning.code)}（${code(warning.locator)}）：${text(warning.detail)}`);
      }
      lines.push('', '### 讲稿', '');
      if (!scene.sentences.length) lines.push('- 待补讲稿。');
      for (const line of scene.sentences) {
        const rate = line.audioRate !== undefined && line.audioRate !== 1 ? ` · 语速 ${Number((line.audioRate * 100).toFixed(2))}%` : '';
        lines.push(`- ${text(line.id)} · 音色 ${text(line.voiceId)}${rate}：${text(line.text)}`);
      }
      lines.push('', '### 画面与动作', '', `画面类型：${text(scene.visual.kind)}${scene.visual.component ? `；组件：${text(scene.visual.component)}` : ''}`, '', `画面参数：${text(JSON.stringify(scene.visual.props))}`, '');
      for (const cue of scene.cues) lines.push(`- ${text(cue.id)}：${text(cue.action)} → ${text(cue.target)}；${text(cue.anchor.kind)} ${text(cue.anchor.id)} ${cue.anchor.edge} ${cue.offsetMs} ms；参数 ${text(JSON.stringify(cue.params))}${cue.anchor.kind !== 'sentence' ? '（待准备阶段解析真实证据）' : ''}`);
      lines.push('', `生效设置：${text(JSON.stringify(settings))}`, '', '### 待补资产与准备项', '');
      for (const cast of settings.book?.cast ?? []) cast.referenceAssetIds.forEach(id => assetIds.add(id));
      for (const continuity of settings.book?.continuity ?? []) continuity.propAssetIds.forEach(id => assetIds.add(id));
      if (['page', 'image', 'recording'].includes(scene.visual.kind) && !scene.visual.assetIds.length) lines.push('- 待补画面素材：当前没有绑定画面资产。');
      if (scene.sentences.length) lines.push('- 配音及精确时间待 prepare 验证；本审阅未将字数估算当作音频证据。');
      if (!assetIds.size) lines.push('- 无已绑定文件资产；画面参数见上方。');
      for (const id of assetIds) {
        const asset = project.assets.find(a => a.id === id);
        if (!asset) { lines.push(`- 待补：${text(id)} 未注册。`); continue; }
        let state = '已核对文件 SHA-256';
        try {
          const hash = createHash('sha256').update(await readFile(join(root, asset.path))).digest('hex');
          if (hash !== asset.sha256) state = '待修复：文件 SHA-256 与登记不符';
        } catch (error) { if (error.code === 'ENOENT') state = '待补：文件缺失'; else throw error; }
        lines.push(`- ${text(id)} · ${text(asset.path)} · ${state}；SHA-256 ${asset.sha256}；来源 ${text(asset.origin.kind)} / ${text(asset.origin.reference)} / ${text(asset.origin.version)}`);
      }
      lines.push('', '### 确认记录', '');
      for (const stage of ['script', 'sample', 'final']) lines.push(`- ${stage} / [${text(scene.id)}] 当前摘要：${approvalDigest(project, stage, [scene.id])}`);
      const approvals = project.approvals.filter(a => a.scope.includes(scene.id));
      if (!approvals.length) lines.push('- 尚无确认或显式跳过。');
      for (const approval of approvals) lines.push(`- ${text(approval.stage)} · ${text(approval.decision)} · scope [${approval.scope.map(text).join(', ')}] · ${isCurrent(project, approval) ? '当前有效' : '已失效'} · evidence：${text(approval.evidence)} · digest：${text(approval.digest)}`);
      lines.push('');
    }
    const destination = join(root, 'review.md');
    const machine = await reviewData(root, project, renderManifestPaths);
    await atomicWriteFile(destination, `${lines.join('\n')}\n`);
    await atomicWriteFile(join(root, 'review.json'), `${JSON.stringify(machine, null, 2)}\n`);
    return destination;
  });
}

async function reviewData(root, project, renderManifestPaths) {
  const all = project.scenes.map(scene => scene.id);
  const sample = project.settings.review?.sampleSceneIds ?? all.slice(0, 1);
  const candidate = (stage, scope, target) => ({ stage, scope, digest: approvalDigest(project, stage, scope, target), ...(target ? { target } : {}) });
  const result = {
    schemaVersion: 1, projectId: project.id, revision: project.revision,
    scenes: project.scenes.map(scene => ({ id: scene.id, objective: scene.objective, sentences: scene.sentences, visual: scene.visual, refs: scene.refs })),
    approvals: { script: all.length ? candidate('script', all) : null, sample: all.length ? candidate('sample', sample) : null, final: [] },
    sceneApprovals: all.map(id => ({ sceneId: id, script: candidate('script', [id]), sample: candidate('sample', [id]) })),
    targetWarnings: [],
  };
  const paths = [...new Set([
    ...renderManifestPaths,
    ...project.jobs.filter(job => job.kind === 'render' && job.state === 'succeeded' && job.request?.kind === 'full').map(job => job.manifestPath).filter(Boolean),
    ...project.approvals.filter(a => a.stage === 'final' && a.target).map(a => a.target.manifestPath),
  ])];
  for (const path of paths) {
    try {
      const bytes = await readFile(await projectMediaPath(root, path)), manifest = JSON.parse(bytes);
      if (manifest.kind !== 'full') continue;
      const { renderContentKey } = await import('./render/render.mjs');
      if (manifest.captionPolicy !== CAPTION_POLICY || !Array.isArray(manifest.workflowPaths) || canonicalHash(manifest.scope) !== canonicalHash(all) || manifest.sourceDigest !== renderContentKey(project, all) || project.settings.preparation?.workflowPaths !== undefined && canonicalHash(project.settings.preparation.workflowPaths) !== canonicalHash(manifest.workflowPaths)) {
        result.targetWarnings.push({ path, code: 'OUTPUT_STALE' }); continue;
      }
      result.approvals.final.push(candidate('final', all, { kind: 'render', manifestPath: path, sha256: sha256(bytes) }));
    } catch (error) {
      result.targetWarnings.push({ path, code: error.code ?? 'INVALID_RENDER_MANIFEST' });
    }
  }
  return result;
}

// Render source strings as inert text: no executable HTML, image embeds, headings or forged links.
function text(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_{}\[\]()#+.!|~-]/g, '\\$&').replace(/\r?\n/g, '<br>');
}
function code(value) {
  const content = String(value).replace(/\r?\n/g, ' ');
  const delimiter = '`'.repeat(Math.max(0, ...[...content.matchAll(/`+/g)].map(match => match[0].length)) + 1);
  return `${delimiter} ${content} ${delimiter}`;
}
