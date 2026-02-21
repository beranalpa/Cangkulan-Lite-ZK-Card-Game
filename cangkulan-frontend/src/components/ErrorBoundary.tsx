import { Component, type ErrorInfo, type ReactNode } from 'react';
import { log } from '@/utils/logger';

interface Props { children: ReactNode; }
interface State { hasError: boolean; error: Error | null; }

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    log.error('[ErrorBoundary] Uncaught error:', error, info.componentStack);
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  private handleReload = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-[60vh] flex items-center justify-center p-6">
          <div
            className="max-w-md w-full rounded-2xl shadow-lg p-8 text-center space-y-4 border-2"
            style={{
              background: 'var(--color-surface)',
              borderColor: 'color-mix(in srgb, var(--color-accent) 30%, transparent)',
            }}
          >
            <div className="text-5xl">💥</div>
            <h2 className="text-xl font-bold" style={{ color: '#ef4444' }}>Something went wrong</h2>
            <p className="text-sm" style={{ color: 'var(--color-ink-muted)' }}>
              An unexpected error occurred. Your game state is safe on-chain.
            </p>
            {this.state.error && (
              <pre
                className="text-xs text-left rounded-lg p-3 overflow-auto max-h-32 font-mono"
                style={{
                  background: 'color-mix(in srgb, #ef4444 10%, var(--color-bg))',
                  border: '1px solid color-mix(in srgb, #ef4444 25%, transparent)',
                  color: 'var(--color-ink)',
                }}
              >
                {this.state.error.message}
              </pre>
            )}
            <div className="flex gap-3 justify-center">
              <button
                onClick={this.handleRetry}
                className="px-5 py-2.5 rounded-xl font-bold text-sm transition-all shadow-md"
                style={{
                  background: 'var(--color-accent)',
                  color: '#0f0f0f',
                }}
              >
                ↻ Retry
              </button>
              <button
                onClick={this.handleReload}
                className="px-5 py-2.5 rounded-xl font-bold text-sm transition-all shadow-md"
                style={{
                  background: 'color-mix(in srgb, #ef4444 80%, transparent)',
                  color: '#fff',
                }}
              >
                ⟳ Reload App
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
