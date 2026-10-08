// Failure containment (review 2026-10-08, F3): a view that cannot be drawn
// (a chunk that does not download, an error while drawing) says so in its
// own place with Try again and Reload, and the shell around it (navigation,
// the list) keeps working. Nothing reloads by itself, so there is no reload
// loop, and nothing is sent or saved by recovering.
import { Component, lazy } from 'react';

export const isChunkError = (err) => /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|Failed to fetch|Load failed/i.test(String((err && (err.message || err)) || ''));

// A dynamic import that can be asked again. Browsers keep a failed module
// fetch for the page's life, so after a failure the next attempt asks for
// the same file under a fresh query (a new request, the same code).
export function retryingImport(load) {
  let failed = null;
  let n = 0;
  return () => {
    const go = failed ? import(/* @vite-ignore */ `${failed}?retry=${Date.now().toString(36)}${(n += 1)}`) : load();
    return go.catch((err) => {
      const m = String((err && err.message) || '').match(/(https?:\/\/[^\s'"]+?\.(?:js|jsx|mjs))(?:\?[^\s'"]*)?/);
      if (m) failed = m[1];
      throw err;
    });
  };
}

// React.lazy keeps a failed import for good; this one asks again on retry().
export function retryableLazy(load) {
  const get = retryingImport(load);
  let Lazy = lazy(get);
  function View(props) {
    return <Lazy {...props} />;
  }
  View.retry = () => { Lazy = lazy(get); };
  return View;
}

export class Boundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.retry = this.retry.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    console.error(error);
  }

  componentDidUpdate(prev) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  retry() {
    if (this.props.onRetry) this.props.onRetry();
    this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return this.props.fallback(this.state.error, this.retry);
  }
}

export function ViewError({ error, retry, what = 'This page', compact = false, children = null }) {
  const chunk = isChunkError(error);
  const why = chunk
    ? 'Part of the desk could not be downloaded: the connection dropped, or the desk was updated since this page was opened (Reload gets the new version).'
    : `Something went wrong while drawing it: ${(error && error.message) || String(error)}.`;
  return (
    <div className={`view-error${compact ? ' is-compact' : ''}`} role="alert">
      <p className="ve-title">{`${what} could not be shown`}</p>
      <p className="ve-why">{why}</p>
      {compact ? null : <p className="faint">Your records are unchanged; nothing was saved or sent.</p>}
      <div className="ve-actions">
        <button type="button" className="btn btn-sm btn-primary" data-key="view-retry" onClick={retry}>Try again</button>
        <button type="button" className="btn btn-sm" data-key="view-reload" onClick={() => location.reload()}>Reload the page</button>
        {children}
      </div>
    </div>
  );
}
