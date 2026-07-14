// Shared mutable app state (Task 9.1). A single object mutated in place —
// ES-module import bindings are read-only for importers, so `state.reps = x`
// works everywhere while `import { reps }` + reassignment would not.
export const state = {
  reps: [],
  methodology: null,
  currentId: null,
  currentRep: null,
  currentEvidence: [],
};
