import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css'; // added

createRoot(document.getElementById('root')).render(<App />);
// register SW (optional in dev; required on production over https or localhost)
if ('serviceWorker' in navigator) {
  // For development you can register as well; in production you should register unconditionally.
  navigator.serviceWorker.register('/sw.js').catch(e => console.warn('SW register failed', e));
}