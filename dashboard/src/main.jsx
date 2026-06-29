import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.jsx';

// Apply persisted theme before render to avoid a flash of the wrong theme.
if (localStorage.getItem('agently-theme') === 'light') {
  document.documentElement.dataset.theme = 'light';
} else {
  document.documentElement.dataset.theme = 'dark';
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
