import React from 'react';
import { createRoot } from 'react-dom/client';
import { apply } from '../../src/client/index.js';

// Exercise the shipped plugin entry with the two browser services it consumes.
const effects: (() => void)[] = [];
const ctx = {
  uiWorkspace: { openSession: (id: string) => { (window as any).openedSession = id; } },
  slots: {
    inject: (_name: string, fn: () => () => void) => fn(),
    register: (options: { inject: () => object }, Component: React.ComponentType<any>) => {
      const root = createRoot(document.getElementById('root')!); root.render(<Component {...options.inject()} />);
      return () => root.unmount();
    },
  },
  effect: (fn: () => () => void) => { effects.push(fn()); },
};
apply(ctx as any);
window.addEventListener('pagehide', () => effects.reverse().forEach(fn => fn()));
