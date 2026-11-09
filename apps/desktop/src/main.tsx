import { Component, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('[planner:render]', error, info.componentStack); }
  render() {
    if (this.state.error) return <div style={{ padding: 40, fontFamily: 'sans-serif' }} role="alert"><h1>The planner could not render</h1>
      <p>{this.state.error.message}</p><p>Saved projects remain in local storage. Reload to recover the last saved version.</p><button onClick={() => location.reload()}>Reload application</button></div>;
    return this.props.children;
  }
}
createRoot(document.getElementById('root')!).render(<ErrorBoundary><App /></ErrorBoundary>);
