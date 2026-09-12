import '@testing-library/jest-dom/vitest';

import { afterEach } from 'vitest';

afterEach(() => {
  // Decisions persist to localStorage by design, so without this a test that accepts a
  // field leaks that decision into the next test and the failure looks like a reducer bug.
  localStorage.clear();
});

// jsdom implements neither of these. Stubbed rather than mocked away, so a component
// calling them is exercised rather than skipped.
Element.prototype.scrollIntoView = () => {};
if (!('createObjectURL' in URL)) {
  Object.assign(URL, { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} });
}
