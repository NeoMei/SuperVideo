import {componentSettings} from '../render/components-schema.mjs';

export function lessonSettings(project, scope = project.scenes.map(s => s.id)) {
  const lesson = project.settings.lesson;
  if (!lesson || Object.keys(lesson).some(k => !['objectives', 'invariants'].includes(k)) ||
      !Array.isArray(lesson.objectives) || !lesson.objectives.length ||
      !Array.isArray(lesson.invariants) || !lesson.invariants.length) {
    throw Error('Objectives and invariant evidence are required');
  }

  // Validate the full declared guarantees before selecting execution scope.
  const allComponents = componentSettings(project);
  const selectedScenes = project.scenes.filter(s => scope.includes(s.id));
  const componentIds = new Set(selectedScenes.map(s => s.visual.component));
  const components = allComponents.filter(c => componentIds.has(c.id));
  const ids = new Set(components.map(c => c.id));

  for (const objective of lesson.objectives) {
    if (!objective.id || !objective.text || !Array.isArray(objective.sceneIds) ||
        !objective.sceneIds.length || objective.sceneIds.some(id => !project.scenes.some(s => s.id === id))) {
      throw Error('Objective scene mapping missing');
    }
  }
  for (const invariant of lesson.invariants) {
    if (!invariant.id || !invariant.component || !/^[$A-Z_a-z][$\w]*$/.test(invariant.check) ||
        typeof invariant.evidence !== 'string' || !invariant.evidence.trim()) {
      throw Error('Named check and evidence required');
    }
    const descriptor = allComponents.find(c => c.id === invariant.component);
    if (!descriptor) throw Error('Invariant component must resolve to a reviewed project component');
    if (!descriptor.checks.includes(invariant.check)) {
      throw Error('Invariant must name a reviewed model check export');
    }
  }
  for (const scene of selectedScenes) {
    const descriptor = components.find(c => c.id === scene.visual.component);
    if (!lesson.objectives.some(o => o.sceneIds.includes(scene.id))) {
      throw Error('Every teaching scene needs an objective');
    }
    if (descriptor && !lesson.invariants.some(i => i.component === descriptor.id)) {
      throw Error('Every project teaching component needs an invariant');
    }
    if (!descriptor && scene.visual.kind === 'component' &&
        !['text', 'steps', 'comparison'].includes(scene.visual.component)) {
      throw Error('Teaching component needs host-reviewed source');
    }
  }
  return {
    objectives: lesson.objectives.filter(o => o.sceneIds.some(id => scope.includes(id)))
      .map(o => ({...o, sceneIds: o.sceneIds.filter(id => scope.includes(id))})),
    invariants: lesson.invariants.filter(i => ids.has(i.component)),
  };
}

export function validateLessonPlan(project) {
  try {
    const lesson = lessonSettings(project);
    return {status: 'succeeded', artifacts: [], checks: [{
      name: 'lesson-plan', passed: true, evidence: JSON.stringify(lesson),
    }]};
  } catch (error) {
    return {status: 'failed', artifacts: [], checks: [], error: {
      code: 'INVALID_LESSON_PLAN', detail: error.message,
    }};
  }
}
