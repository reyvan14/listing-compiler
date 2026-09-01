import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { StationApp } from './station/StationApp';
import 'tldraw/tldraw.css';
import './pipeline/index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StationApp />
  </StrictMode>,
);
