/**
 * The reducer in `review.ts`, plus the two things that make it a React concern:
 * restoring last session's decisions once, and writing them back on every change.
 *
 * A hook rather than an effect inside the component, because the ordering rule here is
 * easy to get wrong and only has to be got right once. The restore has to happen before
 * the first save, or the save writes `{}` over the stored decisions on mount and the
 * reviewer's previous session is gone -- silently, since an empty screen is exactly what
 * a first visit looks like. `restored` is what enforces that: nothing is written until
 * the read has happened.
 */

import { useEffect, useReducer, useRef } from 'react';

import { type Action, type Decisions, reduce, restore, save } from '../review';

export function useDecisions(): [Decisions, React.Dispatch<Action>] {
  const [decisions, dispatch] = useReducer(reduce, {} as Decisions);
  const restored = useRef(false);

  useEffect(() => {
    dispatch({ type: 'restore', decisions: restore() });
    restored.current = true;
  }, []);

  useEffect(() => {
    if (!restored.current) return;
    save(decisions);
  }, [decisions]);

  return [decisions, dispatch];
}
