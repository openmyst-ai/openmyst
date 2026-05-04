import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { installRendererErrorReporter } from './utils/errorReporter';
import './styles.css';
import 'katex/dist/katex.min.css';
import 'markdown-it-texmath/css/texmath.css';

installRendererErrorReporter();

// Tag the document with the OS platform so CSS can apply darwin-only
// rules — most importantly the titlebar's left clearance for macOS
// traffic-light buttons. `mystPlatform` is exposed via the preload.
const platform = (window as unknown as { mystPlatform?: string }).mystPlatform;
if (typeof platform === 'string') {
  document.documentElement.dataset.platform = platform;
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
