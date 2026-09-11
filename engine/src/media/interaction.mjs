/** Only measured geometry and action type cross the capture boundary; never input values. */
export function assertInteraction(interaction, startMs, endMs) {
  const fail = () => { throw Object.assign(new Error('Action hint requires measured viewport geometry and an event-local timestamp'), {code: 'INVALID_WEBSITE_PLAN'}); };
  if (!interaction || Object.keys(interaction).some(k => !['kind', 'atMs', 'untilMs', 'rect', 'point'].includes(k)) ||
      !['click', 'fill', 'press'].includes(interaction.kind) || !Number.isFinite(interaction.atMs) || interaction.atMs < startMs || interaction.atMs > endMs) fail();
  if (interaction.untilMs !== undefined && (!Number.isFinite(interaction.untilMs) || interaction.untilMs < interaction.atMs || interaction.untilMs > endMs)) fail();
  const r = interaction.rect;
  if (!Array.isArray(r) || r.length !== 4 || r.some(v => !Number.isFinite(v) || v < 0 || v > 1) || !r[2] || !r[3] || r[0] + r[2] > 1 + 1e-9 || r[1] + r[3] > 1 + 1e-9) fail();
  const p = interaction.point;
  if (interaction.kind === 'click' || p !== undefined) {
    if (!Array.isArray(p) || p.length !== 2 || p.some(v => !Number.isFinite(v) || v < 0 || v > 1) || p[0] < r[0] || p[0] > r[0] + r[2] || p[1] < r[1] || p[1] > r[1] + r[3]) fail();
  }
  return interaction;
}
