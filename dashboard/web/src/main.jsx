import '../../public/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/shell.css';
import './styles/watchlist.css';
import './styles/inspector.css';
import './styles/project.css';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { boot } from './lib/desk.js';
import { startRouter } from './lib/router.js';

createRoot(document.getElementById('root')).render(<App />);
boot().then((ok) => {
  if (ok) startRouter();
});
